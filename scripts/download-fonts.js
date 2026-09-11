// Downloads the fonts used for PDF exports into ./fonts (runs automatically after `npm install`).
// They cover Latin, Cyrillic, Greek, Indian scripts, Thai, Chinese/Japanese/Korean, fancy
// math-style letters and emoji, so display names show up correctly in PDFs.
const fs = require("fs");
const path = require("path");

const NOTO = "https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts";

const FONTS = [
  ["NotoSans-Regular.ttf", `${NOTO}/NotoSans/hinted/ttf/NotoSans-Regular.ttf`],
  ["NotoSans-Bold.ttf", `${NOTO}/NotoSans/hinted/ttf/NotoSans-Bold.ttf`],
  ["NotoSansMath-Regular.ttf", `${NOTO}/NotoSansMath/hinted/ttf/NotoSansMath-Regular.ttf`],
  ["NotoSansSymbols2-Regular.ttf", `${NOTO}/NotoSansSymbols2/hinted/ttf/NotoSansSymbols2-Regular.ttf`],
  ["NotoSansDevanagari-Regular.ttf", `${NOTO}/NotoSansDevanagari/hinted/ttf/NotoSansDevanagari-Regular.ttf`],
  ["NotoSansBengali-Regular.ttf", `${NOTO}/NotoSansBengali/hinted/ttf/NotoSansBengali-Regular.ttf`],
  ["NotoSansTelugu-Regular.ttf", `${NOTO}/NotoSansTelugu/hinted/ttf/NotoSansTelugu-Regular.ttf`],
  ["NotoSansTamil-Regular.ttf", `${NOTO}/NotoSansTamil/hinted/ttf/NotoSansTamil-Regular.ttf`],
  ["NotoSansThai-Regular.ttf", `${NOTO}/NotoSansThai/hinted/ttf/NotoSansThai-Regular.ttf`],
  ["NotoSansCJK-Regular.otf", "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf"],
  ["NotoEmoji-Regular.ttf", "https://raw.githubusercontent.com/google/fonts/main/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf"],
];

const DIR = path.join(__dirname, "..", "fonts");

async function main() {
  fs.mkdirSync(DIR, { recursive: true });

  for (const [file, url] of FONTS) {
    const target = path.join(DIR, file);
    if (fs.existsSync(target) && fs.statSync(target).size > 0) continue;

    process.stdout.write(`Downloading ${file}... `);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(`${target}.tmp`, buffer);
      fs.renameSync(`${target}.tmp`, target);
      console.log("done");
    } catch (err) {
      console.log(`failed (${err.message}). PDFs will skip characters this font covers. Run "npm run fonts" to try again.`);
    }
  }
}

main();