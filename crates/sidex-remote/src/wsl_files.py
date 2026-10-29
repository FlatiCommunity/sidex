"""SideX's fixed WSL filesystem protocol. Requests arrive as JSON on stdin.

No part of a filename is interpolated into executable Python or a shell command.
Python runs as the selected distribution's normal user, preserving Linux file
permissions, symlinks, case sensitivity and filenames that Windows cannot use.
"""

import errno
import fnmatch
import json
import os
import shutil
import stat
import sys
import tempfile

MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_WATCH_ENTRIES = 10000


def path_arg(request, key="path"):
    value = request.get(key)
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        raise ValueError("An absolute Linux path is required")
    return value


def file_stat(path):
    link = os.lstat(path)
    symbolic = stat.S_ISLNK(link.st_mode)
    try:
        target = os.stat(path) if symbolic else link
    except FileNotFoundError:
        target = link
    kind = 2 if stat.S_ISDIR(target.st_mode) else 1
    if symbolic:
        kind |= 64
    return {
        "type": kind,
        "size": target.st_size,
        "mtime": target.st_mtime_ns // 1000000,
        "ctime": target.st_ctime_ns // 1000000,
        "readonly": not os.access(path, os.W_OK),
    }


def write_file(request, path):
    data = bytes(request["data"])
    if len(data) > MAX_FILE_BYTES:
        raise OSError(errno.EFBIG, "File exceeds the WSL transfer limit")
    exists = os.path.lexists(path)
    if exists and not request.get("overwrite", True):
        raise FileExistsError(errno.EEXIST, "File already exists", path)
    if not exists and not request.get("create", True):
        raise FileNotFoundError(errno.ENOENT, "File does not exist", path)
    # Preserve a symlink rather than replacing the link when saving its target.
    target = os.path.realpath(path) if os.path.islink(path) else path
    if os.path.isdir(target):
        raise IsADirectoryError(errno.EISDIR, "Cannot write a directory", path)
    if not request.get("overwrite", True):
        with open(target, "xb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        return None
    # Write alongside the target and replace only after the full content is on
    # disk. A failing write leaves the previous file intact.
    mask = os.umask(0)
    os.umask(mask)
    mode = stat.S_IMODE(os.stat(target).st_mode) if os.path.exists(target) else 0o666 & ~mask
    descriptor, temporary = tempfile.mkstemp(prefix=".sidex-save-", dir=os.path.dirname(target))
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            if mode is not None:
                os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)
    return None


def snapshot(request, path):
    result = {}
    excludes = request.get("excludes", [])
    pending = [path]
    while pending:
        current = pending.pop()
        if current != path and any(fnmatch.fnmatch(current, pattern) for pattern in excludes):
            continue
        try:
            info = os.lstat(current)
            result[current] = [info.st_mtime_ns, info.st_size, info.st_mode, info.st_ino]
            if len(result) > MAX_WATCH_ENTRIES:
                raise OSError(errno.EFBIG, "WSL watch exceeds 10000 entries; narrow the watched folder")
            if stat.S_ISDIR(info.st_mode) and (current == path or request.get("recursive", False)):
                pending.extend(os.path.join(current, name) for name in os.listdir(current))
        except FileNotFoundError:
            continue
    return result


def handle(request):
    operation = request.get("op")
    if operation == "home":
        return os.path.expanduser("~")
    path = path_arg(request)
    if operation == "stat":
        return file_stat(path)
    if operation == "readdir":
        entries = []
        for name in os.listdir(path):
            try:
                info = file_stat(os.path.join(path, name))
            except FileNotFoundError:
                continue
            if request.get("metadata", False):
                entries.append(dict(info, name=name, path=os.path.join(path, name)))
            else:
                entries.append([name, info["type"]])
        return entries
    if operation == "read":
        with open(path, "rb") as source:
            data = source.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise OSError(errno.EFBIG, "File exceeds the WSL transfer limit")
        return list(data)
    if operation == "write":
        return write_file(request, path)
    if operation == "mkdir":
        os.makedirs(path, exist_ok=True)
        return None
    if operation == "snapshot":
        return snapshot(request, path)
    if operation in ("delete", "rename") and os.path.normpath(path) == "/":
        raise PermissionError(errno.EPERM, "Cannot remove or rename the distribution root")
    if operation == "delete":
        if os.path.isdir(path) and not os.path.islink(path):
            if request.get("recursive", False):
                shutil.rmtree(path)
            else:
                os.rmdir(path)
        else:
            os.unlink(path)
        return None
    if operation == "rename":
        target = path_arg(request, "target")
        if os.path.lexists(target) and not request.get("overwrite", False):
            raise FileExistsError(errno.EEXIST, "Rename target exists", target)
        os.replace(path, target)
        return None
    raise ValueError("Unknown filesystem operation")


def main():
    try:
        request = json.load(sys.stdin)
        response = {"ok": True, "result": handle(request)}
    except Exception as error:
        code = {
            errno.ENOENT: "FileNotFound",
            errno.EEXIST: "FileExists",
            errno.EISDIR: "FileIsADirectory",
            errno.ENOTDIR: "FileNotADirectory",
            errno.EACCES: "NoPermissions",
            errno.EPERM: "NoPermissions",
            errno.EFBIG: "FileTooLarge",
        }.get(getattr(error, "errno", None), "Unavailable")
        response = {"ok": False, "error": {"code": code, "message": str(error)}}
    json.dump(response, sys.stdout, ensure_ascii=True, separators=(",", ":"))


if __name__ == "__main__":
    main()
