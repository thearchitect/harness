# The harness bundle: the `harness` command (TUI, node, agents: packages/ run
# by the bundled node), the bundled pi packages its agents load, plus every
# pinned MCP tool the extension registers (published to it through
# $HARNESS_MANIFEST). Further tools are bundled in a
# mode each (`bundledTools`; `.override { bundled = { go = "path"; }; }`):
# "none" leaves the tool out, "hidden" appends it to the agent's PATH only
# (the user's or the project's own wins), "path" also puts it on the user's
# PATH through the bundle's bin/ at a low priority. By default node and bun
# (runtimes of last resort) are on the user's PATH, ffmpeg and exiftool on the
# agent's only, and the go and rust toolchains are not bundled.
# On macOS the bundle also carries Ghostty and the Finder Quick Action
# "Harness" (macos/): `harness-open`, installed by `harness-setup`.
{
  lib,
  callPackage,
  stdenv,
  stdenvNoCC,
  fetchurl,
  importNpmLock,
  nodejs,
  patchelfUnstable,
  autoPatchelfHook,
  libxcb,
  writeText,
  writeShellScriptBin,
  runCommand,
  replaceVars,
  runtimeShell,
  ghostty-bin,
  gopls,
  rust-analyzer,
  pnpm,
  ripgrep,
  fd,
  cage,
  bun,
  ffmpeg-headless,
  exiftool,
  go,
  rustc,
  cargo,
  clippy,
  rustfmt,
  # The real browser of the `browser` MCP server (flake.nix picks it per platform).
  browser,
  harnessSrc,
  # Modes of the bundled tools over their defaults (bundledTools).
  bundled ? { },
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

  # The harness sources as node runs them (TypeScript, types stripped by node):
  # packages/ resolve each other through package.json `imports` and their npm
  # dependencies (nix/npm) through node_modules next to it.
  app = stdenvNoCC.mkDerivation {
    pname = "harness-app";
    version = harnessVersion;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../packages
        ../docs
        ../package.json
        ../tsconfig.json
        ../LICENSE
        ../README.md
      ];
    };
    dontBuild = true;
    # docs/ links into pi/ (../pi/coding-agent/docs/…): the pi packages of this bundle, so the
    # links point at the documents of the pi that runs.
    installPhase = ''
      runHook preInstall
      cp -r . $out
      ln -s ${nodeModules} $out/node_modules
      mkdir $out/pi
      ln -s ${nodeModules}/@earendil-works/pi-coding-agent $out/pi/coding-agent
      ln -s ${nodeModules}/@earendil-works/pi-tui $out/pi/tui
      ln -s ${nodeModules}/@earendil-works/pi-ai $out/pi/ai
      ln -s ${nodeModules}/@earendil-works/pi-agent-core $out/pi/agent-core
      runHook postInstall
    '';
  };

  # The app (Expo + React Native): its web build is served by hubs and `harness web-app`.
  appBuild = callPackage ./app.nix { inherit harnessVersion nodejs; };

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
      nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [
        patchelfUnstable
        autoPatchelfHook
      ];
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

  # Tools bundled in a mode (`bundled` over `default`, one of `modes`), each
  # its packages with the executables "path" links into the bundle's bin/.
  # node is pi's own runtime, ffmpeg and exiftool are always the agent's: they
  # cannot be left out.
  bundledTools = {
    node = {
      default = "path";
      modes = [
        "hidden"
        "path"
      ];
      version = nodejs.version;
      contents = [
        {
          package = nodejs;
          bins = [
            "node"
            "npm"
            "npx"
          ];
        }
      ];
    };
    bun = {
      default = "path";
      modes = [
        "hidden"
        "path"
      ];
      version = bun.version;
      contents = [
        {
          package = bun;
          bins = [
            "bun"
            "bunx"
          ];
        }
      ];
    };
    ffmpeg = {
      default = "hidden";
      modes = [
        "hidden"
        "path"
      ];
      version = ffmpeg-headless.version;
      contents = [
        {
          package = ffmpeg-headless;
          bins = [
            "ffmpeg"
            "ffprobe"
          ];
        }
      ];
    };
    exiftool = {
      default = "hidden";
      modes = [
        "hidden"
        "path"
      ];
      version = exiftool.version;
      contents = [
        {
          package = exiftool;
          bins = [ "exiftool" ];
        }
      ];
    };
    go = {
      default = "none";
      modes = [
        "none"
        "hidden"
        "path"
      ];
      version = go.version;
      contents = [
        {
          package = go;
          bins = [
            "go"
            "gofmt"
          ];
        }
      ];
    };
    # The C compiler is rustc's linker.
    rust = {
      default = "none";
      modes = [
        "none"
        "hidden"
        "path"
      ];
      version = rustc.version;
      contents = [
        {
          package = rustc;
          bins = [
            "rustc"
            "rustdoc"
          ];
        }
        {
          package = cargo;
          bins = [ "cargo" ];
        }
        {
          package = clippy;
          bins = [
            "cargo-clippy"
            "clippy-driver"
          ];
        }
        {
          package = rustfmt;
          bins = [
            "rustfmt"
            "cargo-fmt"
          ];
        }
        {
          package = stdenv.cc;
          bins = [
            "cc"
            "c++"
          ];
        }
      ];
    };
  };
  unknownBundled = lib.attrNames (removeAttrs bundled (lib.attrNames bundledTools));
  bundledModes = lib.mapAttrs (
    id: tool:
    let
      mode = bundled.${id} or tool.default;
    in
    assert lib.assertOneOf "bundled.${id}" mode tool.modes;
    mode
  ) bundledTools;
  installedTools = lib.filterAttrs (id: _: bundledModes.${id} != "none") bundledTools;
  toolsOnPath = lib.filterAttrs (id: _: bundledModes.${id} == "path") bundledTools;
  toolPackages = tool: map (content: content.package) tool.contents;

  # Bundled pi packages: every agent loads them after the harness extension, in
  # this order (as package directories: their extensions and skills); the TUI
  # loads their renderers.
  piPackages = [
    "@cortexkit/pi-magic-context"
    "pi-ollama-cloud"
    "pi-deepseek-search"
    "@narumitw/pi-usage"
  ];

  # The cage skill is cage's own (`cage skill`): it always matches the bundled cage.
  cageSkill = runCommand "cage-skill" { } ''
    mkdir -p $out/cage
    ${cage}/bin/cage skill > $out/cage/SKILL.md
    grep -q '^name: cage$' $out/cage/SKILL.md
  '';

  # Read by deps.ts: absolute paths and versions of everything it registers or reports.
  manifest = writeText "harness-manifest.json" (
    builtins.toJSON {
      harness = harnessVersion;
      versions = {
        pi = npmVersion "@earendil-works/pi-coding-agent";
        lightpanda = lightpanda.version;
        typescript = npmVersion "typescript";
        gopls = gopls.version;
        rust-analyzer = rust-analyzer.version;
        playwright-mcp = npmVersion "@playwright/mcp";
        chrome-devtools-mcp = npmVersion "chrome-devtools-mcp";
        patchright = npmVersion "patchright";
        browser = "${lib.getName browser} ${browser.version}";
        pnpm = pnpm.version;
        cage = cage.version;
      }
      // lib.mapAttrs (_: tool: tool.version) installedTools
      // lib.optionalAttrs stdenv.hostPlatform.isDarwin { ghostty = ghostty-bin.version; }
      // lib.genAttrs piPackages npmVersion;
      # The modes of the bundled tools, the executables "path" links and the
      # agent's PATH entries of the installed ones (nix/smoke.sh checks them).
      bundled = lib.mapAttrs (
        id: tool:
        {
          mode = bundledModes.${id};
          bins = lib.concatMap (content: content.bins) tool.contents;
        }
        // lib.optionalAttrs (bundledModes.${id} != "none") { path = lib.makeBinPath (toolPackages tool); }
      ) bundledTools;
      # Package directories: pi itself, the bundled pi packages, and typescript
      # (the API of the TypeScript language server, loaded by lsp/).
      packages = {
        pi = "${nodeModules}/@earendil-works/pi-coding-agent";
        typescript = "${nodeModules}/typescript";
      }
      // lib.genAttrs piPackages (p: "${nodeModules}/${p}");
      # What every agent loads after the harness extension, in order.
      piExtensions = map (p: "${nodeModules}/${p}") piPackages;
      bin = {
        lightpanda = "${lightpanda}/bin/lightpanda";
        inherit tsgo;
        gopls = lib.getExe gopls;
        rust-analyzer = lib.getExe rust-analyzer;
        playwright-mcp = "${nodeModules}/.bin/playwright-mcp";
        chrome-devtools-mcp = "${nodeModules}/.bin/chrome-devtools-mcp";
        # The `browser` MCP server runs on the bundle's node.
        node = lib.getExe nodejs;
        browser = lib.getExe browser;
        cage = "${cage}/bin/cage"; # cage sets no meta.mainProgram
      };
      # Skills generated from bundled tools (index.ts registers them).
      skills = {
        cage = "${cageSkill}/cage/SKILL.md";
      };
    }
  );

  # Bundled tools on PATH, with telemetry off unless the user sets otherwise
  # (as deps.ts runs them).
  lightpandaCli = writeShellScriptBin "lightpanda" ''
    export LIGHTPANDA_DISABLE_TELEMETRY="''${LIGHTPANDA_DISABLE_TELEMETRY-true}"
    exec ${lightpanda}/bin/lightpanda "$@"
  '';
  chromeDevtoolsMcpCli = writeShellScriptBin "chrome-devtools-mcp" ''
    export CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS="''${CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS-1}"
    exec ${nodeModules}/.bin/chrome-devtools-mcp "$@"
  '';

  # launcher <sources shell expression> → body of the `harness` command.
  launcher = appDir: ''
    export HARNESS_MANIFEST=${manifest}
    export HARNESS_APP_WEB="''${HARNESS_APP_WEB:-${appBuild.web}}"
    export PI_SKIP_VERSION_CHECK=1
    export PI_TELEMETRY="''${PI_TELEMETRY-0}"
    export PATH="${
      lib.makeBinPath [
        ripgrep
        fd
      ]
    }:$PATH:${lib.makeBinPath (lib.concatMap toolPackages (lib.attrValues installedTools))}"
    exec ${lib.getExe nodejs} ${appDir}/packages/cli/src/main.ts "$@"
  '';

  # harness-dev: the same command (same pinned pi, packages and tools) running
  # a harness working tree ($HARNESS_DEV_DIR, default: the current directory).
  # Edit the checkout and restart: no rebuild needed.
  dev = writeShellScriptBin "harness-dev" (
    ''
      HARNESS_DEV_DIR="$(cd "''${HARNESS_DEV_DIR:-$PWD}" && pwd)"
      if [[ "$(${lib.getExe nodejs} -p 'require(process.argv[1]).name' "$HARNESS_DEV_DIR/package.json" 2>/dev/null)" != harness ]]; then
        echo "harness-dev: $HARNESS_DEV_DIR is not a harness checkout (run it from one or set HARNESS_DEV_DIR)" >&2
        exit 1
      fi
      # The npm dependencies, as in the bundle: the checkout's node_modules
      # (gitignored) points at the bundle's.
      if [[ -L "$HARNESS_DEV_DIR/node_modules" || ! -e "$HARNESS_DEV_DIR/node_modules" ]]; then
        ln -sfn ${nodeModules} "$HARNESS_DEV_DIR/node_modules"
      else
        echo "harness-dev: $HARNESS_DEV_DIR/node_modules is not a symlink; remove it so harness-dev can point it at the bundle's node_modules" >&2
        exit 1
      fi
      # the app's own modules (Metro and its type check), the same way
      if [[ -L "$HARNESS_DEV_DIR/packages/app/node_modules" || ! -e "$HARNESS_DEV_DIR/packages/app/node_modules" ]]; then
        ln -sfn ${appBuild.appModules}/node_modules "$HARNESS_DEV_DIR/packages/app/node_modules"
      else
        : # a node_modules of the developer's own
      fi
    ''
    + launcher ''"$HARNESS_DEV_DIR"''
  );

  harness = writeShellScriptBin "harness" (launcher app);

  # harness-test: the test harness of a checkout (packages/testkit/src/control/cli.ts) with the
  # bundle's node_modules and manifest (its browser draws the screenshots).
  harnessTest = writeShellScriptBin "harness-test" ''
    HARNESS_DEV_DIR="$(cd "''${HARNESS_DEV_DIR:-$PWD}" && pwd)"
    if [[ ! -f "$HARNESS_DEV_DIR/packages/testkit/src/control/cli.ts" ]]; then
      echo "harness-test: $HARNESS_DEV_DIR is not a harness checkout (run it from one or set HARNESS_DEV_DIR)" >&2
      exit 1
    fi
    if [[ -L "$HARNESS_DEV_DIR/node_modules" || ! -e "$HARNESS_DEV_DIR/node_modules" ]]; then
      ln -sfn ${nodeModules} "$HARNESS_DEV_DIR/node_modules"
    fi
    if [[ -L "$HARNESS_DEV_DIR/packages/app/node_modules" || ! -e "$HARNESS_DEV_DIR/packages/app/node_modules" ]]; then
      ln -sfn ${appBuild.appModules}/node_modules "$HARNESS_DEV_DIR/packages/app/node_modules"
    fi
    export HARNESS_MANIFEST=${manifest}
    export HARNESS_APP_WEB=''${HARNESS_APP_WEB:-${appBuild.web}}
    export PATH="${lib.makeBinPath [ nodejs ]}:$PATH"
    exec ${lib.getExe nodejs} "$HARNESS_DEV_DIR/packages/testkit/src/control/cli.ts" "$@"
  '';

  # macOS: Ghostty and the Finder Quick Action "Harness" (macos/). The
  # workflow is static and finds harness-open in the Nix profiles, so a
  # profile upgrade updates the behavior without reinstalling it.
  ghosttyApp = "${ghostty-bin}/Applications/Ghostty.app";
  macosLib = ../macos/lib.sh;
  workflow = ../macos/Harness.workflow;
  openScript = replaceVars ../macos/open.applescript { ghostty = ghosttyApp; };
  harnessOpen = replaceVars ../macos/harness-open.sh {
    inherit runtimeShell macosLib openScript;
    ghostty = ghosttyApp;
    harness = "${harness}/bin/harness";
  };
  harnessSetup = replaceVars ../macos/harness-setup.sh {
    inherit runtimeShell macosLib workflow;
  };
