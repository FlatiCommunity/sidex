#!/usr/bin/env bash
# Run the ignored Rust integration test against a disposable localhost OpenSSH
# server and SSH agent. Requires OpenSSH client/server, Python 3 and Cargo.
# The test covers real host-key verification, binary SFTP, atomic replacement,
# permissions, symlinks, exec exit status/stderr, agent auth, forwarding and PTYs.
#
# Normal use: bash scripts/tests/ssh-integration.sh
# A root container without audit capability should select an existing ordinary
# account with a login shell: SIDEX_SSH_FIXTURE_USER=vscode bash scripts/tests/ssh-integration.sh
# No personal SSH config, known_hosts, agent or HOME is changed.
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_dir=$(cd -- "$script_dir/../.." && pwd)
fixture_user=${SIDEX_SSH_FIXTURE_USER:-$(id -un)}
sshd_binary=${SIDEX_SSHD:-$(command -v sshd || true)}
if [[ -z "$sshd_binary" && -x /usr/sbin/sshd ]]; then sshd_binary=/usr/sbin/sshd; fi
if [[ -z "$sshd_binary" ]]; then
  echo 'OpenSSH server (sshd) is required for this integration test.' >&2
  exit 1
fi
for dependency in ssh-keygen ssh-agent ssh-add python3 cargo; do
  command -v "$dependency" >/dev/null || { echo "Missing test dependency: $dependency" >&2; exit 1; }
done
if [[ $(id -u) != 0 && "$fixture_user" != "$(id -un)" ]]; then
  echo 'Run as the current account or use root to select a different existing fixture user.' >&2
  exit 1
fi

fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/sidex-ssh-test.XXXXXX")
sshd_pid=''
agent_pid=''
cleanup() {
  local status=$?
  trap - EXIT
  if [[ $status != 0 && -f "$fixture_dir/sshd.log" ]]; then cat "$fixture_dir/sshd.log" >&2; fi
  if [[ -f "$fixture_dir/sshd.pid" ]]; then kill "$(cat "$fixture_dir/sshd.pid")" 2>/dev/null || true; fi
  if [[ -n "$sshd_pid" ]]; then kill "$sshd_pid" 2>/dev/null || true; wait "$sshd_pid" 2>/dev/null || true; fi
  if [[ -n "$agent_pid" ]]; then kill "$agent_pid" 2>/dev/null || true; wait "$agent_pid" 2>/dev/null || true; fi
  rm -rf -- "$fixture_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$fixture_dir/user_key"
cp "$fixture_dir/user_key.pub" "$fixture_dir/authorized_keys"
mkdir "$fixture_dir/workspace"
fixture_port=$(python3 - <<'PY'
import socket
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    print(listener.getsockname()[1])
PY
)
cat > "$fixture_dir/sshd_config" <<CONFIG
Port $fixture_port
ListenAddress 127.0.0.1
HostKey $fixture_dir/host_key
PidFile $fixture_dir/sshd.pid
AuthorizedKeysFile $fixture_dir/authorized_keys
StrictModes no
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
PermitRootLogin prohibit-password
AllowUsers $fixture_user
AllowTcpForwarding yes
Subsystem sftp internal-sftp
LogLevel ERROR
CONFIG

sshd_command=("$sshd_binary" -D -e -f "$fixture_dir/sshd_config")
if [[ $(id -u) == 0 && $(id -u "$fixture_user") != 0 ]]; then
  chown -R "$(id -u "$fixture_user"):$(id -g "$fixture_user")" "$fixture_dir"
  sshd_command=(runuser -u "$fixture_user" -- "${sshd_command[@]}")
fi
"${sshd_command[@]}" > "$fixture_dir/sshd.log" 2>&1 &
sshd_pid=$!
ssh-agent -D -a "$fixture_dir/agent.sock" > "$fixture_dir/agent.log" 2>&1 &
agent_pid=$!
python3 - "$fixture_port" "$fixture_dir/agent.sock" <<'PY'
import os, socket, sys, time
port = int(sys.argv[1])
for attempt in range(100):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=.1):
            if os.path.exists(sys.argv[2]): break
    except OSError: pass
    time.sleep(.05)
else: raise SystemExit('The temporary SSH server or agent did not start; see sshd.log above.')
PY
export SSH_AUTH_SOCK="$fixture_dir/agent.sock"
ssh-add "$fixture_dir/user_key" >/dev/null 2>&1
export SIDEX_TEST_SSH_HOST=127.0.0.1
export SIDEX_TEST_SSH_PORT="$fixture_port"
export SIDEX_TEST_SSH_USER="$fixture_user"
export SIDEX_TEST_SSH_KEY="$fixture_dir/user_key"
export SIDEX_TEST_SSH_ROOT="$fixture_dir/workspace"
cd "$repo_dir"
cargo test -p sidex-remote --test ssh_live -- --ignored --nocapture
