const store = require("./store");
const { fetchAllReplies } = require("./twitter");
const { extractWallets } = require("./wallets");

let runningId = null;

function envNumber(name, fallback) {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) ? value : fallback;
}

function getRunningId() {
  return runningId;
}

async function start({ postUrl, tweetId }) {
  const record = {
    id: store.newId(),
    postUrl,
    tweetId,
    status: "running",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    pages: 0,
    repliesScanned: 0,
    stoppedEarly: false,
    error: null,
    results: [],
  };

  runningId = record.id;
  try {
    await store.save(record);
  } catch (err) {
    runningId = null;
    throw err;
  }

  run(record)
    .catch((err) => console.error("Extraction crashed:", err))
    .finally(() => {
      runningId = null;
    });

  return record;
}

async function run(record) {
  const seen = new Set();

  try {
    const { stoppedEarly } = await fetchAllReplies(record.tweetId, {
      apiKey: process.env.TWITTERAPI_KEY,
      delayMs: envNumber("TWITTERAPI_DELAY_MS", 5000),
      maxPages: envNumber("MAX_REPLY_PAGES", 500),
      onPage: async (replies, pages) => {
        for (const reply of replies) {
          const author = reply.author || {};
          const urls = (reply.entities?.urls || []).map((u) => u.expanded_url || "");
          const text = [reply.text || "", ...urls].join(" ");

          for (const wallet of extractWallets(text)) {
            const dedupeKey = `${(author.userName || author.id || "").toLowerCase()}|${wallet.key}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            record.results.push({
              name: author.name || "",
              username: author.userName || "",
              address: wallet.address,
              chain: wallet.chain,
              key: wallet.key,
              replyUrl: reply.url || "",
            });
          }
        }

        record.pages = pages;
        record.repliesScanned += replies.length;
        await store.save(record);
      },
    });

    record.status = "done";
    record.stoppedEarly = stoppedEarly;
  } catch (err) {
    record.status = "failed";
    record.error = err.message;
  }

  record.finishedAt = new Date().toISOString();
  await store.save(record);
}

module.exports = { start, getRunningId };