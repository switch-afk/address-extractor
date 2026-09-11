require("dotenv").config({ quiet: true });

const express = require("express");
const session = require("express-session");
const dotenv = require("dotenv");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const store = require("./lib/store");
const extractor = require("./lib/extractor");
const exporters = require("./lib/exporters");
const { parseTweetId } = require("./lib/twitter");

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";
const ENV_PATH = path.join(__dirname, ".env");
const PASSWORD_VERIFY_WINDOW = 5 * 60 * 1000; // 5 minutes to set a new password after confirming the current one

if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
  console.error("Missing ADMIN_PASSWORD or SESSION_SECRET in .env");
  process.exit(1);
}

if (!process.env.TWITTERAPI_KEY) {
  console.warn("TWITTERAPI_KEY is not set. Add it in Settings before running an extraction.");
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.set("trust proxy", 1);

app.use(express.static(path.join(__dirname, "public")));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    name: "bm.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
  })
);

// ---------- Helpers ----------

function passwordMatches(input) {
  const a = crypto.createHash("sha256").update(String(input)).digest();
  const b = crypto.createHash("sha256").update(process.env.ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireAuth(req, res, next) {
  if (req.session.isAdmin) return next();
  res.redirect("/login");
}

function isPasswordVerified(req) {
  const at = req.session.passwordVerifiedAt;
  return Boolean(at) && Date.now() - at < PASSWORD_VERIFY_WINDOW;
}

// Wraps the value in quotes that dotenv will read back exactly as typed
function toEnvValue(value) {
  if (/[\r\n]/.test(value)) return null;
  for (const q of ["'", "`", '"']) {
    const quoted = `${q}${value}${q}`;
    if (dotenv.parse(`KEY=${quoted}`).KEY === value) return quoted;
  }
  return null;
}

// Updates (or adds) one line in .env and applies it to the running app right away
async function saveEnvValue(name, value) {
  const quoted = toEnvValue(value);
  if (!quoted) return false;

  const line = `${name}=${quoted}`;
  const pattern = new RegExp(`^\\s*${name}\\s*=.*$`, "m");

  let current = "";
  try {
    current = await fs.readFile(ENV_PATH, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const updated = pattern.test(current)
    ? current.replace(pattern, () => line)
    : `${current.trimEnd()}\n${line}\n`.replace(/^\n/, "");

  // Write to a temp file first, then swap it in, so .env is never left half-written
  const tmpPath = `${ENV_PATH}.tmp`;
  await fs.writeFile(tmpPath, updated);
  await fs.rename(tmpPath, ENV_PATH);

  process.env[name] = value;
  return true;
}

function maskKey(key) {
  if (!key) return null;
  return `${"•".repeat(8)}${key.slice(-4)}`;
}

function renderHome(res, options = {}, status = 200) {
  res.status(status).render("index", {
    title: "Home",
    tab: "home",
    error: null,
    postUrl: "",
    runningId: extractor.getRunningId(),
    hasApiKey: Boolean(process.env.TWITTERAPI_KEY),
    ...options,
  });
}

async function renderSettings(res, options = {}, status = 200) {
  res.status(status).render("index", {
    title: "Settings",
    tab: "settings",
    passwordStep: null,
    passwordError: null,
    editingKey: false,
    keyError: null,
    flash: null,
    maskedKey: maskKey(process.env.TWITTERAPI_KEY),
    extractionCount: await store.count(),
    runningId: extractor.getRunningId(),
    ...options,
  });
}

// ---------- Public routes ----------

app.get("/login", (req, res) => {
  if (req.session.isAdmin) return res.redirect("/");
  res.render("login", { title: "Sign in", error: null });
});

app.post("/login", (req, res, next) => {
  if (!passwordMatches(req.body.password || "")) {
    return res.status(401).render("login", {
      title: "Sign in",
      error: "Incorrect password. Try again.",
    });
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.isAdmin = true;
    req.session.save((err) => {
      if (err) return next(err);
      res.redirect("/");
    });
  });
});

app.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("bm.sid");
    res.redirect("/login");
  });
});

// ---------- Everything below requires login ----------

app.use(requireAuth);

app.get("/", (req, res) => {
  renderHome(res);
});

app.post("/extract", async (req, res) => {
  const postUrl = String(req.body.postUrl || "").trim();

  if (!process.env.TWITTERAPI_KEY) {
    return renderHome(res, { postUrl, error: "Add your twitterapi.io API key in Settings, then try again." }, 400);
  }

  const tweetId = parseTweetId(postUrl);
  if (!tweetId) {
    return renderHome(
      res,
      { postUrl, error: "That isn't an X post link. It should look like https://x.com/username/status/1234567890." },
      400
    );
  }

  if (extractor.getRunningId()) {
    return renderHome(res, { postUrl, error: "Another extraction is still running. Wait for it to finish, then try again." }, 409);
  }

  const record = await extractor.start({ postUrl, tweetId });
  res.redirect(`/history/${record.id}`);
});

