require("dotenv").config({ quiet: true });

const express = require("express");
const session = require("express-session");
const dotenv = require("dotenv");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";
const ENV_PATH = path.join(__dirname, ".env");
const PASSWORD_VERIFY_WINDOW = 5 * 60 * 1000; // 5 minutes to set a new password after confirming the current one

if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
  console.error("Missing ADMIN_PASSWORD or SESSION_SECRET in .env");
  process.exit(1);
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

async function saveAdminPassword(newPassword) {
  const quoted = toEnvValue(newPassword);
  if (!quoted) return false;

  const line = `ADMIN_PASSWORD=${quoted}`;
  const pattern = /^\s*ADMIN_PASSWORD\s*=.*$/m;
  const current = await fs.readFile(ENV_PATH, "utf8");
  const updated = pattern.test(current)
    ? current.replace(pattern, () => line)
    : `${current.trimEnd()}\n${line}\n`;

  // Write to a temp file first, then swap it in, so .env is never left half-written
  const tmpPath = `${ENV_PATH}.tmp`;
  await fs.writeFile(tmpPath, updated);
  await fs.rename(tmpPath, ENV_PATH);

  process.env.ADMIN_PASSWORD = newPassword;
  return true;
}

function renderSettings(res, options = {}, status = 200) {
  res.status(status).render("index", {
    title: "Settings",
    tab: "settings",
    passwordStep: null,
    error: null,
    flash: null,
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
  res.render("index", { title: "Home", tab: "home" });
});

app.get("/history", (req, res) => {
  res.render("index", { title: "History", tab: "history" });
});

app.get("/settings", (req, res) => {
  const flash = req.session.flash || null;
  delete req.session.flash;
  renderSettings(res, { flash });
});

// Step 1 or step 2 of changing the password, depending on whether the current one was confirmed
app.get("/settings/password", (req, res) => {
  renderSettings(res, { passwordStep: isPasswordVerified(req) ? "new" : "verify" });
});

app.post("/settings/password/verify", (req, res) => {
  if (!passwordMatches(req.body.currentPassword || "")) {
    return renderSettings(
      res,
      { passwordStep: "verify", error: "Incorrect password. Try again." },
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

  let error = null;
  if (newPassword !== confirmPassword) error = "The two passwords don't match.";
  else if (newPassword.length < 8) error = "Use at least 8 characters.";

  if (error) {
    return renderSettings(res, { passwordStep: "new", error }, 400);
  }

  const saved = await saveAdminPassword(newPassword);
  if (!saved) {
    return renderSettings(
      res,
      { passwordStep: "new", error: "This password can't be saved. Remove line breaks and try again." },
      400
    );
  }

  delete req.session.passwordVerifiedAt;
  req.session.flash = { type: "success", text: "Password changed. Use the new one next time you sign in." };
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});