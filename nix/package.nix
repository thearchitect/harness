# The harness bundle: a `pi` wrapper that loads the harness extension and the
# bundled pi packages, plus every pinned MCP tool the extension registers
# (published to it through $HARNESS_MANIFEST). The project toolchain (go, node,
# the project's TypeScript, make, ...) is deliberately NOT part of the bundle:
# it comes from the user's PATH.
{
  lib,
  stdenv,
  stdenvNoCC,
  fetchurl,
  importNpmLock,
  nodejs,
  autoPatchelfHook,
  makeWrapper,
  libxcb,
  writeText,
  writeShellScriptBin,
  codegraph,
  herdr,
  gopls,
  rust-analyzer,
  pnpm,
  ripgrep,
  fd,
  harnessSrc,
}:
let
  system = stdenv.hostPlatform.system;
  sources = lib.importJSON ./sources.json;
  npmLock = lib.importJSON ./npm/package-lock.json;
  npmVersion = name: npmLock.packages."node_modules/${name}".version;
  asset = id: sources.${id}.assets.${system} or (throw "${id}: no release asset for ${system}");

  harnessVersion = harnessSrc.shortRev or harnessSrc.dirtyShortRev or "dev";

  # --------------------------------------------------------------------------
  # Components
  # --------------------------------------------------------------------------

  # The harness extension as pi loads it (`-e <dir>` reads package.json "pi").
  extension = stdenvNoCC.mkDerivation {
    pname = "harness-extension";
    version = harnessVersion;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../index.ts
        ../deps.ts
        ../lsp
        ../workarounds.ts
        ../prompt.ts
        ../prompt.yaml
        ../package.json
        ../skills
        ../LICENSE
        ../README.md
      ];
    };
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      cp -r . $out
      runHook postInstall
    '';
  };

  # pi, the bundled pi packages and the npm-distributed MCP servers, from one
  # generated lockfile (nix/npm). Install scripts are skipped: none of the
  # bundled packages needs them (onnxruntime-node's only downloads optional GPU
  # providers; prebuilt native modules ship in the packages).
  npmTools = importNpmLock.buildNodeModules {
    npmRoot = ./npm;
    inherit nodejs;
    derivationArgs = {
      pname = "harness-npm-tools";
      version = harnessVersion;
      npmRebuildFlags = [ "--ignore-scripts" ];
      nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
      buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
        stdenv.cc.cc.lib
        libxcb # pi-tui's X11 clipboard addon
      ];
      # The installed lockfiles point at every npm tarball in the store
      # (importNpmLock rewrites `resolved`); dropping them keeps the tarballs
      # out of the runtime closure.
      postInstall = ''
        rm -f $out/package.json $out/package-lock.json $out/node_modules/.package-lock.json
      '';
      # npm cannot detect the libc inside the sandbox and installs sharp's musl
      # builds next to the glibc ones; they can never load here.
      preFixup = lib.optionalString stdenv.hostPlatform.isLinux ''
        rm -rf $out/node_modules/@img/*-linuxmusl-*
      '';
      # onnxruntime-node ships GPU execution providers that link CUDA/TensorRT;
      # they are loaded only on request, never by the bundled packages.
      autoPatchelfIgnoreMissingDeps = [
        "libcuda.so.1"
        "libcudart.so.*"
        "libcublas*.so.*"
        "libcudnn*.so.*"
        "libcufft.so.*"
        "libcurand.so.*"
        "libnvinfer*.so.*"
        "libnvonnxparser.so.*"
      ];
    };
  };
  nodeModules = "${npmTools}/node_modules";

  # codegraph's release bundle ships its own node binary; nixpkgs' codegraph
  # patchelfs it, and the patched binary segfaults (even on --version). Run the
  # bundle's JS on our nodejs instead (it needs node:sqlite and an N-API
  # kernel addon; engines: node >=20 <25), reusing nixpkgs' pinned sources.
  codegraphPkg = stdenv.mkDerivation {
    pname = "codegraph";
    inherit (codegraph) version src sourceRoot;
    nativeBuildInputs = [
      makeWrapper
    ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
    buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/codegraph
      cp -r lib $out/lib/codegraph/lib
      # Same node flags as the bundle's bin/codegraph launcher.
      makeWrapper ${lib.getExe nodejs} $out/bin/codegraph \
        --add-flags "--liftoff-only --disable-warning=ExperimentalWarning $out/lib/codegraph/lib/dist/bin/codegraph.js"
      runHook postInstall
    '';
    meta.mainProgram = "codegraph";
  };

  lightpanda = stdenv.mkDerivation {
    pname = "lightpanda";
    inherit (sources.lightpanda) version;
    src = fetchurl { inherit (asset "lightpanda") url hash; };
    dontUnpack = true;
    nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
    installPhase = ''
      runHook preInstall
      install -Dm755 $src $out/bin/lightpanda
      runHook postInstall
    '';
  };

  # The native TypeScript 7 language server: the platform package npm installs
  # next to `typescript` (whose API lsp/ loads from the same version).
  tsgoPlatform =
    {
      x86_64-linux = "linux-x64";
      aarch64-linux = "linux-arm64";
      aarch64-darwin = "darwin-arm64";
    }
    .${system} or (throw "typescript: no native build for ${system}");
  tsgo = "${nodeModules}/@typescript/typescript-${tsgoPlatform}/lib/tsc";

  # Bundled pi packages, loaded with `-e` in this order.
  piPackages = [
    "@cortexkit/pi-magic-context"
    "pi-ask-user"
    "pi-ollama-cloud"
    "pi-deepseek-search"
  ];

  # Read by deps.ts: absolute paths and versions of everything it registers or reports.
  manifest = writeText "harness-manifest.json" (
    builtins.toJSON {
      harness = harnessVersion;
      versions = {
        pi = npmVersion "@earendil-works/pi-coding-agent";
        codegraph = codegraph.version;
        lightpanda = lightpanda.version;
        typescript = npmVersion "typescript";
        gopls = gopls.version;
        rust-analyzer = rust-analyzer.version;
        playwright-mcp = npmVersion "@playwright/mcp";
        chrome-devtools-mcp = npmVersion "chrome-devtools-mcp";
        herdr = herdr.version;
        pnpm = pnpm.version;
      }
      // lib.genAttrs piPackages npmVersion;
      # Package directories: pi itself, the bundled pi packages, and typescript
      # (the API of the TypeScript language server, loaded by lsp/).
      packages = {
        pi = "${nodeModules}/@earendil-works/pi-coding-agent";
        typescript = "${nodeModules}/typescript";
      }
      // lib.genAttrs piPackages (p: "${nodeModules}/${p}");
      bin = {
        codegraph = lib.getExe codegraphPkg;
        lightpanda = "${lightpanda}/bin/lightpanda";
        inherit tsgo;
        gopls = lib.getExe gopls;
        rust-analyzer = lib.getExe rust-analyzer;
        playwright-mcp = "${nodeModules}/.bin/playwright-mcp";
        chrome-devtools-mcp = "${nodeModules}/.bin/chrome-devtools-mcp";
        herdr = lib.getExe herdr;
      };
    }
  );

  piCli = "${nodeModules}/@earendil-works/pi-coding-agent/dist/bundle/cli.js";

  # Subcommands pi handles before parsing options (main.ts: auth, package
  # commands, config, mcp). `-e` must not precede them, or pi takes the
  # subcommand for a prompt; they do not need the bundled extensions.
  piSubcommands = "auth|install|remove|uninstall|update|list|config|mcp";

  # launcher <extension dir shell expression> → body of the `pi` launcher.
  launcher = extensionDir: ''
    export HARNESS_MANIFEST=${manifest}
    export PI_SKIP_VERSION_CHECK=1
    export PI_TELEMETRY="''${PI_TELEMETRY-0}"
    export PATH="${
      lib.makeBinPath [
        ripgrep
        fd
      ]
    }:$PATH"
    case "''${1-}" in
      ${piSubcommands}) exec ${lib.getExe nodejs} ${piCli} "$@" ;;
    esac
    # Discover schemas inside codemode, without promoting tools into model
    # declarations (tool_search changes invalidate the provider's prompt cache).
    exec ${lib.getExe nodejs} ${piCli} \
      --tools +codemode \
      --exclude-tools tool_search \
      -e ${extensionDir} \
      ${lib.concatMapStringsSep " " (p: "-e ${nodeModules}/${p}") piPackages} \
      "$@"
  '';

  # pi-dev: the same launcher (same pinned pi, packages and tools) with the
  # extension loaded from a harness working tree ($HARNESS_DEV_DIR, default:
  # the current directory). Edit the checkout, restart pi-dev (or /reload): no
  # rebuild needed.
  dev = writeShellScriptBin "pi-dev" (
    ''
      HARNESS_DEV_DIR="$(cd "''${HARNESS_DEV_DIR:-$PWD}" && pwd)"
      if [[ "$(${lib.getExe nodejs} -p 'require(process.argv[1]).name' "$HARNESS_DEV_DIR/package.json" 2>/dev/null)" != harness ]]; then
        echo "pi-dev: $HARNESS_DEV_DIR is not a harness checkout (run it from one or set HARNESS_DEV_DIR)" >&2
        exit 1
      fi
    ''
    + launcher ''"$HARNESS_DEV_DIR"''
  );

  pi = writeShellScriptBin "pi" (launcher extension);
in
stdenvNoCC.mkDerivation {
  pname = "harness";
  version = harnessVersion;
  dontUnpack = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/share/harness
    # A copy, not a symlink: scripts resolve the bundle (and its manifest)
    # from `readlink -f $(command -v pi)`.
    install -Dm755 ${pi}/bin/pi $out/bin/pi
    ln -s ${dev}/bin/pi-dev $out/bin/pi-dev
    ln -s ${lib.getExe herdr} $out/bin/herdr
    ln -s ${lib.getExe pnpm} $out/bin/pnpm
    ln -s ${manifest} $out/share/harness/manifest.json
    runHook postInstall
  '';

  passthru = {
    inherit
      extension
      npmTools
      lightpanda
      manifest
      dev
      ;
  };

  meta = {
    description = "pi coding agent with the harness workflow extension and its pinned tools";
    homepage = "https://github.com/thearchitect/harness";
    license = lib.licenses.mit;
    mainProgram = "pi";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
  };
}
