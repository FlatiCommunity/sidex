# SideX

**A VS Code workbench port running in Tauri, maintained in this fork.**

This repository is [naulbi-dump-projects/sidex](https://github.com/naulbi-dump-projects/sidex), a fork of [Sidenai/sidex](https://github.com/Sidenai/sidex). It keeps the existing editor and AI features while repairing localization, extension installation, native integration, and release tooling. The [upstream audit](docs/UPSTREAM_AUDIT.md) records a disposition for every issue and pull request reviewed, including remaining platform checks and changes deliberately not adopted.

![SideX workbench](docs/assets/preview.jpg)

## Current functionality

| Area | Implementation in this fork |
| --- | --- |
| Editor | Monaco editing, file explorer, search, syntax highlighting, encoding/BOM handling, autosave, and settings. |
| Languages | English, Russian, Simplified Chinese, and Traditional Chinese work offline. Additional VS Code language packs are discovered from their actual installed contributions. |
| Themes and grammars | 60 pinned declarative VS Code extensions provide 81 grammars and 19 official color themes, including Quiet Light and the classic themes. The fork's Atom One Dark theme is retained. |
| Extensions | Open VSX and VSIX installation, platform selection, atomic updates, profile-aware removal, translated contributions, and a native Node extension host with asynchronous activation. Compatibility is documented per API surface. |
| Terminal | Native PTY, shell environment inheritance, UTF-8 streaming, resize, flow control, and exit events. |
| Git | Status, stage/unstage, commit, branches, fetch/pull/push, and separate HEAD/index/worktree comparisons. Worktrees, partially staged files, renames, and unborn branches retain their identities. |
| Markdown | Preview beside the editor, syntax highlighting, theme updates, bidirectional source scrolling, preview locking, and reveal-source commands. Rendered content is sanitized. |
| Remote files | Native SSH/SFTP workspaces and terminals; WSL Linux files and terminals on Windows. Local-only Git, indexing, debugger, and AI file operations are guarded in remote workspaces. |
| Desktop | Multiple windows, startup paths, file associations, native menu routing, portable data directories, and platform-specific window decorations. |
| AI | The existing local Go agent server and model settings remain available. The server is optional and has a separate build step. |

SideX implements a subset of the VS Code extension host. An extension's successful installation does not establish compatibility with every API it uses. See [Extension compatibility](docs/EXTENSION_COMPATIBILITY.md) for the actual contract, shared-host limitations, and the distinction between native SSH/WSL files and a full remote extension host.

## Development

Use **Node.js 24**, npm, Git, and a current stable Rust toolchain satisfying the project's **Rust 1.91** minimum. Keep `package-lock.json` and `Cargo.lock`; `npm ci` installs the locked dependency versions.

For Linux, install GTK 3, WebKitGTK 4.1, OpenSSL, Ayatana AppIndicator, librsvg, and the usual native build tools. On Debian/Ubuntu:

```sh
sudo apt-get install build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

Windows development requires the MSVC C++ build tools, Windows SDK, WebView2, and NASM for dependencies that use assembly. macOS development requires Xcode command-line tools. The application configuration targets macOS 12 or later; the development Node.js 24 toolchain itself requires a newer macOS than the packaged Node.js 22 runtime. See [packaging](docs/PACKAGING.md) for this distinction.

```sh
git clone https://github.com/naulbi-dump-projects/sidex.git
cd sidex
npm ci
npm run tauri -- dev
```

For the browser workbench alone, run `npm run dev`. Native filesystem, PTY, SSH, and extension-host services require the Tauri application.

The normal setup and frontend build use checked-in, licensed VS Code assets and language catalogs. They do not copy extensions from a personal VS Code installation or download a moving VS Code branch. Refreshing assets is an explicit maintenance operation, `npm run assets:sync`.

## Build and validate

```sh
npm run check
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
npm run build
npx playwright install chromium
npm run test:browser
cargo check -p sidex --lib --locked
```

The frontend build uses a 6144 MiB Node heap limit by default. Set `SIDEX_BUILD_HEAP_MB` to adjust this limit for the build machine. The limit is a build setting, not a measurement of application memory use.

For a desktop bundle, stage the runtime for the desired target before running the Tauri build. For example, on Linux x86-64:

```sh
npm run stage:download-runtime -- x86_64-unknown-linux-gnu
npm run tauri -- build --target x86_64-unknown-linux-gnu
```

Runtime staging verifies the published Node.js SHA-256 checksum, checks the executable's architecture, and includes its license. Cross-target and universal macOS staging, optional AI server bundling, Nix, and package-manager manifest generation are covered in [Packaging](docs/PACKAGING.md).

The [validation record](docs/VALIDATION.md) distinguishes tests actually run from platform validation still required. Build and test workflows cover Linux, macOS, and Windows; adding the workflows does not mean their remote runs have already succeeded.

## Display language and settings

Run **Configure Display Language** from the command palette. English, Russian, Simplified Chinese, and Traditional Chinese are bundled. The chosen language is persisted and passed to native menus and the extension host. Selecting English explicitly remains effective on a system using another language.

The translation validator checks every static workbench NLS call, placeholder compatibility, built-in extension manifests, and SideX/Git interface strings. The official catalogs are pinned to the VS Code 1.110 generation, with reviewed supplemental translations. This is complete coverage of the checked-in inventory for the three translated bundled languages; third-party extensions supply their own translations. See [Localization](docs/LOCALIZATION.md) for sources and maintenance commands.

Open user settings from the command palette. The application uses its actual platform data directory, including portable mode. Settings updates preserve unrelated values, Unicode, JSONC comments, and symlinks to dotfiles; writes are atomic and failures are reported.

**Extensions: Select Extension Registry** chooses Open VSX, the optional SideX registry, or a custom HTTPS gallery. Custom asset origins can be allowed in the user-level `sidex.extensions.allowedGalleryOrigins` setting. Workspace settings cannot grant additional proxy origins.

## SSH and WSL workspaces

Use **Connect to SSH Host…** to choose an entry from `~/.ssh/config` or enter a host, authenticate, verify its host fingerprint, and select a remote directory. The native backend supplies binary-safe SFTP operations and a remote PTY, including resize and exit handling. A changed known host key is rejected. Passwords are held for the connection; they are not written into saved target configuration.

Use **Connect to WSL…** on Windows to choose an installed distribution and a Linux directory. The distribution needs Python 3 for the filesystem helper. The filesystem provider keeps Linux URI identity, checks destructive root operations, and uses the selected distribution for the terminal.

These connections provide remote files and terminals. A remote Node extension host, remote language servers/debuggers, remote Git UI, and remote AI execution are not yet implemented. Local operations are blocked where interpreting a remote path as a local path could affect the wrong files. Microsoft Remote-SSH's remote-agent protocol is not implemented by this native connection mode. ProxyJump is supported in the lower transport API, but the current connection picker requires a directly reachable target or an existing tunnel.

## CLI and portable mode

The executable accepts files, folders, and `.code-workspace` paths. On a system where the binary is on PATH:

```sh
SideX .
SideX ./src/main.ts
SideX --goto ./src/main.ts:25:3
```

The Linux desktop executable may be named `sidex`; use the name installed by the chosen package. Relative paths resolve against the launch directory. New windows receive their own workspace URL and do not replay the process's initial arguments.

Set `SIDEX_PORTABLE` to a data directory to keep settings, extensions, storage, and webview data together. An adjacent `data` directory enables portable mode on Windows/Linux; on macOS, use `sidex-portable-data` beside the `.app`, outside the signed application bundle. Back up that data directory before moving or replacing an installation.

## Optional AI agent server

The existing Go server in `sidexai/sidex-server` runs as a child process supervised by the desktop application. Without a server binary, the editor still starts and the chat panel reports the unavailable connection.

Building the server requires **Go 1.26 or later** and a C compiler for its SQLite/FTS5 dependency:

```sh
npm run server:build
```

A source checkout finds the built binary automatically; the build script uses the required `.exe` suffix on Windows. For a distributable, use `scripts/stage-runtime.mjs --build-server` on a native target or supply a matching prebuilt server through `--server`; see [Packaging](docs/PACKAGING.md). The application prefers its bundled server, then tries `SIDEX_SERVER_BIN`, PATH, and source-checkout locations.

Add the model provider and model ID in **Settings → Models**. Provider configuration, environment variables, optional CLI credentials, and local model servers are handled by the existing provider integration; see [`.env.example`](.env.example) and [`providers.rs`](src-tauri/src/commands/providers.rs). **Shift+Enter** inserts a newline in chat. IME confirmation does not submit a message.

The agent can execute commands and edit files. Its default loopback binding is retained; exposing an unauthenticated command server to a network is not part of normal setup. Remote workspaces currently block local agent file operations.

## Platform troubleshooting

For a Linux AppImage blank window or `EGL_BAD_PARAMETER`, first try a native `.deb`/`.rpm` package using the system WebKitGTK. SideX retains the existing WebKit DMA-BUF workaround and respects an explicit user override. A useful one-run diagnostic is:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./SideX.AppImage
```

If the session provides XWayland, trying `GDK_BACKEND=x11` can isolate a Wayland-specific failure. Neither workaround establishes that a given GPU driver or Fedora Atomic image is supported; native package/Flatpak testing on that distribution remains necessary. The distro-specific `LD_PRELOAD` workaround reported in [upstream #44](https://github.com/Sidenai/sidex/issues/44) is not enabled globally.

An unsigned macOS build still requires the operating system's normal local approval. Release signing/notarization needs the fork owner's certificates and credentials; source changes cannot supply them. Windows requires a working WebView2 runtime. Build logs and platform information are needed to diagnose an OS-level crash that occurs before JavaScript starts.

## Architecture and performance

The TypeScript workbench runs in the OS webview. Rust/Tauri provides files, windows, Git, terminals, storage, and process supervision. Node.js runs compatible native extensions; the optional Go child process provides the AI service. See [ARCHITECTURE.md](ARCHITECTURE.md) for the broader layout.

Memory measurements must include the application, webview processes, extension host, terminals, and optional AI server under the same workload. The former “16.4 MB vs 797.8 MB” screenshot is not a reproducible process-tree comparison and has been removed from this README. This fork makes no fixed memory-savings claim or unmeasured idle-memory promise.

## Contributing and provenance

Report fork-specific problems in [this repository's issues](https://github.com/naulbi-dump-projects/sidex/issues). For upstream history, see the [73-issue audit](docs/UPSTREAM_AUDIT.md) and [59-PR disposition table](docs/UPSTREAM_PULL_REQUESTS.md). Changes are organized as focused commits, preserving the fork's earlier features and attributing adapted upstream work.

The repository retains its [MIT license](LICENSE). Vendored VS Code assets and translation catalogs retain their Microsoft licenses and pinned source revisions. Packaging recipes retain the licenses of their upstream modules.
