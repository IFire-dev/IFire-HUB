# AI Hub v1.3.0

Terminal-style dashboard: link/iframe tools + chat with NVIDIA Build models.

## Run locally (Windows / any OS)
1. Install Node.js 20+ (check: `node -v`).
2. Unzip, open the `ai-hub` folder in a terminal (or Cursor: Terminal > New Terminal).
3. `npm install`   (skip if the folder already has `node_modules`)
4. Copy `.env.example` to `.env` (Windows: `copy .env.example .env`) and paste your keys:
   `NVIDIA_API_KEY=nvapi-...`   (one key covers every model; get it at build.nvidia.com)
   `VT_API_KEY=...`             (optional; free key from virustotal.com > profile > API key)
   Updating an existing install? Keep your `.env` and `node_modules`, just add the VT line.
5. `npm start`
6. Open http://127.0.0.1:3000
   Port busy? Set `PORT=3001` in `.env`.

First test: open "Nemotron 3.5 Bolt E4B" and say hi (small and fast).
Any error shows in the chat with the reason (401 bad key, 402/403 not
available to your key, 404 not enabled/retired, 429 rate limit, 504 timeout).

## Start-page question (history)
- yes: chats saved in this browser's localStorage and loaded next time
- no: nothing loaded or written this session (old saved data stays on disk)
- wipe: deletes everything saved
Images are never saved, only a "[n images not saved]" note.

## VirusTotal
Open the VirusTotal card. Drop a file, paste a hash (md5/sha1/sha256) or a URL.
- Files are hashed in your browser; only the hash is looked up. Nothing is uploaded
  unless VirusTotal has never seen the file AND you press "upload & scan".
- Uploading shares the file with VirusTotal and its security partners.
- Free-tier limits are enforced for you: 4 requests/min (requests wait their turn),
  500/day, uploads up to 32 MB, in-browser hashing up to 256 MB.
  Every request, including result polling, counts toward the quota shown in the header.
- No detections is not proof a file is safe.

## Stats
The top of the home page shows usage (requests, success rate, speed per model,
activity per day, VirusTotal verdicts). It is stored in `data/stats.json` on this PC:
model, timings, sizes, counts. Never message text, filenames or files.
"wipe stats" deletes it. Chat history is separate (browser localStorage).

## Add things
- Tools (iframe / new tab): `TOOLS` array at top of `public/app.js`
- Models: `models.js` (`category` creates the section, `vision:true` enables image attach)
- Kimi K3.1 Pro: set `apiReady: true` once NVIDIA opens its API, and confirm the id.

## Security
Binds to 127.0.0.1: only this PC can use your key through the hub.
Do NOT deploy publicly as-is: anyone could spend your key. Add auth first.
"# IFire-HUB" 
