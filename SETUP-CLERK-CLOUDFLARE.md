# AI Hub: family setup (Clerk login + Cloudflare Tunnel)

Do the parts in order. Each part works on its own, so you can stop after any of them.

You will end up with: https://hub.yourdomain.com  ->  Cloudflare  ->  tunnel  ->  your PC (port 3000)
and a Clerk sign-in in front of everything.

What you need before starting
- The hub running on your Windows PC (Node.js 20+, `npm install` done)
- An NVIDIA key (and optionally a VirusTotal key) in `.env`
- A Clerk account (free) at clerk.com
- A Cloudflare account (free) AND a domain added to Cloudflare. Cloudflare requires a domain on
  Cloudflare to publish an application. Registering a domain costs a few dollars to ~$15 a year.
  No domain? Use Tailscale instead (end of this file).

---------------------------------------------------------------------------------

## PART 0: Test the hub locally first (5 minutes, no accounts needed)

1. Open the hub folder in a terminal (Cursor: Terminal > New Terminal).
2. `npm install`
3. `copy .env.example .env`, open `.env`, set `NVIDIA_API_KEY=nvapi-...`
4. `npm start`
5. Open http://127.0.0.1:3000 and send one message to "Nemotron 3.5 Bolt E4B".

If that works, continue. If not, fix it here: Clerk and Cloudflare add nothing to this part.

---------------------------------------------------------------------------------

## PART 1: Clerk (login)

### 1.1 Create the Clerk application
1. Go to clerk.com, sign up, and choose **Create application**.
2. Name it "AI Hub". Under sign-in options enable **Email** (add Google if your family prefers it).
3. Create it. Clerk shows you two keys:
   - **Publishable key** (starts with `pk_test_`)
   - **Secret key** (starts with `sk_test_`)
   You can find them again later on the dashboard's **API keys** page.

### 1.2 Put the keys in `.env`
Open `.env` and fill in:

    CLERK_PUBLISHABLE_KEY=pk_test_xxxxxxxx
    CLERK_SECRET_KEY=sk_test_xxxxxxxx

The secret key stays in `.env` on your PC. Never paste it into a chat, a repo or a screenshot.

### 1.3 Install the Clerk server package
In the hub folder:

    npm install @clerk/express

### 1.4 LOCK SIGN-UPS (do this before the hub is reachable from the internet)
Without this, any stranger who finds your address could create an account and spend your
NVIDIA and VirusTotal keys.
1. In the Clerk dashboard open the **Restrictions** area (under User & authentication / configure).
2. Turn sign-up mode to **Restricted** (invite-only). If you only see an **Allowlist**
   option instead: enabling it with no entries blocks everyone, then add your family's email
   addresses. [Menu names change; look for "Restricted", "Invitation only" or "Allowlist".]
3. Invite each family member (dashboard > **Users** > **Invite**), including yourself.
   They get an email, create their account, and can sign in.

### 1.5 First sign-in and becoming the owner
1. Restart the hub (`Ctrl+C`, then `npm start`). The startup log must say `Login: Clerk`.
2. Open http://127.0.0.1:3000. You should see the sign-in screen. Sign in.
3. Click **settings** (top right) > **Account**. Copy your id (looks like `user_2abc...`).
4. Put it in `.env`:

       ADMIN_USER_IDS=user_2abc...

5. Restart the hub. Settings now says "owner (admin)". As owner you see everyone's stats and can wipe them.

### 1.6 Optional second lock
Put every family member's id (they can copy it from their own Settings > Account) in
`.env`: `ALLOWED_USER_IDS=user_aaa,user_bbb,user_ccc`. Only those people (plus admins) get in,
even if Clerk's restriction is ever misconfigured. If someone signs in without being on the
list, the hub shows them their id so they can send it to you.

### Good to know about Clerk
- A Clerk *development* instance (the `pk_test_` keys) works from any web address, including
  your Cloudflare address, and is fine for a small private family hub. Clerk labels it "not for
  production" and shows a small development notice. Moving to a *production* instance later needs
  a domain you own plus DNS records; your hub code does not change, only the two keys.
- The sign-in screen loads from Clerk's servers, so signing in needs an internet connection.

---------------------------------------------------------------------------------

## PART 2: Cloudflare Tunnel (so the family can reach it)

The tunnel makes an outbound connection from your PC to Cloudflare. You do NOT open any router
port. The hub keeps listening only on your own PC (127.0.0.1).

### 2.1 Add your domain to Cloudflare (skip if already done)
1. Cloudflare dashboard > **Add a domain**, enter it, choose the Free plan.
2. Cloudflare shows two name servers. At your domain registrar, replace the existing name
   servers with those two. Wait until Cloudflare says the domain is **Active** (minutes to hours).

### 2.2 Create the tunnel
1. Cloudflare dashboard > **Networking** > **Tunnels** > **Create Tunnel**.
2. Name it `ai-hub` and create it.
3. Under **Setup Environment** choose **Windows** and your architecture (usually 64-bit).
4. The page shows an install command containing a long token. Do this on the hub PC:
   - Download and install `cloudflared` (the page links to it).
   - Open **Command Prompt as administrator**.
   - Run the command shown, which looks like: `cloudflared.exe service install <YOUR_TOKEN>`
