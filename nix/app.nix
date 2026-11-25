# The app (packages/app, Expo + React Native): its own node_modules from its lockfile (Metro needs
# them, plan A17), and the web build that hubs and `harness web-app` serve. iOS and Android builds
# come later (plan 10.7, stage 11).
{
  lib,
  stdenv,
  importNpmLock,
  nodejs,
  harnessVersion,
  python3,
  jetbrains-mono,
  iosevka-bin,
  terminus_font_ttf,
  runCommand,
  fetchurl,
}:
let
  # The fonts of the two zones (plan 10.3): subset, woff2 for web and ttf for native, with licenses.
  iosevkaTerm = iosevka-bin.override { variant = "SGr-IosevkaTerm"; };
  iosevkaLicense = fetchurl {
    url = "https://raw.githubusercontent.com/be5invis/Iosevka/v${iosevkaTerm.version}/LICENSE.md";
    sha256 = "0p9w5rg132q9xlv5l3ljd48wg1f4ahhd5mzqwnm7k4mk3iy3r9ab";
  };
  fonts =
    runCommand "harness-app-fonts"
      {
        nativeBuildInputs = [
          (python3.withPackages (p: [
            p.fonttools
            p.brotli
          ]))
        ];
      }
      ''
        jb=${jetbrains-mono}/share/fonts/truetype
        io=${iosevkaTerm}/share/fonts/truetype
        te=${terminus_font_ttf}/share/fonts/truetype
        python3 ${./app-fonts.py} $out \
          jetbrains-mono=regular:$jb/JetBrainsMono-Regular.ttf \
          jetbrains-mono=bold:$jb/JetBrainsMono-Bold.ttf \
          jetbrains-mono=italic:$jb/JetBrainsMono-Italic.ttf \
          jetbrains-mono=bolditalic:$jb/JetBrainsMono-BoldItalic.ttf \
          iosevka-term=regular:$io/SGr-IosevkaTerm-Regular.ttc#Regular \
          iosevka-term=bold:$io/SGr-IosevkaTerm-Bold.ttc#Bold \
          iosevka-term=italic:$io/SGr-IosevkaTerm-Regular.ttc#Italic \
          iosevka-term=bolditalic:$io/SGr-IosevkaTerm-Bold.ttc#Bold\ Italic \
          terminus=regular:$te/TerminusTTF.ttf \
          terminus=bold:$te/TerminusTTF-Bold.ttf \
          terminus=italic:$te/TerminusTTF-Italic.ttf \
          terminus=bolditalic:$te/TerminusTTF-Bold-Italic.ttf
        # all three are under the SIL Open Font License 1.1, which travels with the fonts
        mkdir -p $out/licenses
        cp ${jetbrains-mono.src}/OFL.txt $out/licenses/jetbrains-mono.txt
        cp ${iosevkaLicense} $out/licenses/iosevka-term.txt
        cp ${terminus_font_ttf.src}/COPYING $out/licenses/terminus.txt
      '';

  appModules = importNpmLock.buildNodeModules {
    npmRoot = ../packages/app;
    inherit nodejs;
    derivationArgs = {
      pname = "harness-app-modules";
      version = harnessVersion;
      npmRebuildFlags = [ "--ignore-scripts" ];
      postInstall = ''
        rm -f $out/package.json $out/package-lock.json $out/node_modules/.package-lock.json
      '';
    };
  };

  web = stdenv.mkDerivation {
    pname = "harness-app-web";
    version = harnessVersion;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [
        ../packages/app
        ../packages/client/src
        ../packages/protocol/src
        ../packages/testkit/src/fixtures
      ];
    };
    nativeBuildInputs = [ nodejs ];
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR CI=1 EXPO_OFFLINE=1 EXPO_NO_TELEMETRY=1 EXPO_NO_DOTENV=1
      cd packages/app
      ln -s ${appModules}/node_modules node_modules
      # public/ is copied into the build as is: the fonts at /fonts/<family>-<style>.woff2
      mkdir -p public/fonts
      cp ${fonts}/*.woff2 public/fonts/
      cp -r ${fonts}/licenses public/fonts/
      node node_modules/expo/bin/cli export --platform web --output-dir $out
      runHook postBuild
    '';
    dontInstall = true;
    dontFixup = true;
  };
in
{
  inherit appModules web fonts;
}
