const API_BASE = "https://api.twitterapi.io";
const MAX_ATTEMPTS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Accepts links like https://x.com/user/status/123, twitter.com/user/status/123?s=20, or a bare post ID
function parseTweetId(input) {
  const value = String(input || "").trim();
  if (/^\d{5,25}$/.test(value)) return value;

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^(www\.|mobile\.)/, "");
  if (host !== "x.com" && host !== "twitter.com") return null;

  const match = url.pathname.match(/\/status(?:es)?\/(\d{5,25})/);
  return match ? match[1] : null;
}

async function apiGet(path, params, apiKey) {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { "x-api-key": apiKey },
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw new Error(`Couldn't reach twitterapi.io (${err.message}).`);
      await sleep(3000 * attempt);
      continue;
    }

    // Rate limited or temporary server problem: wait and retry
    if (res.status === 429 || res.status >= 500) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`twitterapi.io kept returning ${res.status}. Try again in a few minutes.`);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 5000 * attempt);
      continue;
    }

    const body = await res.json().catch(() => null);

    if (res.status === 401 || res.status === 403) {
      throw new Error("twitterapi.io rejected the API key. Check TWITTERAPI_KEY in .env.");
    }
    if (!res.ok || !body || body.status === "error") {
      throw new Error(`twitterapi.io error: ${body?.message || body?.msg || `HTTP ${res.status}`}`);
    }
    return body;
  }
}

// Fetches every page of replies, calling onPage(newReplies, pageNumber) after each page
async function fetchAllReplies(tweetId, { apiKey, delayMs, maxPages, onPage }) {
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = "";
  let pages = 0;

  while (true) {
    const data = await apiGet(
      "/twitter/tweet/replies/v2",
      { tweetId, cursor, queryType: "Latest" },
      apiKey
    );
    pages++;

    const tweets = data.tweets || data.replies || [];
    const fresh = tweets.filter((t) => t && t.id && t.id !== tweetId && !seenIds.has(t.id));
    fresh.forEach((t) => seenIds.add(t.id));
    await onPage(fresh, pages);

    const next = data.next_cursor;
    const finished = !data.has_next_page || !next || fresh.length === 0 || seenCursors.has(next);
    if (finished) return { pages, stoppedEarly: false };
    if (pages >= maxPages) return { pages, stoppedEarly: true };

    seenCursors.add(next);
    cursor = next;
    await sleep(delayMs);
  }
}

module.exports = { parseTweetId, fetchAllReplies };