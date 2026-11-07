# harness-telegram: the Telegram gateway of remote/ (sources run by Node
# directly), with the bundle's node_modules (grammy, yaml, pi's RPC types and
# ModelRuntime for the login helper). It starts pi through the bundle's
# launcher, whose path comes from its configuration (lib.mkRemoteImage).
{
  lib,
  stdenvNoCC,
  runtimeShell,
  nodejs,
  bundle,
}:
stdenvNoCC.mkDerivation {
  pname = "harness-telegram";
  inherit (bundle) version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      (lib.fileset.difference ../remote (
        lib.fileset.unions [
          ../remote/test
          ../remote/tsconfig.json
        ]
      ))
      ../rpc-dialogs.ts
      ../package.json # "type": "module" for the .ts sources
    ];
  };
  dontBuild = true;
  installPhase = ''
    runHook preInstall
    lib=$out/lib/harness-telegram
    mkdir -p $lib $out/bin
    cp -r remote rpc-dialogs.ts package.json $lib/
    ln -s ${bundle.passthru.npmTools}/node_modules $lib/node_modules
    cat > $out/bin/harness-telegram <<EOF
    #!${runtimeShell}
    exec ${lib.getExe nodejs} $lib/remote/main.ts "\$@"
    EOF
    chmod +x $out/bin/harness-telegram
    runHook postInstall
  '';
  meta = {
    description = "Telegram gateway of a remote harness deployment";
    mainProgram = "harness-telegram";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
