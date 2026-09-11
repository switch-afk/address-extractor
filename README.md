# address-extractor

Paste a link to an X (Twitter) post and get back every wallet address people posted in the replies, along with who posted it. Results are saved and can be downloaded as CSV, Excel or PDF.

Node.js + Express + EJS + Tailwind CSS. Reply data comes from [twitterapi.io](https://twitterapi.io).

## What it does

- Merges replies from five twitterapi.io sources, so busy posts return far more replies than any single endpoint gives
- Finds EVM, Solana, Bitcoin and Tron addresses, including ones inside links
- Validates every address, so transaction hashes and typos are skipped
- Flags an address posted by more than one account
- Shows profile picture, display name and @username next to each address
- Runs in the background with live progress and a Stop button
- Download with your choice of columns as CSV, Excel or PDF
- Whole site sits behind an admin password

## Setup

Needs Node.js 20+ and a [twitterapi.io](https://twitterapi.io/dashboard) API key.

```bash
git clone https://github.com/switch-afk/address-extractor.git
cd address-extractor
npm install
cp .env.example .env
```

Generate a session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Open `.env` and fill in the three blanks:

```
ADMIN_PASSWORD=a-password-you-choose
SESSION_SECRET=paste-the-generated-string-here
TWITTERAPI_KEY=your-twitterapi-io-key
TWITTERAPI_DELAY_MS=300
```

Set `TWITTERAPI_DELAY_MS=5000` if you're on the free twitterapi.io tier, which allows one request every 5 seconds.

## Start with pm2

```bash
npm install -g pm2
npm run build:css
pm2 start npm --name address-extractor -- start
pm2 save
pm2 startup
```

`pm2 startup` prints one command to copy, paste and run, which makes the app come back after a reboot.

Open http://localhost:3000 and sign in with your `ADMIN_PASSWORD`.

Useful commands:

```bash
pm2 logs address-extractor
pm2 restart address-extractor
pm2 stop address-extractor
```

Restart after editing `.env`, since the app reads it at startup. Changing the password or API key from Settings applies immediately without a restart.

For development instead of pm2, use `npm run dev`, which rebuilds CSS and restarts on file changes.

## How to use it

1. **Home** — paste an X post link (`https://x.com/username/status/1234567890`) and click Extract.
2. The progress page updates itself and shows addresses as they're found. Stop keeps whatever was found so far.
3. Click **Download**, tick the columns you want, pick CSV, Excel or PDF.
4. **History** lists past extractions. Click View to reopen and download again.

### Why the reply count is lower than X shows

X's counter includes replies hidden behind "Show probable spam", deleted replies, and replies from suspended or protected accounts. None of those can be fetched through the API. On giveaway posts with hundreds of near-identical replies, the fetched count being 30–40% below X's number is normal.

## Settings

- **Password** — confirm the current one, then set a new one. Written to `.env`.
- **twitterapi.io API key** — shows the current key masked and accepts a new one. The old key isn't needed.
- **Reset data** — deletes all saved extractions after a confirmation. Password and API key are kept.

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
├── scripts/download-fonts.js  fetches PDF fonts (runs after npm install)
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

## Notes and limits

- One extraction runs at a time.
- Restarting the server cancels a running extraction; it's marked Failed with results kept.
- Sessions are held in memory, so a restart signs you out.
- Addresses inside images can't be read, and neither can replies X hides from logged-out viewers.
- ENS names (`name.eth`) are not collected.
- Behind HTTPS, set `NODE_ENV=production` so session cookies are marked secure.
- Back up `data/` to keep past extractions.