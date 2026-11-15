# Running the hub for your family

The hub has two modes, chosen only by what is in `.env`:

| mode | when | who can use it |
|------|------|----------------|
| local | no Clerk keys | anyone at this PC; no login; one history file (`data/users/local.json`) |
| clerk | both `CLERK_*` keys set | only signed-in people; each gets their own history, settings and stats |

You can run local mode first, test everything, and add Clerk later without losing anything.

## 1. Clerk setup (about 10 minutes)
1. Create an application at clerk.com. Enable the sign-in methods you want (email is enough).
2. API keys page: copy the **publishable key** and **secret key** into `.env`
   (`CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`).
3. **Lock sign-ups.** In the Clerk dashboard open the restrictions / sign-up settings and make
   the app invite-only (or use the allowlist), then invite each family member.
   Without this, anyone who can reach the hub could create an account and spend your NVIDIA
   and VirusTotal keys. Clerk's docs: clerk.com/docs/guides/secure/restricting-access
4. In the hub folder run `npm install @clerk/express`, then `npm start`.
5. Open the hub, sign in, open **Settings > Account**, copy your id, put it in
   `ADMIN_USER_IDS` in `.env`, restart. You are now the owner (you see everyone's stats and can
   wipe them; other people only see their own).
6. Optional second lock: put every family member's id in `ALLOWED_USER_IDS`.

Development vs production instance: a Clerk *development* instance works from any origin
(localhost, a Tailscale name, a tunnel) and is fine for a small private family hub, but Clerk
calls it "not for production" and shows a development banner. A *production* instance needs a
domain you own plus DNS records.

## 2. How family members reach it
The hub listens on 127.0.0.1 only. Do not open a router port. Pick one:

**A. Tailscale (private, no public exposure, no domain needed)**
Install Tailscale on the hub PC and on each family device, then on the hub PC run
`tailscale serve --bg 3000` (needs HTTPS enabled in the Tailscale admin console). Family opens
the `https://<pc-name>.<tailnet>.ts.net` address. Put that host name in `ALLOWED_HOSTS`.
Check Tailscale's current free-plan user/device limits for your family size.

**B. Cloudflare Tunnel (a normal public https address)**
Needs a domain on Cloudflare. Run `cloudflared` on the hub PC pointing the tunnel at
`http://127.0.0.1:3000` (install it as a service so it survives reboots). Put the public host
name in `ALLOWED_HOSTS`. Because this is internet-facing, step 3 of the Clerk setup is mandatory.

Not recommended: Render/other free hosts. Free instances sleep (so the background health checks
stop) and many have disks that reset, which would erase `data/`.

## 3. Things worth telling your family
- Their chat history is stored as a plain file on your PC (`data/users/<id>.json`) and you can read it.
  Each person can switch saving off in Settings and delete what is saved.
- Messages go to NVIDIA's API, and anything uploaded in the VirusTotal tool goes to VirusTotal.
- Limits keep one person from using up the shared free quota: `USER_CHAT_PER_MIN` messages a
  minute and `USER_VT_PER_DAY` VirusTotal requests a day (the owner is exempt).

## 4. Keep it running
The hub must stay running for the model checks and for family access. On Windows you can run it
with a tool such as NSSM or Task Scheduler ("at startup", `node server.js` in the hub folder), or
`npm install -g pm2` then `pm2 start server.js --name ai-hub` and `pm2 save`.

## 5. Back up
Copy the `data/` folder. It holds `stats.json` and `users/`.