app.get("/history", async (req, res) => {
  const extractions = await store.list();
  res.render("index", { title: "History", tab: "history", extractions });
});

app.get("/history/:id", async (req, res, next) => {
  const extraction = await store.get(req.params.id);
  if (!extraction) return next(); // falls through to the 404 page
  res.render("index", {
    title: "Extraction",
    tab: "history",
    content: "extraction",
    extraction,
    columns: exporters.COLUMNS,
  });
});

app.post("/history/:id/stop", async (req, res) => {
  await extractor.stop(req.params.id);
  res.redirect(`/history/${encodeURIComponent(req.params.id)}`);
});

app.get("/history/:id/download", async (req, res, next) => {
  const extraction = await store.get(req.params.id);
  if (!extraction) return next();

  const columns = exporters.pickColumns(req.query.columns);
  const fileName = `wallets-${extraction.tweetId}`;

  if (req.query.format === "xlsx") {
    const buffer = await exporters.toXlsx(extraction, columns);
    res.attachment(`${fileName}.xlsx`);
    return res.send(buffer);
  }

  if (req.query.format === "pdf") {
    res.attachment(`${fileName}.pdf`);
    return exporters.writePdf(extraction, columns, res);
  }

  res.attachment(`${fileName}.csv`);
  res.send(exporters.toCsv(extraction, columns));
});

app.get("/settings", async (req, res) => {
  const flash = req.session.flash || null;
  delete req.session.flash;
  await renderSettings(res, { flash });
});

// ----- Change password -----

// Step 1 or step 2 of changing the password, depending on whether the current one was confirmed
app.get("/settings/password", async (req, res) => {
  await renderSettings(res, { passwordStep: isPasswordVerified(req) ? "new" : "verify" });
});

app.post("/settings/password/verify", async (req, res) => {
  if (!passwordMatches(req.body.currentPassword || "")) {
    return renderSettings(
      res,
      { passwordStep: "verify", passwordError: "Incorrect password. Try again." },
      401
    );
  }
  req.session.passwordVerifiedAt = Date.now();
  res.redirect("/settings/password");
});

app.post("/settings/password", async (req, res) => {
  if (!isPasswordVerified(req)) {
    return res.redirect("/settings/password");
  }

  const newPassword = req.body.newPassword || "";
  const confirmPassword = req.body.confirmPassword || "";

  let passwordError = null;
  if (newPassword !== confirmPassword) passwordError = "The two passwords don't match.";
  else if (newPassword.length < 8) passwordError = "Use at least 8 characters.";

  if (passwordError) {
    return renderSettings(res, { passwordStep: "new", passwordError }, 400);
  }

  const saved = await saveEnvValue("ADMIN_PASSWORD", newPassword);
  if (!saved) {
    return renderSettings(
      res,
      { passwordStep: "new", passwordError: "This password can't be saved. Remove line breaks and try again." },
      400
    );
  }

  delete req.session.passwordVerifiedAt;
  req.session.flash = { text: "Password changed. Use the new one next time you sign in." };
  res.redirect("/settings");
});

// ----- Change twitterapi.io key -----

app.get("/settings/api-key", async (req, res) => {
  await renderSettings(res, { editingKey: true });
});

app.post("/settings/api-key", async (req, res) => {
  const apiKey = String(req.body.apiKey || "").trim();

  let keyError = null;
  if (!apiKey) keyError = "Paste your API key.";
  else if (/\s/.test(apiKey) || apiKey.length > 256) keyError = "That doesn't look like an API key. Copy it again from your twitterapi.io dashboard.";

  if (keyError) {
    return renderSettings(res, { editingKey: true, keyError }, 400);
  }

  const saved = await saveEnvValue("TWITTERAPI_KEY", apiKey);
  if (!saved) {
    return renderSettings(res, { editingKey: true, keyError: "This key can't be saved. Copy it again and retry." }, 400);
  }

  req.session.flash = { text: "API key updated. New extractions will use it." };
  res.redirect("/settings");
});

// ----- Reset data -----

app.post("/settings/reset", async (req, res) => {
  const runningId = extractor.getRunningId();
  if (runningId) await extractor.stop(runningId);

  await store.clearAll();
  req.session.flash = { text: "All saved extractions were deleted." };
  res.redirect("/settings");
});

if (!isProduction) {
  app.get("/test-500", () => {
    throw new Error("Test error");
  });
}

// 404
app.use((req, res) => {
  res.status(404).render("404", { title: "Page not found" });
});

// 500
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).render("500", { title: "Something went wrong" });
});

store.markInterrupted().catch((err) => console.error("Couldn't check old extractions:", err));

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});