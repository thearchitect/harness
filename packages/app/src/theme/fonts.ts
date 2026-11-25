// The bundled fonts on iOS and Android: expo-font from the ttf files the native build carries
// (plan 10.3, stage 11). Until those builds exist, native draws the system monospace font.

export async function loadFonts(): Promise<void> {
  // native builds are stage 11: the system monospace font meanwhile
}
