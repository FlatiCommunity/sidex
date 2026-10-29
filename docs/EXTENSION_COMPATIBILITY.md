# Extension compatibility

SideX uses a VS Code-derived workbench and its own native extension host. Installing an extension successfully verifies its package and records its contributions; it does not establish compatibility with every VS Code API the extension uses.

## Execution and contributions

In the Tauri application, local extensions are assigned to the native Node host. The host loads `package.json.main`, falling back to `package.json.browser` when `main` is absent. A browser-only extension therefore still needs an entry point that can run in this host; the fallback does not provide browser globals. The ordinary browser preview retains the web extension worker path and cannot execute native Node extensions.

CommonJS and ES module entry points are supported. ES module resolution of `vscode` requires a Node runtime with `node:module.register`; use the bundled runtime, or verify that API when supplying a system runtime. Native binaries must match the host's OS, architecture and Node ABI. A VS Code/Electron binary is not automatically compatible with SideX's Node runtime.

The workbench registers local extension contributions, including commands, views, themes, icons and grammars, without substituting `main` for the manifest's `browser` entry. Installed resources are read from their actual local directory. Native host activation waits for dependencies, detects dependency cycles, and awaits asynchronous `activate()` calls before resolving activation requests. Deactivation calls the module's `deactivate()` and disposes context subscriptions.

The native gallery path honors administrator installation refusals and no longer substitutes the requested release when a compatible version cannot be found. Native target-platform selection and VSIX identity/platform checks remain separate. A matching `engines.vscode` range still does not prove that every API used by an extension is implemented.

The `vscode` API is a compatibility shim, not the complete upstream extension host. Some APIs remain partial or inert, including the native shim's environment-variable collection. Native `context.secrets` is currently an in-memory map, so extensions that require durable secret storage need additional implementation. The native host is shared within the application; independent workspace and locale isolation across multiple windows is not yet equivalent to VS Code.

## Installation and removal

Both gallery downloads and **Extensions: Install from VSIX…** use the native installer. Gallery installation awaits the disk transaction before updating the profile registry or announcing success. Hot loading then uses that installed directory, without a second download on the normal installation path.

The installer validates manifest identity and archive paths. It rejects path traversal, duplicate entries, symlink entries, unsafe identifiers and a declared target platform that differs from the native build. Missing, empty or `universal` target-platform declarations remain valid. Limits are 100,000 archive entries, 256 MiB per extracted file and 1 GiB of extracted data; gallery downloads are capped at 512 MiB. These checks validate package structure and platform declarations, not executable code behavior.

Updates use a sibling staging directory and replacement with rollback, retaining the previous installation if replacement fails. Uninstall removes the profile entry and removes the installation directory when no other profile owns an installation. Application-scoped entries inherited from the default profile do not count as additional installations.

## State and language

`context.globalState` and `context.workspaceState` persist outside the extension installation directory. Workspace storage uses a hash of the workspace-folder list. Writes are serialized and replaced atomically; `undefined` removes a value and `null` remains a stored value. Legacy storage directories are migrated. A malformed state file is backed up before replacement; failure to preserve that backup causes updates to fail instead of overwriting it.

The selected UI locale reaches `vscode.env.language` and the extension's `l10n` bundle lookup. The host reads the manifest's `l10n` directory, applies locale fallback, handles positional arguments and object-form messages, and falls back to the source message when a translation is absent. Workbench labels, manifest `package.nls` resources and an extension's own `l10n` bundle are separate translation surfaces.

## Remote and third-party limits

SideX's **Connect to SSH Host…** command provides native SFTP workspaces and remote terminals. It does not implement Microsoft's Remote-SSH remote-agent protocol or run the extension host on the SSH server. The same distinction applies to native WSL filesystem workspaces. Remote URIs are not passed to the local host as local workspace paths. Extensions that require a remote extension host need further work.

Claude Code, Copilot, Unity tooling and other complex third-party extensions are not certified by the host fixtures. Their authentication providers, proprietary services, native dependencies and additional API requirements must be exercised with the actual extension version. Removing an extension blacklist and fixing activation does not establish this compatibility.

## Checking a specific extension

1. Record the SideX build, OS/architecture, extension version, selected gallery and package target platform. Install that version and verify its installed location and contributions.
2. Open a small disposable project. Trigger each required command, view and language feature; inspect application logs and the developer console for activation or bridge errors. Repeat after restarting SideX.
3. Test state persistence, update and uninstall, including a second profile if the extension is application-scoped. For native dependencies, exercise the executable or language server rather than checking only that its files exist.
4. For remote use, verify the feature against a native SSH/WSL URI explicitly. A successful local test does not cover remote execution.

Focused automated checks from the repository root:

```sh
node --test scripts/tests/extension-host.test.mjs scripts/tests/native-extensions.test.mjs scripts/tests/native-extension-policy.test.mjs scripts/tests/marketplace.test.mjs scripts/tests/request-compat.test.mjs scripts/tests/ssh-workspace.test.mjs
cargo test -p sidex-extensions
cargo test -p sidex-remote --lib
bash scripts/tests/ssh-integration.sh
```

The SSH integration fixture requires OpenSSH client/server, Python 3 and Cargo. It creates disposable local keys, a server and an agent, then cleans them up; it does not change personal SSH configuration. Restricted root containers can select an existing ordinary account with `SIDEX_SSH_FIXTURE_USER`. The live test covers host-key trust, SFTP binary data and replacement, authentication, forwarding, terminal resizing and remote exit status. These checks cover the tested host contracts, not every third-party extension.

Implementation references: [native installer](../crates/sidex-extensions/src/vsix.rs), [native host](../src-tauri/extension-host/host.cjs), [profile installation service](../src/vs/workbench/services/extensionManagement/common/webExtensionManagementService.ts), [workbench bridge](../src/vs/workbench/contrib/extensions/browser/tauriExtensionHost.contribution.ts).