5. Within a few seconds the dashboard shows the tunnel as connected (**Healthy**). Click **Continue**.
   The token is a secret: anyone with it can run your tunnel. Don't share it.

`cloudflared` is now a Windows service: it starts by itself when the PC boots.

### 2.3 Point a web address at the hub
1. In your tunnel, open **Routes** > **Add route** > **Published application**.
2. **Hostname**: type a subdomain such as `hub` and pick your domain from the list
   (result: `hub.yourdomain.com`).
3. **Service URL**: `http://localhost:3000`   (use http, not https)
4. Save with **Add route**.

### 2.4 Tell the hub about its new address
Open `.env` and add (use your real address, no https://, no slash):

    ALLOWED_HOSTS=hub.yourdomain.com

Restart the hub. Without this the hub rejects the new address with "Host not allowed" (that is
a security feature that blocks DNS-rebinding attacks).

### 2.5 Test it
1. On your phone, switch Wi-Fi OFF (so you use mobile data) and open https://hub.yourdomain.com
2. You should see the Clerk sign-in. Sign in, send a message to Nemotron.
3. Have one family member try with their own account and device.

### Optional extra hardening
If you ever see tokens accepted from places they shouldn't be, add
`CLERK_AUTHORIZED_PARTIES=https://hub.yourdomain.com` to `.env` and restart. Test sign-in right
after: if it breaks, remove the line (it is only an extra layer).

---------------------------------------------------------------------------------

## PART 3: Keep the hub running all the time

The tunnel already starts with Windows. The hub itself needs the same. Easiest way: Task Scheduler.

1. Windows search > **Task Scheduler** > **Create Task** (not "Basic Task").
2. General: name `AI Hub`. Tick **Run whether user is logged on or not**.
3. Triggers > New > **At startup**.
4. Actions > New: Program `node`, arguments `server.js`, **Start in**: the full path of your hub
   folder (for example `C:\Users\you\ai-hub`). If `node` isn't found, use its full path
   (`C:\Program Files\nodejs\node.exe`).
5. Settings: tick **If the task fails, restart every 1 minute**. Save (it asks for your Windows password).
6. Right-click the task > **Run** and check https://hub.yourdomain.com works.

Also in Windows Power settings, set the PC to **never sleep** while plugged in, otherwise the hub
and the model health checks stop at night.

To update the hub later: stop the task, copy the new files over (keep `.env`, `node_modules`
and `data`), start the task.

---------------------------------------------------------------------------------

## PART 4: Tell your family (honest version)
- Their chats are saved as plain files on your PC (`data/users/`) and you could read them.
  They can turn saving off in Settings and delete saved chats.
- Messages are sent to NVIDIA's models. Files uploaded in the VirusTotal tool go to VirusTotal.
- Limits protect the shared free quota: 10 messages a minute and 60 VirusTotal requests a day each.
- Your NVIDIA free allowance is shared by everyone, and the hub's background model checks use a
  little of it too.

---------------------------------------------------------------------------------

## Troubleshooting

| What you see | Likely cause | Fix |
|---|---|---|
| "Host ... is not allowed" | address not in `ALLOWED_HOSTS` | add it, restart the hub |
| Cloudflare error 502/1033 page | hub or tunnel not running | start the hub task; check the tunnel shows Healthy |
| "Could not load the sign-in" | no internet, or Clerk blocked | check connection, press retry |
| Hub says "Clerk keys are set ... SDK is not installed" | missing package | `npm install @clerk/express` |
| Signed in but "not allowed on this hub" | id not in `ALLOWED_USER_IDS` | add the id shown on screen, restart |
| Signed in, hub keeps reloading to the sign-in | token rejected | check both Clerk keys come from the SAME Clerk app; remove `CLERK_AUTHORIZED_PARTIES` if set |
| Everyone is "member", nobody is owner | `ADMIN_USER_IDS` empty/wrong | copy id from Settings > Account |
| Model card says "blocked (403)" | key can't use that model | normal for credit-limited models |
| Model card says "down" | model not answering twice in a row | try "recheck" in the chat, wait, or use another model |

If something fails, send me: the exact message on screen, and the hub's startup log (the first
5 lines you see after `npm start`). Never send secret keys or the tunnel token.

---------------------------------------------------------------------------------

## ALTERNATIVE: Tailscale (no domain, nothing public)
1. Install Tailscale on the hub PC and on every family phone/PC; sign everyone into the same
   "tailnet" (invite them from the Tailscale admin page). Check Tailscale's current free-plan limits for your family size.
2. In the Tailscale admin console enable **HTTPS certificates**.
3. On the hub PC run `tailscale serve --bg 3000`. It prints an address like
   `https://pc-name.tailnet-name.ts.net`.
4. Put that name (no https://) in `ALLOWED_HOSTS` in `.env`, restart the hub.
5. Family opens that address while Tailscale is on. Clerk still handles who gets in and keeps
   histories separate. Skip Part 2.
