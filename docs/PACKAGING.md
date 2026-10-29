# Development and release packaging

## Native development

Use Node.js 24 and the checked-in `package-lock.json`:

```sh
npm ci
npm run tauri -- dev
```

The Tauri launcher is a JavaScript wrapper that preserves arguments and native PATH syntax on Windows, macOS, and Linux. Its macOS-only `xattr` shim does not change PATH on other platforms. Paths containing spaces and literal shell metacharacters are passed directly to the CLI.

Bun can be used as a task runner with the same installed dependencies, for example `bun run build`. The canonical dependency lock and the extension-host runtime remain Node.js-based. The full Bun runtime migration proposed upstream is not applied: VS Code extensions and their Node APIs require the Node compatibility contract. [Bun's compatibility documentation](https://bun.sh/docs/runtime/nodejs-compat) lists remaining differences in module loading, IPC, and worker APIs.

## Nix and NixOS

The flake exposes Linux packages and development shells for x86-64 and ARM64:

```sh
nix develop
nix build
nix run
```

`flake.lock` pins nixpkgs. The package uses the workspace's root `Cargo.lock` and `importNpmLock`, so dependency integrity comes from the project's current lock files. It does not reuse the outdated Cargo/npm hashes from the original upstream Nix pull request. The official `cargo-tauri.hook` builds the application, and its GTK/WebKit wrapper includes Node.js, Git, SSH, and Bash in PATH. All checked-in built-in extensions and language catalogs participate in the frontend build.

Nix supplies Node through its store closure, so runtime staging is unnecessary for this package. A local AI server can be built separately inside the development shell with `npm run server:build`, or supplied through `SIDEX_SERVER_BIN`; it is not part of the default Nix derivation.

The Nix expressions have been parsed with Nix 2.18. A complete derivation build and graphical launch still require validation on a Nix host; the development container does not provide a writable native `/nix` store.

## Include the extension-host runtime in installers

A desktop installation should not require the user to install Node separately. To stage a custom runtime before building a distributable, supply its complete license:

```sh
node scripts/stage-runtime.mjs --node-license /path/to/node-distribution/LICENSE
npm run tauri -- build
```

The helper finds the LICENSE automatically when the executable is inside a complete Node distribution. Direct staging defaults to the developer's current Node executable; its own operating-system requirements still apply. Official release installers use Node.js 22.23.4, pinned in `scripts/runtime-versions.json`, which remains compatible with SideX's macOS 12 minimum. The Node.js 24 build toolchain is separate from this packaged runtime. The release workflow downloads the matching official distribution, verifies its published SHA-256 checksum, and stages it:

```sh
node scripts/download-runtime.mjs x86_64-unknown-linux-gnu
node scripts/download-runtime.mjs aarch64-apple-darwin
node scripts/download-runtime.mjs x86_64-pc-windows-msvc
```

The target defaults to `TAURI_ENV_TARGET_TRIPLE` when set. For a manually supplied cross-target runtime, pass `--target`, `--node`, and `--node-license`. ELF, PE, and Mach-O headers are checked before any existing staged runtime is replaced. Universal macOS installers can use a universal Node executable, or both `--node-x64` and `--node-arm64`. Tauri bundles the runtime files, and the application selects the matching architecture at startup.

The generated `src-tauri/runtime/manifest.json` records executable paths, architectures, and SHA-256 digests. Binaries and generated manifests are ignored by Git. Node's full LICENSE accompanies the executable.

To include the local AI server, add `--server /path/to/sidex-server` to the staging command. A native build can use `--build-server`, which runs the real Go build with `CGO_ENABLED=1` and the required `fts5` build tag. This requires Go 1.26 or later and a C compiler. Cross-target server binaries must be built with the appropriate C toolchain and supplied with `--server`; the helper rejects mismatched executable architectures. Packaged resources are searched before the application's existing environment/PATH fallbacks.

## Release drafts for this fork

The release workflow runs on a `v*` tag or an explicit manual dispatch. The requested version accepts one optional `v` prefix and must match both `package.json` and `src-tauri/tauri.conf.json` exactly. Invalid SemVer, `vv` prefixes, and mismatched versions fail before the build matrix starts.

The six targets are macOS ARM64, x64, and universal; Windows x64 and ARM64; and Linux x64. Each job installs the Node.js 24 build toolchain, stages the pinned Node.js 22 runtime, and calls the Tauri wrapper once. Tauri's existing `beforeBuildCommand` builds the frontend. There is no additional standalone frontend build. The workflow uses the current GitHub repository and does not require the original project's Cloudflare R2 account or signing services.

Builds are unsigned by default. The following optional credentials enable signing:

| Purpose | Configuration |
| --- | --- |
| Signed updater artifacts | `TAURI_SIGNING_PRIVATE_KEY` repository secret **and** `TAURI_SIGNING_PUBLIC_KEY` repository variable or secret, containing the key strings generated for this fork by `tauri signer generate` |
| Encrypted updater private key | Optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret |
| Apple certificate signing | `APPLE_CERTIFICATE` (base64 P12) and `APPLE_CERTIFICATE_PASSWORD` secrets; optional `APPLE_SIGNING_IDENTITY` |
| Apple notarization | Apple certificate signing plus all of `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`; `APPLE_ID_PASSWORD` is accepted as a legacy password-secret alias |

Empty optional variables are removed before launching Tauri. Incomplete credential groups cause a clear error. Tauri imports an Apple certificate only when one is configured. The release helper first signs a temporary challenge and verifies it against the configured updater public key, then verifies every produced updater signature using Ed25519 and BLAKE2b before collecting assets. This turns Tauri's key-mismatch warning into a failed release build. Private keys and passwords are never written to generated configuration or printed by the helper.

Without an updater key pair, updater artifact generation is disabled. Release configuration replaces the upstream public key and leaves update endpoints empty; an update feed must be configured separately when the fork maintainer is ready to serve signed updates. `src-tauri/tauri.release.conf.json` also defaults to unsigned output for direct local use. Apple code signing and updater signing are separate features, and enabling one does not imply the other. No signed platform installer or notarized application has been produced as part of this change.

Artifact filenames include the matrix architecture, for example `macos-arm64--SideX.app.tar.gz`, so parallel macOS jobs cannot overwrite each other. Collection includes both Debian and RPM packages and uses the current Tauri v2 signature filenames. Each target includes a checksum list and an artifact inventory. The package-manifest generator below accepts these prefixed filenames as well as original Tauri filenames.

After every build succeeds, the workflow creates or updates a **draft** GitHub Release in the current repository. An existing tag must point to the workflow's commit, including when the tag is annotated. The workflow refuses to modify an already published release and does not mark a draft as the latest release. Publishing a draft remains a separate maintainer action. This workflow has been validated through helper tests and a real local Tauri signature fixture; it has not been dispatched during this work.

## Generate package-manager manifests

After building the platform artifacts, generate manifests from their actual bytes:

```sh
node scripts/package-manifests.mjs \
  --artifacts ./dist-artifacts \
  --version 0.1.3 \
  --output ./dist/package-manifests
```

The output contains:

- Winget version, locale, and installer manifests, including x64/ARM64 architectures and per-user/all-users scopes for the NSIS installer. The scope flags are `/CurrentUser` and `/AllUsers`; the `both` NSIS installer requests elevation for either selection.
- A Homebrew Cask with separate architecture downloads, or a universal DMG when one is available.
- A Flatpak manifest for each Debian package, plus a local manifest that consumes the artifact before a GitHub release exists.
- An artifact inventory containing real SHA-256 digests and versioned release URLs.

The default repository is `naulbi-dump-projects/sidex`. `--repository`, `--release-base`, `--package-id`, and `--app-id` make the publisher and distribution endpoints explicit. Empty artifacts, duplicate platform/architecture outputs, and mismatched versions are rejected. No placeholder checksums or mutable `latest` URLs are generated.

The generator prepares files for review and submission. It does not publish a GitHub release, upload to a package repository, modify Git, or register a Winget, Homebrew, or Flathub listing. Those services require their own publisher submission and review.

### Flatpak

Install the GNOME 50 platform and SDK and use the generated local manifest:

```sh
flatpak install --user flathub org.gnome.Platform//50 org.gnome.Sdk//50
flatpak-builder --user --force-clean --repo=flatpak-repo \
  flatpak-build dist/package-manifests/flatpak/x64/manifest.local.json
flatpak build-bundle flatpak-repo SideX.flatpak dev.sidex.app
```

The runtime is `org.gnome.Platform`; the SDK is used only for building. The manifest preserves Tauri's case-sensitive `/app/lib/SideX` resource directory, including the extension host, shell integration, bundled Node, and optional AI server. A missing bundled Node causes a clear build failure. Debian archives with gzip, xz, zstd, bzip2, or lzma data members are supported rather than assuming `data.tar.gz`.

Tray dependencies use pinned [Flathub shared modules](https://github.com/flathub/shared-modules/tree/d1ab132e6480acefc5c510ee13d8d586d36cab19). The editor receives project-file access, network and SSH-agent access, and a host-shell bridge for integrated terminals. Terminals execute the user's host login shell through `flatpak-spawn --host`; language extensions continue to use the bundled Node runtime. Other tools that require host programs can be invoked through `flatpak-spawn --host` explicitly.

The local generation and archive-extraction paths are covered by tests. A full Flatpak build, install, and desktop launch still need a system with the GNOME SDK and a working user session. The manifest is a local packaging path, not a claim that this fork is already published on Flathub.

## Checks

```sh
node scripts/tests/tooling.test.mjs
node scripts/tests/packaging.test.mjs
node scripts/tests/release.test.mjs
```

These verify native PATH handling, literal CLI arguments, executable architecture detection, preservation of existing staging on invalid input, actual artifact hashes, per-architecture package metadata, and compressed Debian resource extraction. A staged Linux Node executable has also been launched successfully after copying it with its official license.

The packaged runtime minimums follow [Node.js 22 platform support](https://github.com/nodejs/node/blob/v22.23.4/BUILDING.md#platform-list). The recipes are based on the [Tauri distribution documentation](https://v2.tauri.app/distribute/), [Tauri updater signing](https://v2.tauri.app/plugin/updater/), [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/), [Nixpkgs Tauri hook](https://github.com/NixOS/nixpkgs/blob/ffb3c9b700e759be2ef13237c9d8f953b32a1e46/doc/hooks/tauri.section.md), and [GNOME runtime metadata](https://os.gnome.org/docs/ci-outputs.html).
