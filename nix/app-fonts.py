"""The app's fonts: each family's regular, bold, italic and bold italic, subset to what pi and harness
draw (Latin, Cyrillic, punctuation, arrows, box drawing, blocks, geometric shapes, dingbats,
braille) and written as woff2 (web) and ttf (native), with the families' licenses.

    python3 app-fonts.py <out> <family>=<style>:<file>[#<subfamily>] ...

A `.ttc` collection names the face by its subfamily (`#Italic`).
"""

import pathlib
import sys

from fontTools import subset
from fontTools.ttLib import TTCollection, TTFont

UNICODES = (
    "U+0020-007E,U+00A0-024F,U+0300-036F,U+0400-04FF,U+2000-206F,U+20A0-20BF,U+2100-214F,"
    "U+2190-21FF,U+2200-22FF,U+2300-23FF,U+2500-257F,U+2580-259F,U+25A0-25FF,U+2600-26FF,"
    "U+2700-27BF,U+2800-28FF"
)


def face(spec: str) -> TTFont:
    path, _, subfamily = spec.partition("#")
    if path.endswith(".ttc"):
        for font in TTCollection(path).fonts:
            if font["name"].getDebugName(2) == (subfamily or "Regular"):
                return font
        raise SystemExit(f"{path}: no face {subfamily or 'Regular'}")
    return TTFont(path)


def main() -> None:
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    options = subset.Options()
    options.unicodes = subset.parse_unicodes(UNICODES)
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.notdef_outline = True
    for argument in sys.argv[2:]:
        name, _, spec = argument.partition("=")
        style, _, source = spec.partition(":")
        for flavor, suffix in ((None, "ttf"), ("woff2", "woff2")):
            font = face(source)
            subsetter = subset.Subsetter(options)
            subsetter.populate(unicodes=options.unicodes)
            subsetter.subset(font)
            font.flavor = flavor
            font.save(out / f"{name}-{style}.{suffix}")


main()
