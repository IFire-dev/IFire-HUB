# AI Hub v2.0.0

Terminal-style dashboard: chat with NVIDIA Build models, a VirusTotal scanner, link tools,
usage stats, background model health checks, and optional Clerk login for a family.

## Run locally (Windows / any OS)
1. Install Node.js 20+ (check: `node -v`).
2. Open the `ai-hub` folder in a terminal (in Cursor: Terminal > New Terminal).
3. `npm install`   (skip if the folder already has `node_modules`)
4. Copy `.env.example` to `.env` and paste your keys:
   `NVIDIA_API_KEY=nvapi-...` (one key covers every model; build.nvidia.com)
   `VT_API_KEY=...` (optional; free key from virustotal.com)
5. `npm start`, then open http://127.0.0.1:3000

Updating an existing install? Keep your `.env` and `node_modules`; copy the new files over.
Old browser-stored chat history can be imported from Settings (button appears if any exists).

## What is where
- **Settings** (top bar): save-history switch, delete saved history, choose what the performance
  tab shows, full-width layout switch, account info.
- **Performance tab** (above every chat): model status, first-token time, total time, speed,
  context used, and more. Timings are measured exactly; token counts are estimates (chars / 4).
- **Model status**: the server sends each model one tiny request at startup and then every
  `HEALTH_INTERVAL_MIN` minutes. Two failures in a row = "down"; 403/404 = "blocked"; 429 = "rate limited".
  These checks may use up some of your NVIDIA allowance: see "health checks today" in the stats and
  check your build.nvidia.com balance after the first day. Set `HEALTH_INTERVAL_MIN=15` to be gentler.
- **Stats** (home page): requests, success rate, speed per model, daily activity, VirusTotal verdicts.
  Stored in `data/stats.json` (counts and timings only, never message text or filenames).
- **VirusTotal**: files are hashed in your browser; only the hash is looked up. Nothing is uploaded
  unless VirusTotal has never seen the file and you press "upload & scan". Free-tier limits are
  enforced (4 requests/min, 500/day, uploads up to 32 MB; hashing up to 256 MB).

## Family use (Clerk login)
See **SETUP-CLERK-CLOUDFLARE.md** (step by step) and **HOSTING.md** (background). Short version: add the two `CLERK_*` keys, `npm install @clerk/express`,
lock sign-ups in the Clerk dashboard, and reach the hub through Tailscale or a Cloudflare Tunnel.
With no Clerk keys the hub stays a single-user local app.

## Cloudflare Workers deployment
This repo includes `wrangler.jsonc` for a Worker deployment. It serves `public/`, runs the Express API on Workers, and stores new user settings and chat history in the `ifire-hub-db` D1 database. Existing local files under `data/` are not uploaded.

Set `CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` as Worker variables/secrets in Cloudflare, along with `NVIDIA_API_KEY` and (if used) `VT_API_KEY`. Set `ADMIN_USER_IDS` after signing in once. Until Clerk keys are set, the Cloudflare page stays locked in setup mode; local `npm start` still uses `.env` as before.

## Add things
- Tools (iframe / new tab): `TOOLS` array at the top of `public/app.js`
- Models: `models.js` (`category` creates the section, `vision:true` enables image attach)
- Kimi K3.1 Pro: set `apiReady: true` once NVIDIA opens its API, and confirm the id.

## Security notes
- Binds to 127.0.0.1; only requests addressed to localhost (plus `ALLOWED_HOSTS`) are answered.
- Every /api route needs a signed-in user when Clerk is on; non-admins get per-person limits.
- Never expose the hub without Clerk (or another login): it proxies your API keys.
