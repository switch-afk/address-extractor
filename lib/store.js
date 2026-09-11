const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DIR = path.join(__dirname, "..", "data", "extractions");

const isValidId = (id) => /^[a-f0-9]{12}$/.test(String(id));
const filePath = (id) => path.join(DIR, `${id}.json`);

function newId() {
  return crypto.randomBytes(6).toString("hex");
}

async function save(record) {
  await fs.mkdir(DIR, { recursive: true });
  const tmp = `${filePath(record.id)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(record, null, 2));
  await fs.rename(tmp, filePath(record.id));
}

async function get(id) {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(filePath(id), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// All extractions, newest first, without the (possibly large) results list
async function list() {
  await fs.mkdir(DIR, { recursive: true });
  const files = (await fs.readdir(DIR)).filter((f) => f.endsWith(".json"));
  const records = await Promise.all(
    files.map(async (f) => {
      const { results, ...summary } = JSON.parse(await fs.readFile(path.join(DIR, f), "utf8"));
      return { ...summary, resultCount: results.length };
    })
  );
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Anything still "running" when the server starts was cut off by a restart
async function markInterrupted() {
  for (const summary of await list()) {
    if (summary.status !== "running") continue;
    const record = await get(summary.id);
    record.status = "failed";
    record.error = "Stopped because the server restarted before it finished. The addresses found so far are kept.";
    record.finishedAt = new Date().toISOString();
    await save(record);
  }
}

module.exports = { newId, save, get, list, markInterrupted };