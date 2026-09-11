const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const fontkit = require("fontkit");
const ExcelJS = require("exceljs");

const COLUMNS = [
  { id: "name", label: "Name" },
  { id: "username", label: "Username" },
  { id: "address", label: "Wallet address" },
  { id: "chain", label: "Chain" },
  { id: "reply", label: "Reply link" },
];

// Turns ?columns=name&columns=chain into column definitions, always in the same order
function pickColumns(requested) {
  const wanted = new Set([].concat(requested || []));
  const picked = COLUMNS.filter((c) => wanted.has(c.id));
  return picked.length ? picked : COLUMNS;
}

function cellValue(result, columnId) {
  switch (columnId) {
    case "name": return result.name;
    case "username": return result.username ? `@${result.username}` : "";
    case "address": return result.address;
    case "chain": return result.chain;
    case "reply": return result.replyUrl;
    default: return "";
  }
}

// ---------- CSV ----------

function csvCell(value) {
  let text = String(value ?? "");
  // Stop spreadsheet apps from treating names like "=SUM(...)" as formulas
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(extraction, columns) {
  const header = columns.map((c) => csvCell(c.label)).join(",");
  const rows = extraction.results.map((r) =>
    columns
      // Plain username in CSV, because a leading @ makes Excel treat the cell as a formula
      .map((c) => csvCell(c.id === "username" ? r.username : cellValue(r, c.id)))
      .join(",")
  );
  return "\uFEFF" + [header, ...rows].join("\r\n");
}

// ---------- Excel ----------

async function toXlsx(extraction, columns) {
  const widths = { name: 32, username: 22, address: 52, chain: 10, reply: 55 };
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Wallets");

  sheet.columns = columns.map((c) => ({ header: c.label, key: c.id, width: widths[c.id] }));

  for (const result of extraction.results) {
    const row = {};
    for (const c of columns) {
      const value = cellValue(result, c.id);
      row[c.id] = c.id === "reply" && value ? { text: value, hyperlink: value } : value;
    }
    const added = sheet.addRow(row);
    if (columns.some((c) => c.id === "reply") && result.replyUrl) {
      added.getCell("reply").font = { color: { argb: "FF4338CA" }, underline: true };
    }
  }

  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  return workbook.xlsx.writeBuffer();
}

// ---------- PDF ----------

const FONT_DIR = path.join(__dirname, "..", "fonts");
// Tried in this order for every character, so each one is drawn with a font that has it
const FALLBACK_FONTS = [
  "NotoSans-Regular.ttf",
  "NotoSansMath-Regular.ttf",
  "NotoSansSymbols2-Regular.ttf",
  "NotoSansDevanagari-Regular.ttf",
  "NotoSansBengali-Regular.ttf",
  "NotoSansTelugu-Regular.ttf",
  "NotoSansTamil-Regular.ttf",
  "NotoSansThai-Regular.ttf",
  "NotoSansCJK-Regular.otf",
  "NotoEmoji-Regular.ttf",
];
// Marks, joiners and emoji modifiers stay with the character before them
const ATTACHES_TO_PREVIOUS = /[\p{M}\u200D\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u;

let fontCache = null;

function loadFonts() {
  if (fontCache && fontCache.fallbacks.length) return fontCache;

  const fallbacks = [];
  for (const file of FALLBACK_FONTS) {
    const fontPath = path.join(FONT_DIR, file);
    if (!fs.existsSync(fontPath)) continue;
    try {
      fallbacks.push({ name: file, path: fontPath, face: fontkit.openSync(fontPath) });
    } catch (err) {
      console.warn(`Couldn't load font ${file}: ${err.message}`);
    }
  }

  const boldPath = path.join(FONT_DIR, "NotoSans-Bold.ttf");
  fontCache = { fallbacks, bold: fs.existsSync(boldPath) ? boldPath : null };
  return fontCache;
}

function makeFontKit(doc) {
  const { fallbacks, bold } = loadFonts();
  fallbacks.forEach((f) => doc.registerFont(f.name, f.path));
  const regular = fallbacks[0] ? fallbacks[0].name : "Helvetica";
  const boldName = bold ? (doc.registerFont("Bold", bold), "Bold") : "Helvetica-Bold";

  // Splits text into pieces that each use one font
  function toRuns(text) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!fallbacks.length) return [{ font: "Helvetica", text: clean.replace(/[^\x20-\x7E]/g, "") }];

    const runs = [];
    let current = null;
    for (const ch of clean) {
      if (current && ATTACHES_TO_PREVIOUS.test(ch)) {
        current.text += ch;
        continue;
      }
      const cp = ch.codePointAt(0);
      const font = fallbacks.find((f) => f.face.hasGlyphForCodePoint(cp));
      if (!font) {
        current = null; // no font has this character, so leave it out
        continue;
      }
      if (current && current.font === font.name) current.text += ch;
      else {
        current = { font: font.name, text: ch };
        runs.push(current);
      }
    }
    return runs;
  }

  return { regular, bold: boldName, toRuns };
}

function runsWidth(doc, runs, size) {
  return runs.reduce((w, r) => w + doc.font(r.font).fontSize(size).widthOfString(r.text), 0);
}

