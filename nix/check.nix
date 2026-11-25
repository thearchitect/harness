# `nix flake check`'s test run: nix/check.sh on a copy of the sources, with
# the bundle's node_modules, manifest (the language servers of the lsp tests),
# the bundle itself (its smoke tests) and the toolchains of the language
# servers' fixtures.
{
  lib,
  stdenvNoCC,
  nodejs,
  git,
  procps,
  bundle,
}:
stdenvNoCC.mkDerivation {
  name = "harness-tests";
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../packages
      ../tests
      ../docs
      ../README.md
      ../package.json
      ../tsconfig.json
      ./check.sh
    ];
  };
  nativeBuildInputs = [
    nodejs
    git
    procps # pgrep: the lsp tests find the servers they started
  ]
  ++ bundle.passthru.toolchain;
  dontConfigure = true;
  buildPhase = ''
    runHook preBuild
    export HOME=$TMPDIR/home
    mkdir -p $HOME
    ln -s ${bundle.passthru.npmTools}/node_modules node_modules
    # the app's own modules (its type check) and its web build (the web driver)
    ln -s ${bundle.passthru.appModules}/node_modules packages/app/node_modules
    HARNESS_MANIFEST=${bundle.passthru.manifest} HARNESS_BUNDLE=${bundle} HARNESS_APP_WEB=${bundle.passthru.appWeb} bash nix/check.sh
    runHook postBuild
  '';
  installPhase = ''
    touch $out
  '';
}
