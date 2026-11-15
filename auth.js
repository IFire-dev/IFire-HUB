// auth.js — optional Clerk login.
//
// No Clerk keys in .env  -> "local" mode: no login, one user called "local" (admin).
// Both Clerk keys set    -> "clerk" mode: every /api route needs a signed-in user.
//
// The Clerk SDK is loaded lazily, so local mode works without `npm install @clerk/express`.
const { AsyncLocalStorage } = require('async_hooks');

const MODE = (process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY) ? 'clerk' : 'local';
const list = (v) => new Set(String(v || '').split(',').map((s) => s.trim()).filter(Boolean));
const ADMINS = list(process.env.ADMIN_USER_IDS);      // Clerk user ids (user_...), shown in Settings > Account
const ALLOWED = list(process.env.ALLOWED_USER_IDS);   // optional extra allowlist; empty = any signed-in user
const PARTIES = [...list(process.env.CLERK_AUTHORIZED_PARTIES)]; // optional: origins allowed to mint tokens

const als = new AsyncLocalStorage();
let getAuth = null;

function setup(app) {
  if (MODE !== 'clerk') return;
  let clerk;
  try {
    clerk = require('@clerk/express');
  } catch {
    console.error('\nClerk keys are set in .env, but the SDK is not installed.\nRun:  npm install @clerk/express\n');
    process.exit(1);
  }
  getAuth = clerk.getAuth;
  // Only /api sees Clerk's middleware, so plain page loads never get redirected by Clerk's handshake.
  app.use('/api', clerk.clerkMiddleware(PARTIES.length ? { authorizedParties: PARTIES } : {}));
  if (!ADMINS.size) {
    console.log('Clerk: no ADMIN_USER_IDS set yet. Sign in once, copy your id from Settings > Account into .env, restart.');
  }
}

// Express middleware: attaches req.user = { id, isAdmin } or rejects.
function requireUser(req, res, next) {
  if (MODE === 'local') {
    req.user = { id: 'local', isAdmin: true };
    return als.run({ uid: 'local' }, next);
  }
  let uid = null;
  try { uid = (getAuth(req) || {}).userId || null; } catch { uid = null; }
  if (!uid) return res.status(401).json({ error: 'Sign in required.', signedOut: true });
  const isAdmin = ADMINS.has(uid);
  if (ALLOWED.size && !ALLOWED.has(uid) && !isAdmin) {
    return res.status(403).json({ error: 'This account is not allowed on this hub. Ask the owner to add your id.', notAllowed: true, userId: uid });
  }
  req.user = { id: uid, isAdmin };
  return als.run({ uid }, next);
}

const currentUid = () => (als.getStore() || {}).uid;

module.exports = {
  MODE, setup, requireUser, currentUid,
  publicConfig: () => ({
    mode: MODE,
    clerkPublishableKey: MODE === 'clerk' ? process.env.CLERK_PUBLISHABLE_KEY : null,
  }),
};
