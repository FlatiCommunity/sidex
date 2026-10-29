# Validation record

Date: **2026-10-29**. Validation was performed in a Linux x86-64 development container. The build toolchain used Node.js 24.22.1 and Rust 1.98.1; the packaged extension-host runtime is Node.js 22.23.4. This record distinguishes executed tests from native OS acceptance work that still needs another environment.

## Executed checks

| Check | Result and scope |
| --- | --- |
| TypeScript | Full `tsc --noEmit` passes against the integrated frontend. |
| JavaScript regression suites | **90 cases pass** using `node --test --test-isolation=none --test-concurrency=1 scripts/tests/*.test.mjs`. These exercise the actual helpers/actions with isolated VM or mocked service boundaries where appropriate. |
| Bundled Node runtime | Official Node.js 22.23.4 distribution downloaded, verified against its published SHA-256, inspected for target architecture, staged with its license, and executed. All **12 extension-host behavior tests** pass on that actual packaged executable. |
| Localization | Russian, Simplified Chinese, and Traditional Chinese each cover **11,638 static NLS calls / 11,040 unique keys / 804 modules**. Each includes 60 built-in extension catalogs and 141 translated manifest keys. No unapproved hardcoded SideX UI strings remain in the checked inventory. |
| Built-in assets | Every pinned grammar, theme, icon, and font path resolves offline. Classic theme token-color and inheritance checks pass. |
| Production build | `npm run build` passes after the final menu/word-wrap changes. `validate-localization.mjs --dist` verifies all 11,040 emitted entries in each translated catalog against current sources. |
| Production browser startup | English, Russian, Simplified Chinese, and Traditional Chinese start in a real Chromium browser with no page errors. The same run verifies persisted language choice, Shift+Enter multiline input, and IME confirmation without submission. |
| Markdown browser behavior | Sanitized HTML and escaped code, nonce CSP, source markers, source-to-preview and preview-to-source scrolling, and double-click reveal-source pass in Chromium. |
| Rust native library | `cargo check -p sidex --lib --locked` passes. The final native check includes the Linux portal dependency selection. |
| Strict native lint | `cargo clippy -p sidex --lib --locked -- -D warnings` passes, including the changed path dependencies. |
| Rust `sidex-settings` | **90 tests pass**, including Unicode JSONC, nested keys, comments and CRLF, atomic failure handling, external edits, permissions, normal symlinks and dangling symlinks. |
| Rust `sidex-extensions` | **110 tests pass**, including target platforms, native/universal VSIX selection, ID/path checks, archive limits, over 10,000 entries, failed-update rollback and portable paths. |
| Rust `sidex-remote` | **32 tests pass** for remote target/path/trust/transport helpers. |
| Rust `sidex-theme` | **60 tests pass**, including CSS hex colors and malformed Unicode handling. |
| Rust `sidex-git` | **28 tests pass** for status, raw original bytes, worktree/index identity and related repository behavior. |
| Rust `sidex-text` | **295 tests pass**; the earlier fork's encoding/BOM behavior remains covered. |
| Small native unit harnesses | CLI parser **4**, UTF-8 stream handling **4**, and HTTP proxy origin/redirect policy **4** tests pass. The proxy harness compiles the unchanged helper functions and test module with the actual reqwest/serde_json libraries; the async HTTP command layer is checked by the full native compile. |
| WSL Python helper | **7 tests pass** for filesystem operations, binary handling and destructive root guards. Native distro decoding/root aliases and frontend routing have additional Rust/JS checks. No real WSL distribution was available. |
| Real SSH integration | `scripts/tests/ssh-integration.sh` passes against an isolated local OpenSSH server with real keys and ssh-agent, as described below. |
| Packaging helpers | Runtime headers/PATH/literal arguments, archive extraction, real artifact hashes and manifest generation pass. Nix expressions parse successfully. |
| Formatting and workflow definitions | Prettier and workspace rustfmt checks pass; actionlint 1.7.7 validates all eight workflows. All 47 tracked TOML/lock files parse. Taplo 0.9.0 from SHA-512-verified `@taplo/cli@0.7.0` passes all 46 TOML files; this is distinct from the newer native Taplo 0.10.0 release used by CI. |
| Release helpers | Version normalization/mismatch, artifact collection, signing credential validation, and draft/tag policy pass. A real temporary signature produced by Tauri CLI 2.10.1 is verified cryptographically by the release helper. Release YAML passes actionlint 1.7.7. |

