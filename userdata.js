// userdata.js — per-account settings + chat history, stored as one JSON file per account.
// data/users/<id>.json   (the hub owner can read these files — tell your family)
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PERF_KEYS = ['health', 'ttfb', 'total', 'tps', 'ctx', 'tokens', 'avgTtfb', 'session'];
const DEFAULT_PERF = { health: true, ttfb: true, total: true, tps: true, ctx: true, tokens: false, avgTtfb: false, session: false };
const DEFAULT_SETTINGS = { saveHistory: true, fullWidth: true, perf: DEFAULT_PERF };

const MAX_MSGS = 200;
const MAX_CONTENT = 50000;
const MAX_THREAD_BYTES = 2 * 1024 * 1024;

function create(dir, validModelIds) {
  const valid = new Set(validModelIds);
  const locks = new Map();

  const fileFor = (uid) => {
    const safe = /^[A-Za-z0-9_-]{1,80}$/.test(uid)
      ? uid
      : crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 40);
    return path.join(dir, `${safe}.json`);
  };

  async function readRaw(uid) {
    try {
      const j = JSON.parse(await fsp.readFile(fileFor(uid), 'utf8'));
      return { settings: j.settings || {}, history: j.history || {} };
    } catch {
      return { settings: {}, history: {} };
    }
  }

  async function writeRaw(uid, data) {
    await fsp.mkdir(dir, { recursive: true });
    const f = fileFor(uid);
    const tmp = `${f}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, f);
  }

  // Serialise read-modify-write per account so two quick saves can't corrupt each other.
  function update(uid, fn) {
    const prev = locks.get(uid) || Promise.resolve();
    const next = prev.then(async () => {
      const data = await readRaw(uid);
      const out = await fn(data);
      await writeRaw(uid, data);
      return out;
    });
    locks.set(uid, next.catch(() => {}));
    return next;
  }

  const withDefaults = (s) => ({
    ...DEFAULT_SETTINGS,
    ...s,
    perf: { ...DEFAULT_PERF, ...(s && s.perf) },
  });

  function sanitizeSettings(p) {
    const out = {};
    if (!p || typeof p !== 'object') return out;
    if (typeof p.saveHistory === 'boolean') out.saveHistory = p.saveHistory;
    if (typeof p.fullWidth === 'boolean') out.fullWidth = p.fullWidth;
    if (p.perf && typeof p.perf === 'object') {
      out.perf = {};
      for (const k of PERF_KEYS) if (typeof p.perf[k] === 'boolean') out.perf[k] = p.perf[k];
    }
    return out;
  }

  function sanitizeThread(arr) {
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (const m of arr.slice(-MAX_MSGS)) {
      if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') continue;
      const item = { role: m.role, content: m.content.slice(0, MAX_CONTENT) };
      const n = Number(m.imageCount);
      if (Number.isInteger(n) && n > 0 && n <= 10) item.imageCount = n;
      out.push(item);
    }
    return Buffer.byteLength(JSON.stringify(out)) > MAX_THREAD_BYTES ? null : out;
  }

  return {
    isModel: (id) => valid.has(id),
    async getAll(uid) {
      const d = await readRaw(uid);
      return { settings: withDefaults(d.settings), history: d.history };
    },
    mergeSettings: (uid, partial) => update(uid, (d) => {
      const clean = sanitizeSettings(partial);
      d.settings = { ...d.settings, ...clean, perf: { ...(d.settings.perf || {}), ...(clean.perf || {}) } };
      return withDefaults(d.settings);
    }),
    putThread: (uid, modelId, msgs) => update(uid, (d) => {
      const clean = sanitizeThread(msgs);
      if (!clean) return false;
      if (clean.length) d.history[modelId] = clean; else delete d.history[modelId];
      return true;
    }),
    clearHistory: (uid) => update(uid, (d) => { d.history = {}; return true; }),
  };
}

module.exports = { create, PERF_KEYS };
