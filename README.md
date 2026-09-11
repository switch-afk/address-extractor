# address-extractor

Paste a link to an X (Twitter) post and get back every wallet address people posted in the replies, along with who posted it. Results are saved and can be downloaded as CSV, Excel or PDF.

Built with Node.js, Express, EJS and Tailwind CSS. Reply data comes from [twitterapi.io](https://twitterapi.io).

## What it does

- Fetches replies to a post from five different twitterapi.io sources and merges them, so busy posts return far more replies than any single endpoint gives on its own
- Finds EVM (Ethereum, BSC, Polygon…), Solana, Bitcoin and Tron addresses, including ones hidden inside links
- Validates every address (checksums and lengths), so transaction hashes and typos are skipped
- Flags an address posted by more than one account, which is a sign of multi-account farming
- Shows each person's profile picture, display name and @username next to their address
- Runs in the background with live progress and a Stop button
- Downloads results with your choice of columns, as CSV, Excel or PDF
- Whole site sits behind an admin password

## Requirements

- Node.js 20 or newer
- A [twitterapi.io](https://twitterapi.io/dashboard) account and API key (sign-up is free and includes trial credit)

## Setup

```bash
git clone https://github.com/switch-afk/address-extractor.git
cd address-extractor
npm install
```

`npm install` also downloads the fonts used for PDF exports (about 22 MB) into a `fonts/` folder. If that step fails, the app still works; run `npm run fonts` later to retry.

Create your `.env` file:

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Open `.env` and fill it in:

```
ADMIN_PASSWORD=a-password-you-choose
SESSION_SECRET=paste-the-generated-string-here
TWITTERAPI_KEY=your-twitterapi-io-key
TWITTERAPI_DELAY_MS=300
```

`SESSION_SECRET` should be the random string you just generated, and it signs your login cookie, so keep it private. `TWITTERAPI_KEY` can also be added later from the Settings page. `TWITTERAPI_DELAY_MS` is the wait between API requests; the free twitterapi.io tier allows only one request every 5 seconds, so use `5000` until you add credits.

`.env` is never committed, so each machine you deploy to needs its own.

## Running it

```bash
npm run dev
```

Open http://localhost:3000 and sign in with your `ADMIN_PASSWORD`. In GitHub Codespaces, click "Open in Browser" on the port 3000 notification, or use the globe icon in the Ports tab.

`npm run dev` rebuilds Tailwind CSS and restarts the server automatically as you edit. Press Ctrl + C to stop.

For production:

```bash
npm run build:css
npm start
```

## How to use it

1. **Home** — paste an X post link (`https://x.com/username/status/1234567890`) and click Extract.
2. You land on a progress page that updates itself. It shows which source is being read and counts replies as they come in. Addresses appear as they're found, and Stop keeps whatever was found so far.
3. When it's done, click **Download**, tick the columns you want, pick CSV, Excel or PDF, and download.
4. **History** lists every past extraction. Click View to reopen one and download it again.

### Why the reply count is lower than X shows

X's reply counter includes replies it hides behind "Show probable spam", replies that were deleted, and replies from accounts that are suspended or protected. None of those can be fetched through the API. On giveaway-style posts with hundreds of near-identical replies, X's spam filter hides a large share of them, so the fetched count being 30–40% below X's number is normal and not a bug.

## Settings

- **Password** — change the admin password. You confirm the current one first, then type the new one twice. The new password is written to `.env` and takes effect immediately.
- **twitterapi.io API key** — shows the current key masked and lets you paste a new one. No need to enter the old key.
- **Reset data** — deletes every saved extraction after a confirmation. Your password and API key are kept. If an extraction is running, it's stopped first.

## Cost

twitterapi.io charges per tweet returned, roughly $0.15 per 1,000 tweets. Because replies are gathered from several sources and merged, expect around $0.50–0.75 per 1,000 replies on a post. Credits are bought in advance and never expire.

## Project layout

```
address-extractor/
├── app.js                     Express server, routes, sessions, auth
├── lib/
│   ├── twitter.js             twitterapi.io client, link parsing, reply paging
│   ├── wallets.js             finds and validates wallet addresses in text
│   ├── extractor.js           runs an extraction in the background
│   ├── store.js               saves extractions as JSON files
│   └── exporters.js           CSV, Excel and PDF output
├── scripts/
│   └── download-fonts.js      fetches the PDF fonts (runs after npm install)
├── views/
│   ├── index.ejs              shared layout with the tab bar
│   ├── login.ejs, 404.ejs, 500.ejs
│   ├── partials/              head tag, status badge
│   └── tabs/                  home, history, extraction, settings
├── src/input.css              Tailwind source
├── public/css/style.css       generated stylesheet (committed)
├── data/extractions/          saved results (ignored by git)
└── fonts/                     PDF fonts (ignored by git)
```

## Adding a new tab

1. Add an entry to the `tabs` array in `views/index.ejs`.
2. Add a route in `app.js` that renders `index` with `tab: "yourtab"`.
3. Create `views/tabs/yourtab.ejs`.

## Notes and limits

- Only one extraction runs at a time.
- Saving `app.js` or anything in `lib/` restarts the server and cancels a running extraction, which is then marked Failed with its results kept. Editing `.ejs` files is safe.
- Sessions are held in memory, so a server restart signs you out.
- Addresses inside images can't be read, and neither can replies X hides from logged-out viewers.
- ENS names (`name.eth`) are not collected.

## Deploying

On a server, set `NODE_ENV=production` so session cookies are marked secure, and run the app behind HTTPS. Create a fresh `.env` on that machine with its own `SESSION_SECRET` and password. Run `npm run build:css` as part of your deploy, and use a process manager such as `pm2` or a systemd service to keep `npm start` running.

Back up the `data/` folder if you want to keep past extractions, since it holds all saved results.