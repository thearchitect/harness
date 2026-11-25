// The bundled fonts on iOS and Android: expo-font from the ttf files the native build carries in
// assets/fonts/ (copied from the Nix build of the fonts, `nix/app-native.sh`). Each family is
// registered by its regular face under the family's name; bold and italic are the system's.

import * as Font from "expo-font";

export async function loadFonts(): Promise<void> {
  await Font.loadAsync({
    "JetBrains Mono": require("../../assets/fonts/jetbrains-mono-regular.ttf"),
    "Iosevka Term": require("../../assets/fonts/iosevka-term-regular.ttf"),
    Terminus: require("../../assets/fonts/terminus-regular.ttf"),
  });
}