// Cuts text to fit a width, ending with "…"
function fitRuns(doc, runs, maxWidth, size, ellipsisFont) {
  if (runsWidth(doc, runs, size) <= maxWidth) return runs;

  const pieces = runs.map((r) => ({ font: r.font, chars: Array.from(r.text) }));
  while (pieces.length) {
    const last = pieces[pieces.length - 1];
    last.chars.pop();
    if (!last.chars.length) pieces.pop();
    const candidate = [
      ...pieces.map((p) => ({ font: p.font, text: p.chars.join("") })),
      { font: ellipsisFont, text: "…" },
    ];
    if (runsWidth(doc, candidate, size) <= maxWidth) return candidate;
  }
  return [];
}

function drawRuns(doc, runs, x, baseline, size, color) {
  let cx = x;
  for (const r of runs) {
    doc.font(r.font).fontSize(size).fillColor(color);
    doc.text(r.text, cx, baseline, { lineBreak: false, baseline: "alphabetic" });
    cx += doc.widthOfString(r.text);
  }
}

function writePdf(extraction, columns, stream) {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, bufferPages: true });
  doc.pipe(stream);

  const fonts = makeFontKit(doc);
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const usableWidth = doc.page.width - left - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom - 16;

  const SIZE = 8.5;
  const ROW = 20;
  const PAD = 6;
  const colors = { text: "#111827", muted: "#6b7280", header: "#374151", line: "#d1d5db", stripe: "#f3f4f6", link: "#4338ca" };

  // Column widths: fixed columns sized to their content, Name takes whatever is left
  const widths = {};
  const results = extraction.results;
  const maxWidth = (items, font, size) => Math.max(0, ...items.map((t) => doc.font(font).fontSize(size).widthOfString(t)));

  for (const c of columns) {
    if (c.id === "address") {
      widths.address = Math.max(maxWidth(results.map((r) => r.address), "Courier", 7.5), 90) + PAD * 2;
    } else if (c.id === "username") {
      widths.username = Math.min(Math.max(maxWidth(results.map((r) => `@${r.username}`), fonts.regular, SIZE), 60), 140) + PAD * 2;
    } else if (c.id === "chain") {
      widths.chain = 58;
    } else if (c.id === "reply") {
      widths.reply = 66;
    }
  }
  if (columns.some((c) => c.id === "name")) {
    const used = Object.values(widths).reduce((a, b) => a + b, 0);
    widths.name = Math.max(usableWidth - used, 120);
  }
  const tableWidth = Math.min(columns.reduce((w, c) => w + widths[c.id], 0), usableWidth);

  // Title block
  let y = top;
  doc.font(fonts.bold).fontSize(16).fillColor(colors.text).text("Wallet addresses", left, y);
  y = doc.y + 4;
  doc.font(fonts.regular).fontSize(9).fillColor(colors.link)
    .text(extraction.postUrl, left, y, { link: extraction.postUrl.startsWith("http") ? extraction.postUrl : `https://${extraction.postUrl}` });
  y = doc.y + 2;
  const exported = new Date().toUTCString().replace(/:\d\d GMT$/, " UTC");
  doc.fillColor(colors.muted)
    .text(`${results.length} addresses from ${extraction.repliesScanned} replies. Exported ${exported}.`, left, y);
  y = doc.y + 14;

  const drawHeader = () => {
    let x = left;
    for (const c of columns) {
      drawRuns(doc, [{ font: fonts.bold, text: c.label }], x + PAD, y + ROW / 2 + 3, SIZE, colors.header);
      x += widths[c.id];
    }
    doc.moveTo(left, y + ROW).lineTo(left + tableWidth, y + ROW).lineWidth(0.75).strokeColor(colors.line).stroke();
    y += ROW;
  };

  if (!results.length) {
    doc.font(fonts.regular).fontSize(10).fillColor(colors.muted).text("No wallet addresses were found in the replies.", left, y);
  } else {
    drawHeader();

    results.forEach((r, i) => {
      if (y + ROW > bottom) {
        doc.addPage();
        y = top;
        drawHeader();
      }
      if (i % 2 === 1) doc.rect(left, y, tableWidth, ROW).fill(colors.stripe);

      const baseline = y + ROW / 2 + 3;
      let x = left;
      for (const c of columns) {
        const width = widths[c.id] - PAD * 2;
        if (c.id === "address") {
          drawRuns(doc, [{ font: "Courier", text: r.address }], x + PAD, baseline, 7.5, colors.text);
        } else if (c.id === "reply") {
          if (r.replyUrl) {
            drawRuns(doc, [{ font: fonts.regular, text: "View reply" }], x + PAD, baseline, SIZE, colors.link);
            doc.link(x + PAD, y + 3, width, ROW - 6, r.replyUrl);
          }
        } else {
          const runs = fitRuns(doc, fonts.toRuns(cellValue(r, c.id)), width, SIZE, fonts.regular);
          drawRuns(doc, runs, x + PAD, baseline, SIZE, c.id === "chain" ? colors.muted : colors.text);
        }
        x += widths[c.id];
      }
      y += ROW;
    });
  }

  // Page numbers
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font(fonts.regular).fontSize(8).fillColor(colors.muted)
      .text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - 28, { width: usableWidth, align: "right", lineBreak: false });
    doc.page.margins.bottom = savedBottom;
  }

  doc.end();
}

module.exports = { COLUMNS, pickColumns, toCsv, toXlsx, writePdf };