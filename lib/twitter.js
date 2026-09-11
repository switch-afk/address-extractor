const API_BASE = "https://api.twitterapi.io";
const MAX_ATTEMPTS = 5;
const EMPTY_PAGE_LIMIT = 3; // stop a source after this many empty pages in a row

class FatalApiError extends Error {}

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

// Waits, but wakes up immediately (with an error) if the extraction is stopped
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function tweetTimeSeconds(tweet) {
  const ms = Date.parse(tweet?.createdAt || "");
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

async function apiGet(path, params, ctx) {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: { "x-api-key": ctx.apiKey },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]),
      });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      if (attempt === MAX_ATTEMPTS) throw new Error(`Couldn't reach twitterapi.io (${err.message}).`);
      await sleep(3000 * attempt, ctx.signal);
      continue;
    }
    ctx.onRequest?.();

    // Rate limited or temporary server problem: wait and retry
    if (res.status === 429 || res.status >= 500) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`twitterapi.io kept returning ${res.status}. Try again in a few minutes.`);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 5000 * attempt, ctx.signal);
      continue;
    }

    const body = await res.json().catch(() => null);

    if (res.status === 401 || res.status === 403) {
      throw new FatalApiError("twitterapi.io rejected the API key. Check TWITTERAPI_KEY in .env.");
    }
    if (res.status === 402) {
      throw new FatalApiError("Your twitterapi.io account is out of credits. Top up, then run the extraction again.");
    }
    if (!res.ok || !body || body.status === "error") {
      throw new Error(`twitterapi.io error: ${body?.message || body?.msg || `HTTP ${res.status}`}`);
    }
    return body;
  }
}

// Walks every page of one source. Returns how many new tweets it found and the oldest tweet time seen.
async function paginate(path, params, ctx) {
  const seenCursors = new Set();
  let cursor = "";
  let emptyStreak = 0;
  let oldest = null;
  let newCount = 0;

  while (true) {
    const data = await apiGet(path, { ...params, cursor }, ctx);
    const tweets = data.tweets || data.replies || [];

    for (const tweet of tweets) {
      const time = tweetTimeSeconds(tweet);
      if (time !== null && (oldest === null || time < oldest)) oldest = time;
    }
    newCount += await ctx.onTweets(tweets);

    emptyStreak = tweets.length ? 0 : emptyStreak + 1;
    const next = data.next_cursor;
    if (!data.has_next_page || !next || seenCursors.has(next) || emptyStreak >= EMPTY_PAGE_LIMIT) break;

    seenCursors.add(next);
    cursor = next;
    await sleep(ctx.delayMs, ctx.signal);
  }

  return { newCount, oldest };
}

// Some sources stop after a certain depth. For those, start again from just before the
// oldest reply seen so far, and repeat until we reach the post itself or nothing older comes back.
async function paginateByTime(path, buildParams, ctx, postTime) {
  let until = null;

  while (true) {
    const { oldest } = await paginate(path, buildParams(until), ctx);
    if (oldest === null) return;
    if (postTime !== null && oldest <= postTime) return;

    const nextUntil = oldest + 1;
    if (until !== null && nextUntil >= until) return;
    until = nextUntil;
    await sleep(ctx.delayMs, ctx.signal);
  }
}

async function getTweet(tweetId, ctx) {
  try {
    const data = await apiGet("/twitter/tweets", { tweet_ids: tweetId }, ctx);
    return (data.tweets || [])[0] || null;
  } catch (err) {
    if (ctx.signal.aborted || err instanceof FatalApiError) throw err;
    return null;
  }
}

/*
  Collects replies from several twitterapi.io sources and lets the caller merge them.
  Each source misses some replies on busy posts, so together they get as close to the full list as possible.

  options:
    apiKey, delayMs, signal
    onPost(tweet)       - called once with the original post (reply count etc.), if available
    onPhase(label)      - called when a new source starts
    onTweets(tweets)    - called with each page; must return how many were new
    onWarning(message)  - called when one source fails but the others can continue
    onRequest()         - called after every API request
*/
async function fetchAllReplies(tweetId, options) {
  const ctx = { ...options };

  const post = await getTweet(tweetId, ctx);
  if (post) await options.onPost?.(post);
  const postTime = tweetTimeSeconds(post);

  const sources = [
    {
      label: "Searching the whole conversation",
      run: () =>
        paginateByTime(
          "/twitter/tweet/advanced_search",
          (until) => ({
            query: `conversation_id:${tweetId}${until ? ` until_time:${until}` : ""}`,
            queryType: "Latest",
          }),
          ctx,
          postTime
        ),
    },
    {
      label: "Reading the full reply list",
      run: () =>
        paginateByTime("/twitter/tweet/replies", (until) => ({ tweetId, untilTime: until }), ctx, postTime),
    },
    {
      label: "Reading replies, newest first",
      run: () => paginate("/twitter/tweet/replies/v2", { tweetId, queryType: "Latest" }, ctx),
    },
    {
      label: "Reading replies, most relevant first",
      run: () => paginate("/twitter/tweet/replies/v2", { tweetId, queryType: "Relevance" }, ctx),
    },
    {
      label: "Reading replies, most liked first",
      run: () => paginate("/twitter/tweet/replies/v2", { tweetId, queryType: "Likes" }, ctx),
    },
  ];

  let failures = 0;
  let lastError = null;

  for (const source of sources) {
    await options.onPhase?.(source.label);
    try {
      await source.run();
    } catch (err) {
      if (ctx.signal.aborted || err instanceof FatalApiError) throw err;
      failures++;
      lastError = err;
      await options.onWarning?.(`${source.label}: ${err.message}`);
    }
    await sleep(ctx.delayMs, ctx.signal);
  }

  if (failures === sources.length) throw lastError;
}

module.exports = { parseTweetId, fetchAllReplies };