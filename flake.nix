{
  description = "SideX native code editor and development environment";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: import nixpkgs { inherit system; };
      packageFor = system: (pkgsFor system).callPackage ./nix/package.nix { src = self; };
    in {
      packages = forAllSystems (system: { default = packageFor system; });
      apps = forAllSystems (system: {
        default = { type = "app"; program = "${packageFor system}/bin/SideX"; };
      });
      devShells = forAllSystems (system:
        let pkgs = pkgsFor system;
        in {
          default = pkgs.mkShell {
            inputsFrom = [ (packageFor system) ];
            packages = with pkgs; [ cargo rustc cargo-tauri nodejs_24 go git openssh ];
            shellHook = ''
              export XDG_DATA_DIRS="$GSETTINGS_SCHEMAS_PATH''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
            '';
          };
        });
      formatter = forAllSystems (system: (pkgsFor system).nixfmt-rfc-style);
    };
}
