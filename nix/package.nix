{ lib, rustPlatform, importNpmLock, cargo-tauri, nodejs_24, pkg-config,
  wrapGAppsHook4, openssl, glib-networking, webkitgtk_4_1, gtk3, glib,
  librsvg, libayatana-appindicator, libsoup_3, libxdo, git, openssh, bash, src }:

rustPlatform.buildRustPackage {
  pname = "sidex";
  version = (builtins.fromJSON (builtins.readFile (src + "/package.json"))).version;
  inherit src;

  # The active Cargo workspace and lock file live at the repository root.
  cargoLock.lockFile = src + "/Cargo.lock";
  cargoRoot = ".";
  buildAndTestSubdir = "src-tauri";
  cargoBuildFlags = [ "--locked" ];
  RUST_MIN_STACK = "16777216";

  # Both dependency sets use the integrity data already committed in their lock
  # files. No copied hash from another fork or placeholder hash is required.
  npmDeps = importNpmLock { npmRoot = src; };
  nativeBuildInputs = [
    cargo-tauri.hook importNpmLock.npmConfigHook nodejs_24 pkg-config wrapGAppsHook4
  ];
  buildInputs = [
    openssl glib-networking webkitgtk_4_1 gtk3 glib librsvg
    libayatana-appindicator libsoup_3 libxdo
  ];

  # Tests run in the repository's native CI. The packaged application requires
  # a display server for GUI integration tests.
  doCheck = false;
  preBuild = ''
    export TAURI_FRONTEND_PATH="$PWD"
  '';
  preFixup = ''
    gappsWrapperArgs+=(--prefix PATH : "${lib.makeBinPath [ nodejs_24 git openssh bash ]}")
  '';

  meta = {
    description = "Native code editor built with the VS Code workbench and Tauri";
    homepage = "https://github.com/naulbi-dump-projects/sidex";
    license = lib.licenses.mit;
    mainProgram = "SideX";
    platforms = [ "x86_64-linux" "aarch64-linux" ];
  };
}
