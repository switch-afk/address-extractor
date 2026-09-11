const store = require("./store");
const { fetchAllReplies } = require("./twitter");
const { extractWallets } = require("./wallets");

let current = null; // { id, controller, done }

function envNumber(name, fallback) {
  const raw = process.env[name];
  const value = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(value) ? value : fallback;
}

function getRunningId() {
  return current ? current.id : null;
}

// Stops the running extraction and waits until its results are saved
async function stop(id) {
  if (!current || current.id !== id) return false;
  current.controller.abort();
  await current.done;
  return true;
}

async function start({ postUrl, tweetId }) {
  const record = {
    id: store.newId(),
    postUrl,
    tweetId,
    status: "running",
    phase: "Starting",
    createdAt: new Date().toISOString(),
    finishedAt: null,
    expectedReplies: null,
    requests: 0,
    repliesScanned: 0,
    warnings: [],
    error: null,
    results: [],
  };

  const controller = new AbortController();
  current = { id: record.id, controller, done: null };

  try {
    await store.save(record);
  } catch (err) {
    current = null;
    throw err;
  }

  current.done = run(record, controller.signal)
    .catch((err) => console.error("Extraction crashed:", err))
    .finally(() => {
      current = null;
    });

  return record;
}

async function run(record, signal) {
  const seenTweets = new Set();
  const seenResults = new Set();

  try {
    await fetchAllReplies(record.tweetId, {
      apiKey: process.env.TWITTERAPI_KEY,
      delayMs: envNumber("TWITTERAPI_DELAY_MS", 300),
      signal,

      onRequest: () => {
        record.requests++;
      },

      onPost: async (post) => {
        if (Number.isFinite(post.replyCount)) record.expectedReplies = post.replyCount;
      },

      onPhase: async (label) => {
        record.phase = label;
        await store.save(record);
      },

      onWarning: async (message) => {
        record.warnings.push(message);
      },

      onTweets: async (tweets) => {
        let newCount = 0;

        for (const reply of tweets) {
          if (!reply?.id || reply.id === record.tweetId || seenTweets.has(reply.id)) continue;
          seenTweets.add(reply.id);
          newCount++;

          const author = reply.author || {};
          const urls = (reply.entities?.urls || []).map((u) => u.expanded_url || "");
          const text = [reply.text || "", ...urls].join(" ");

          for (const wallet of extractWallets(text)) {
            const dedupeKey = `${(author.userName || author.id || "").toLowerCase()}|${wallet.key}`;
            if (seenResults.has(dedupeKey)) continue;
            seenResults.add(dedupeKey);

            record.results.push({
              name: author.name || "",
              username: author.userName || "",
              avatar: author.profilePicture || "",
              address: wallet.address,
              chain: wallet.chain,
              key: wallet.key,
              replyUrl: reply.url || "",
            });
          }
        }

        record.repliesScanned = seenTweets.size;
        await store.save(record);
        return newCount;
      },
    });

    record.status = "done";
  } catch (err) {
    if (signal.aborted) {
      record.status = "stopped";
    } else {
      record.status = "failed";
      record.error = err.message;
    }
  }

  record.phase = null;
  record.finishedAt = new Date().toISOString();
  await store.save(record);
}

module.exports = { start, stop, getRunningId };