The JavaScript total includes extension-host activation/state/ESM/CJS, install policy and profile lifecycle, marketplace metadata, language packs, Git URI identity, Markdown markers, old-WebKit compatibility helpers, worker URLs, remote workspace guards, native window/menu/zoom actions, word-wrap behavior and workspace-file selection. A final native-terminal regression covers a selected second SSH host, a selected WSL distribution, mixed local/remote roots and default-root fallback. Native install-policy tests verify that a denied policy or missing compatible version cannot become a successful native installation.

The restored word-wrap regression checks execute the action against normal and diff editors, including the inline-original exclusion. Window tests cover actual command handlers and native menu mapping, stored zoom bounds, startup command waiting, and `.code-workspace` picker options. They are service-level tests, not a claim that a native desktop was clicked on each operating system.

## SSH integration details

The fixture starts its own OpenSSH server and agent with temporary keys and workspace files. It checks unknown-host approval, a wrong supplied fingerprint, rejection of changed known-host keys, public-key and ssh-agent authentication, and direct TCP forwarding. SFTP transfers a 1 MiB binary payload and exercises complex filenames, atomic overwrite, permissions, symlinks, rename, errors and root guards. A real remote command preserves stderr and its exit code; the PTY accepts a `43 × 101` resize and reports exit code `42`.

The fixture removes its processes, agent, keys and files afterwards. It tests SideX's native SSH transport and filesystem; it does not test Microsoft Remote-SSH's proprietary remote-agent workflow.

## Reproduce the frontend checks

```sh
npm ci
npm run check
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
npm run build
node scripts/validate-localization.mjs --dist
npx playwright install chromium
npm run test:browser
```

`SIDEX_TEST_BROWSER` can point to an existing Chromium executable. Browser tests run against a temporary local Vite preview server. The production localization check compares the emitted index with the current source inventory, so an older bundle with fewer translated entries cannot pass.

## Reproduce the native checks

Install the platform's Tauri dependencies, then run:

```sh
cargo check -p sidex --lib --locked
cargo test -p sidex-settings -p sidex-extensions -p sidex-remote -p sidex-theme -p sidex-git -p sidex-text --locked
python3 -m unittest discover -s scripts/tests -p 'test_*.py'
bash scripts/tests/ssh-integration.sh
```

The SSH fixture needs OpenSSH server/client tools and access to an appropriate local test account. It is not a reason to change an existing SSH server configuration. The source tree contains the assertions used by the small CLI/stream/proxy unit harnesses as Rust tests; a full `cargo test -p sidex --lib` run is appropriate on a machine with room for the large Tauri test binary.

## Explicit limits

The exact GitHub CI variant `cargo clippy --all-targets --all-features --locked -- -D warnings` was not run locally because of disk pressure after the native build. The scoped `--lib` Clippy command above passed. Its broader cfg(test)/binary/custom-protocol coverage remains a separate GitHub Actions gate.

No native Windows or macOS GUI was available. Startup, title bars, Finder/file associations, installer elevation, Windows WebView2 behavior, macOS signing/notarization and old WKWebView versions still need their platform acceptance runs. The WebKit compatibility tests mask modern APIs in isolated contexts; Chromium is not a substitute for WKWebView.

The Linux native library compiles, but GTK/WebKit GUI startup was not exercised under KDE, GNOME, Wayland, Fedora Atomic or the reported GPU drivers. The KDE portal change selects the desktop portal backend; it has not been clicked in a live KDE session. Nix was parsed, not fully built, and Flatpak was not installed/launched. Package-manager listings were not submitted. The optional Go 1.26 AI server was not built in this container.

No signed installer or public release was created. Release-helper cryptographic tests use temporary local keys, not distribution identities. No blanket claim is made for Claude Code, Unity, Copilot, all VS Code extensions, remote language servers/debuggers, or additional third-party translations. Their remaining compatibility boundaries are documented in [Extension compatibility](EXTENSION_COMPATIBILITY.md) and the [upstream audit](UPSTREAM_AUDIT.md).

The source and emitted production catalogs, formatted source, and integrated frontend checks were verified after the final relevant changes. Remote Git push verification is reported with delivery. GitHub Actions results are separate remote runs and must not be inferred solely from the presence of workflow files.
