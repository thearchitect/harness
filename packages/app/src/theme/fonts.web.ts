// The bundled fonts on web: @font-face rules for /fonts/<family>-<style>.woff2 (the build copies
// them there), loaded before the interface shows so the layout never jumps.

const FACES: { family: string; file: string }[] = [
  { family: "JetBrains Mono", file: "jetbrains-mono" },
  { family: "Iosevka Term", file: "iosevka-term" },
  { family: "Terminus", file: "terminus" },
];

const STYLES = [
  { style: "regular", weight: "normal", italic: false },
  { style: "bold", weight: "bold", italic: false },
  { style: "italic", weight: "normal", italic: true },
  { style: "bolditalic", weight: "bold", italic: true },
];

export async function loadFonts(): Promise<void> {
  const rules = FACES.flatMap(({ family, file }) =>
    STYLES.map(
      ({ style, weight, italic }) =>
        `@font-face { font-family: "${family}"; src: url("/fonts/${file}-${style}.woff2") format("woff2"); font-weight: ${weight}; font-style: ${italic ? "italic" : "normal"}; font-display: block; }`,
    ),
  );
  const element = document.createElement("style");
  element.textContent = rules.join("\n");
  document.head.appendChild(element);
  await Promise.all(FACES.flatMap(({ family }) => [document.fonts.load(`13px "${family}"`), document.fonts.load(`bold 13px "${family}"`)]));
}
