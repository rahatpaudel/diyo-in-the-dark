# Bundled fonts

The loader caption uses two open-source typefaces, both self-hosted so the page
renders identically from `file://` and `http://` with no network access.

| Font | Used for | License |
| --- | --- | --- |
| [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) | the "LOADING" line | SIL Open Font License 1.1 — `OFL-JetBrainsMono.txt` |
| [Yatra One](https://github.com/google/fonts/tree/main/ofl/yatraone) | the "एकैछिन है" line | SIL Open Font License 1.1 — `OFL-YatraOne.txt` |
| [Noto Sans Devanagari](https://fonts.google.com/noto/specimen/Noto+Sans+Devanagari) | the १ २ ३ numerals and second-riddle title on the signs | SIL Open Font License 1.1 — `OFL-NotoSansDevanagari.txt` |

Each face is subsetted down to the handful of glyphs it needs and inlined as a
base64 `data:` URL: the loader faces in `loading.css` (~6 KB for both), and the
riddle glyphs as `Riddle Devanagari` in `style.css` (~4 KB). That keeps the loader
tiny and, unlike separate `.woff2` requests, also works under Chrome's `file://`
origin rules, which block cross-file font fetches.

## Regenerating the subsets

Change the strings below to match the caption (`UPPERCASE` for the mono line,
Devanagari for the sub-line), then paste the printed CSS into `loading.css` in
place of the two existing `@font-face` blocks:

```sh
# 1. fetch the upstream faces once (Google Fonts serves woff2 to a Chrome UA)
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400&display=swap"
curl -s -A "$UA" "https://fonts.googleapis.com/css2?family=Yatra+One&display=swap"
# copy the "latin" / "devanagari" src URLs, then:

# 2. subset + base64
npm install subset-font
node -e '
const subsetFont = require("subset-font");
const fs = require("fs");
(async () => {
  for (const [file, text] of [
    ["jetbrains-latin.woff2", "LOADING"],
    ["yatra-devanagari.woff2", "एकैछिन है"],
  ]) {
    const out = await subsetFont(fs.readFileSync(file), text, { targetFormat: "woff2" });
    console.log(file, out.length, "bytes ->", out.toString("base64"));
  }
})();'
```

## Licensing

The font software stays under the SIL OFL 1.1; the rest of this project can be
licensed separately (for example MIT). Keep both `OFL-*.txt` files in the
repository when redistributing, and do not sell the fonts on their own.
