# Packaged runtimes

`node scripts/download-runtime.mjs <target>` downloads and verifies the official Node.js 22.23.4 runtime pinned in `scripts/runtime-versions.json`, then stages its executable and complete LICENSE here before a release build. `node scripts/stage-runtime.mjs` can stage a custom runtime directly; by default it uses the current developer Node, whose minimum operating-system version may be higher than SideX's. Generated binaries, checksums, and manifests are excluded from Git and included by Tauri's resource bundler.

Use `--target <Rust triple>` for a cross build and supply `--node <matching executable>` plus `--node-license <Node distribution LICENSE>`. Architecture and platform are checked from executable headers before any existing staged runtime is replaced. Universal macOS builds can supply `--node-x64` and `--node-arm64` from the corresponding Node distributions.

The optional `--server <matching sidex-server executable>` includes the local AI server. `--build-server` builds it for a native target using Go 1.26 or later, a C compiler, and the required `fts5` tag. Developers using a system-provided runtime, including Nix packages, can leave this directory unstaged; the application retains its system-runtime lookup.