in
assert lib.assertMsg (unknownBundled == [ ])
  "bundled: unknown tools ${toString unknownBundled} (known: ${toString (lib.attrNames bundledTools)})";
stdenvNoCC.mkDerivation {
  pname = "harness";
  version = harnessVersion;
  dontUnpack = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin $out/share/harness
    # A copy, not a symlink: scripts resolve the bundle (and its manifest)
    # from `readlink -f $(command -v harness)`.
    install -Dm755 ${harness}/bin/harness $out/bin/harness
    ln -s ${dev}/bin/harness-dev $out/bin/harness-dev
    # share/harness: the sources, the documents (docs/ links into pi/), the pi packages
    ln -s ${app} $out/share/harness/src
    ln -s ${app}/docs $out/share/harness/docs
    ln -s ${app}/pi $out/share/harness/pi
    ln -s ${lib.getExe pnpm} $out/bin/pnpm
    ln -s ${cage}/bin/cage $out/bin/cage
    ln -s ${lightpandaCli}/bin/lightpanda $out/bin/lightpanda
    ln -s ${nodeModules}/.bin/playwright-mcp $out/bin/playwright-mcp
    ln -s ${chromeDevtoolsMcpCli}/bin/chrome-devtools-mcp $out/bin/chrome-devtools-mcp
    ln -s ${manifest} $out/share/harness/manifest.json
    # the app's web build (hubs and `harness web-app` serve it)
    ln -s ${appBuild.web} $out/share/harness/app-web
  ''
  + lib.concatMapStrings (
    tool:
    lib.concatMapStrings (
      content:
      lib.concatMapStrings (bin: ''
        test -x ${content.package}/bin/${bin}
        ln -s ${content.package}/bin/${bin} $out/bin/${bin}
      '') content.bins
    ) tool.contents
  ) (lib.attrValues toolsOnPath)
  + lib.optionalString stdenv.hostPlatform.isDarwin ''
    mkdir -p $out/Applications $out/share/harness/macos
    ln -s ${ghosttyApp} $out/Applications/Ghostty.app
    ln -s ${lib.getExe ghostty-bin} $out/bin/ghostty
    install -Dm755 ${harnessOpen} $out/bin/harness-open
    install -Dm755 ${harnessSetup} $out/bin/harness-setup
    ln -s ${workflow} $out/share/harness/macos/Harness.workflow
    ln -s ${openScript} $out/share/harness/macos/open.applescript
  ''
  + ''
    runHook postInstall
  '';

  # Not `dev`: stdenv would take a `dev` attribute for the package's
  # development output and put harness-dev instead of the bundle into the
  # buildInputs and shells that list the bundle.
  passthru = {
    appWeb = appBuild.web;
    appFonts = appBuild.fonts;
    appModules = appBuild.appModules;
    inherit
      app
      npmTools
      lightpanda
      manifest
      cage
      ;
    harnessDev = dev;
    inherit harnessTest;
    # The toolchains of the bundled language servers (the development shell's, for nix/test.sh).
    toolchain = toolPackages bundledTools.go ++ toolPackages bundledTools.rust;
  };

  meta = {
    description = "harness: a multi-session coding agent platform on pi, with its pinned tools";
    homepage = "https://github.com/thearchitect/harness";
    license = lib.licenses.mit;
    mainProgram = "harness";
    # Lower than the default (5): the user's own node or bun wins a name
    # collision in a profile or buildEnv.
    priority = 10;
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
  };
}
