// server.js — AI Hub: static files + proxies to NVIDIA NIM and VirusTotal + local stats.
// API keys live only here (from .env); the browser never sees them.
const express = require('express');
const path = require('path');
const fs = require('fs');
const MODELS = require('./models');

// ---- tiny .env loader (no extra dependency) ----
try {
  const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch { /* no .env — fine, features that need keys will say so */ }

const KEY = process.env.NVIDIA_API_KEY || '';
const VT_KEY = process.env.VT_API_KEY || '';
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const NIM_URL = process.env.NIM_URL || 'https://integrate.api.nvidia.com/v1/chat/completions';
const VT_BASE = process.env.VT_BASE || 'https://www.virustotal.com/api/v3';
const HEADER_TIMEOUT_MS = 45000;
const VT_PER_MIN = Number(process.env.VT_PER_MIN) || 4;     // free tier: 4 requests / minute
const VT_DAILY = 500;                                       // free tier: 500 requests / day
const VT_MAX_UPLOAD = 32 * 1024 * 1024;                     // free tier direct upload cap
const MAX_EVENTS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayKey = (d = new Date()) => d.toLocaleDateString('sv'); // local YYYY-MM-DD

// =====================================================================
// Local stats store (metadata only — never message text, filenames or files)
// =====================================================================
const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
let stats = { chat: [], vt: [], vtDaily: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  stats = { chat: loaded.chat || [], vt: loaded.vt || [], vtDaily: loaded.vtDaily || {} };
} catch { /* first run */ }

let saveTimer = null;
function flushStats() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stats));
    fs.renameSync(tmp, STATS_FILE);
  } catch (e) { console.warn('stats save failed:', e.message); }
}
function persistSoon() { if (!saveTimer) saveTimer = setTimeout(flushStats, 1500); }
function pushEvent(list, ev) {
  list.push(ev);
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
  persistSoon();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushStats(); process.exit(0); });

const recordChat = (e) => pushEvent(stats.chat, { ts: Date.now(), ...e });
const recordVt = (kind, extra = {}) => pushEvent(stats.vt, { ts: Date.now(), kind, ...extra });

// =====================================================================
const app = express();
app.use(express.json({ limit: '25mb' })); // chat images arrive as base64

// Only answer requests addressed to localhost (blocks DNS-rebinding tricks against your keys).
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]',
  ...(process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
app.use('/api', (req, res, next) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: 'Host not allowed.' });
  next();
});

// =====================================================================
// Models + chat (NVIDIA NIM)
// =====================================================================
app.get('/api/models', (req, res) => {
  res.json({
    keyConfigured: Boolean(KEY),
    models: MODELS.map(({ id, name, category, tagline, ctx, apiReady, vision, note, playground }) =>
      ({ id, name, category, tagline, ctx, apiReady, vision: Boolean(vision), note, playground })),
  });
});

function explain(status) {
  switch (status) {
    case 401: return 'NVIDIA rejected the API key (401). Check NVIDIA_API_KEY in .env and restart.';
    case 402: return 'No API credits for this model on your key (402).';
    case 403: return 'This model is not available to your key/account (403) — likely paid-tier or not enabled.';
    case 404: return 'NVIDIA says this model/endpoint was not found (404) — it may be retired or not enabled for your account.';
    case 410: return 'This model has been retired by NVIDIA (410).';
    case 422: return 'NVIDIA rejected the request format (422).';
    case 429: return 'Rate limit hit (429). Wait a bit and try again.';
    default:  return `NVIDIA returned an error (${status}).`;
  }
}

app.post('/api/chat', async (req, res) => {
  const { model, messages } = req.body || {};
  const m = MODELS.find((x) => x.id === model);
  if (!m) return res.status(400).json({ error: 'Unknown model.' });
  if (!m.apiReady) return res.status(409).json({ error: 'API is not open for this model yet (preview only).' });
  if (!KEY) return res.status(500).json({ error: 'NVIDIA_API_KEY is missing. Put it in .env and restart the server.' });

  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100) {
    return res.status(400).json({ error: 'Bad messages array.' });
  }
  const clean = [];
  let imageCount = 0;
  let charsIn = 0;
  const IMG_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
  for (const msg of messages) {
    if (!msg || !['user', 'assistant', 'system'].includes(msg.role)) {
      return res.status(400).json({ error: 'Bad message.' });
    }
    if (typeof msg.content === 'string') {
      if (msg.content.length > 50000) return res.status(400).json({ error: 'Message too long.' });
      charsIn += msg.content.length;
      clean.push({ role: msg.role, content: msg.content });
      continue;
    }
    // multimodal: array of {type:'text'|'image_url'}; user turns only, vision models only
    if (!Array.isArray(msg.content) || msg.role !== 'user' || !m.vision) {
      return res.status(400).json({ error: 'Images are not supported for this model.' });
    }
    const parts = [];
    for (const part of msg.content) {
      if (part && part.type === 'text' && typeof part.text === 'string' && part.text.length <= 50000) {
        charsIn += part.text.length;
        parts.push({ type: 'text', text: part.text });
      } else if (part && part.type === 'image_url' && part.image_url &&
                 typeof part.image_url.url === 'string' &&
                 part.image_url.url.length <= 7_000_000 && IMG_RE.test(part.image_url.url)) {
        imageCount += 1;
        parts.push({ type: 'image_url', image_url: { url: part.image_url.url } });
      } else {
        return res.status(400).json({ error: 'Bad image or text part.' });
      }
    }
    clean.push({ role: 'user', content: parts });
  }
  if (imageCount > 4) return res.status(400).json({ error: 'Max 4 images per request.' });

  const t0 = Date.now();
  const base = { model: m.id, charsIn, images: imageCount };
  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());           // client left or stopped -> stop upstream
  const timer = setTimeout(() => ctrl.abort(), HEADER_TIMEOUT_MS);

  let up;
  try {
    up = await fetch(NIM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ model: m.id, messages: clean, stream: true, ...m.defaults, ...(m.extra || {}) }),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    if (res.writableEnded || res.destroyed) {
      recordChat({ ...base, ok: false, aborted: true, status: 0, total: Date.now() - t0 });
      return;
    }
    recordChat({ ...base, ok: false, status: 504, total: Date.now() - t0 });
    return res.status(504).json({
      error: `No response from NVIDIA within ${HEADER_TIMEOUT_MS / 1000}s. The model may be overloaded, cold, or not enabled for your key.`,
    });
  }
  clearTimeout(timer);

  if (!up.ok) {
    const detail = (await up.text().catch(() => '')).slice(0, 400);
    recordChat({ ...base, ok: false, status: up.status, total: Date.now() - t0 });
    return res.status(up.status).json({ error: explain(up.status), detail });
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  // Pipe through unchanged, but peek at the stream to measure speed and output size.
  let ttfb = null, charsOut = 0, tokensOut = null, sbuf = '', broke = false;
  const dec = new TextDecoder();
  try {
    for await (const chunk of up.body) {
      if (ttfb === null) ttfb = Date.now() - t0;
      res.write(chunk);
      sbuf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = sbuf.indexOf('\n')) >= 0) {
        const line = sbuf.slice(0, i).trim();
        sbuf = sbuf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try {
          const j = JSON.parse(d);
          const dl = j.choices && j.choices[0] && j.choices[0].delta;
          if (dl) charsOut += (dl.content || '').length + (dl.reasoning_content || dl.reasoning || '').length;
          if (j.usage && j.usage.completion_tokens) tokensOut = j.usage.completion_tokens;
        } catch { /* partial or non-JSON line */ }
      }
    }
  } catch { broke = true; /* aborted by client or upstream drop */ }
  recordChat({
    ...base, ok: !broke && charsOut > 0, aborted: broke && ctrl.signal.aborted,
    status: 200, ttfb, total: Date.now() - t0, charsOut, tokensOut,
  });
  res.end();
});

// =====================================================================
// VirusTotal proxy (free tier: 4 req/min, 500 req/day)
// =====================================================================
const vtWindow = []; // timestamps of recent upstream requests

async function vtSlot() {
  for (;;) {
    const now = Date.now();
    while (vtWindow.length && now - vtWindow[0] > 60000) vtWindow.shift();
    if (vtWindow.length < VT_PER_MIN) { vtWindow.push(now); return; }
    await sleep(vtWindow[0] + 60000 - now + 50);
  }
}
function vtUsedToday() { return stats.vtDaily[dayKey()] || 0; }

class VtError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Returns { status, json }. 404 is returned (not thrown) so callers can treat it as "unknown to VT".
async function vtFetch(pathname, { method = 'GET', body, headers = {}, timeout = 30000 } = {}) {
  if (!VT_KEY) throw new VtError(500, 'VT_API_KEY is missing. Put it in .env and restart the server.');
  if (vtUsedToday() >= VT_DAILY) throw new VtError(429, `Daily VirusTotal quota used up (${VT_DAILY} requests). It resets at midnight UTC.`);
  await vtSlot();
  stats.vtDaily[dayKey()] = vtUsedToday() + 1;
  for (const k of Object.keys(stats.vtDaily).sort().slice(0, -14)) delete stats.vtDaily[k];
  persistSoon();

  let r;
  try {
    r = await fetch(`${VT_BASE}${pathname}`, {
      method, body,
      headers: { 'x-apikey': VT_KEY, accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new VtError(504, 'VirusTotal did not respond in time.');
  }
  const json = await r.json().catch(() => ({}));
  if (r.status === 404) return { status: 404, json };
  if (r.status === 401) throw new VtError(401, 'VirusTotal rejected the API key (401). Check VT_API_KEY in .env.');
  if (r.status === 403) throw new VtError(403, 'VirusTotal says this key may not do that (403).');
  if (r.status === 429) throw new VtError(429, 'VirusTotal rate limit hit (429). Wait a minute and retry.');
  if (!r.ok) {
    const msg = (json && json.error && json.error.message) || '';
    throw new VtError(r.status, `VirusTotal error (${r.status}). ${msg}`.trim());
  }
  return { status: r.status, json };
}

const isoDate = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : undefined);

// Normalise a VT object (file, url or analysis) into one compact report shape.
function summarize(kind, obj, meta = {}) {
  const a = (obj && obj.attributes) || {};
  const st = a.last_analysis_stats || a.stats || {};
  const results = a.last_analysis_results || a.results || {};
  const engines = (st.malicious || 0) + (st.suspicious || 0) + (st.undetected || 0) + (st.harmless || 0);
  const detections = Object.values(results)
    .filter((r) => r.category === 'malicious' || r.category === 'suspicious')
    .map((r) => ({ engine: r.engine_name, category: r.category, result: r.result || r.category }))
    .slice(0, 25);
  let verdict = 'unrated';
  if ((st.malicious || 0) > 0) verdict = 'malicious';
  else if ((st.suspicious || 0) > 0) verdict = 'suspicious';
  else if (engines > 0) verdict = 'clean';

  const lastSec = a.last_analysis_date || a.date;
  const info = {};
  let link;
  if (kind === 'file') {
    const sha = a.sha256 || meta.sha256 || (obj && obj.id);
    if (a.type_description) info.type = a.type_description;
    if (a.size) info.size = `${a.size} bytes`;
    if (a.meaningful_name) info.name = a.meaningful_name;
    const label = a.popular_threat_classification && a.popular_threat_classification.suggested_threat_label;
    if (label) info.threat = label;
    if (a.first_submission_date) info.firstSeen = isoDate(a.first_submission_date);
    if (sha) { info.sha256 = sha; link = `https://www.virustotal.com/gui/file/${sha}`; }
  } else {
    const u = a.url || a.last_final_url || meta.url;
    if (u) info.url = u;
    if (a.title) info.title = a.title;
    if (a.times_submitted) info.timesSubmitted = String(a.times_submitted);
    const uid = (obj && obj.id && /^[a-f0-9]{64}$/.test(obj.id)) ? obj.id : meta.urlId;
    if (uid) link = `https://www.virustotal.com/gui/url/${uid}`;
  }
  if (lastSec) info.lastAnalysis = isoDate(lastSec);
  const ageDays = lastSec ? Math.floor((Date.now() / 1000 - lastSec) / 86400) : null;
  return { kind, verdict, stats: st, engines, detections, info, link, ageDays };
}

const HASH_RE = /^([a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/i;
const vtErr = (res, e) => res.status(e.status || 500).json({ error: e.message || 'VirusTotal error.' });

app.get('/api/vt/status', (req, res) => {
  res.json({ keyConfigured: Boolean(VT_KEY), usedToday: vtUsedToday(), dailyLimit: VT_DAILY, perMinute: VT_PER_MIN, maxUploadBytes: VT_MAX_UPLOAD });
});

// Hash lookup: reads an existing report; nothing is uploaded.
app.get('/api/vt/hash/:hash', async (req, res) => {
  const h = req.params.hash;
  if (!HASH_RE.test(h)) return res.status(400).json({ error: 'Not an MD5/SHA-1/SHA-256 hash.' });
  try {
    const { status, json } = await vtFetch(`/files/${h.toLowerCase()}`);
    recordVt('hash', { found: status !== 404 });
    if (status === 404) return res.json({ found: false });
    const rep = summarize('file', json.data);
    recordVt('verdict', { verdict: rep.verdict });
    res.json({ found: true, report: rep });
  } catch (e) { vtErr(res, e); }
});

function parseUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const u = new URL(raw.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString() : null;
  } catch { return null; }
}

// URL lookup: reads an existing report.
app.get('/api/vt/url', async (req, res) => {
  const url = parseUrl(req.query.u);
  if (!url) return res.status(400).json({ error: 'Not a valid http(s) URL.' });
  try {
    const id = Buffer.from(url).toString('base64url');
    const { status, json } = await vtFetch(`/urls/${id}`);
    recordVt('url_lookup', { found: status !== 404 });
    if (status === 404) return res.json({ found: false, url });
    const rep = summarize('url', json.data, { url });
    recordVt('verdict', { verdict: rep.verdict });
    res.json({ found: true, report: rep, url });
  } catch (e) { vtErr(res, e); }
});

// Submit a URL for (re)scanning.
app.post('/api/vt/url-scan', async (req, res) => {
  const url = parseUrl(req.body && req.body.url);
  if (!url) return res.status(400).json({ error: 'Not a valid http(s) URL.' });
  try {
    const { json } = await vtFetch('/urls', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ url }).toString(),
    });
    recordVt('url_scan');
    res.json({ analysisId: json.data.id, url });
  } catch (e) { vtErr(res, e); }
});

// Upload a file (<= 32 MB). The browser sends the raw bytes; only call this after the user agrees.
app.post('/api/vt/upload', express.raw({ type: 'application/octet-stream', limit: '33mb' }), async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'No file received.' });
  if (buf.length > VT_MAX_UPLOAD) return res.status(413).json({ error: 'File is over 32 MB (free-tier upload limit).' });
  let name = 'upload.bin';
  try { name = decodeURIComponent(String(req.headers['x-filename'] || name)); } catch { /* keep default */ }
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'upload.bin';
  try {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    const { json } = await vtFetch('/files', { method: 'POST', body: fd, timeout: 120000 });
    recordVt('upload');
    res.json({ analysisId: json.data.id });
  } catch (e) { vtErr(res, e); }
});

// Ask VT to re-analyse a file it already knows.
app.post('/api/vt/rescan/:hash', async (req, res) => {
  const h = req.params.hash;
  if (!HASH_RE.test(h)) return res.status(400).json({ error: 'Not an MD5/SHA-1/SHA-256 hash.' });
  try {
    const { status, json } = await vtFetch(`/files/${h.toLowerCase()}/analyse`, { method: 'POST' });
    if (status === 404) return res.status(404).json({ error: 'VirusTotal does not know this file.' });
    recordVt('rescan');
    res.json({ analysisId: json.data.id });
  } catch (e) { vtErr(res, e); }
});

// Poll an analysis. Each poll costs one request from the free quota, so the client polls slowly.
app.get('/api/vt/analysis/:id', async (req, res) => {
  const id = req.params.id;
  if (!/^[A-Za-z0-9_=-]{8,200}$/.test(id)) return res.status(400).json({ error: 'Bad analysis id.' });
  try {
    const { status, json } = await vtFetch(`/analyses/${id}`);
    if (status === 404) return res.status(404).json({ error: 'Analysis not found.' });
    const attrs = (json.data && json.data.attributes) || {};
    if (attrs.status !== 'completed') return res.json({ status: attrs.status || 'queued' });
    const meta = json.meta || {};
    let rep;
    if (meta.url_info) {
      rep = summarize('url', json.data, { url: meta.url_info.url, urlId: meta.url_info.id });
    } else {
      rep = summarize('file', json.data, { sha256: meta.file_info && meta.file_info.sha256 });
      if (meta.file_info && meta.file_info.size) rep.info.size = `${meta.file_info.size} bytes`;
    }
    recordVt('verdict', { verdict: rep.verdict });
    res.json({ status: 'completed', report: rep });
  } catch (e) { vtErr(res, e); }
});

// =====================================================================
// Stats
// =====================================================================
const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

app.get('/api/stats', (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
  const since = Date.now() - days * 86400000;
  const chats = stats.chat.filter((e) => e.ts >= since);
  const vts = stats.vt.filter((e) => e.ts >= since);
  const tokens = (e) => e.tokensOut || Math.round((e.charsOut || 0) / 4);

  const names = Object.fromEntries(MODELS.map((m) => [m.id, m.name]));
  const perModel = Object.values(chats.reduce((acc, e) => {
    const r = acc[e.model] || (acc[e.model] = { model: e.model, name: names[e.model] || e.model, count: 0, ok: 0, errors: 0, ttfb: [], total: [], tokensOut: 0 });
    r.count += 1;
    if (e.ok) { r.ok += 1; if (e.ttfb != null) r.ttfb.push(e.ttfb); r.total.push(e.total); r.tokensOut += tokens(e); }
    else if (!e.aborted) r.errors += 1;
    return acc;
  }, {})).map((r) => ({ model: r.model, name: r.name, count: r.count, ok: r.ok, errors: r.errors,
    avgTtfb: avg(r.ttfb), avgTotal: avg(r.total), tokensOut: r.tokensOut }))
    .sort((a, b) => b.count - a.count);

  const perDay = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.now() - i * 86400000);
    const key = dayKey(d);
    perDay.push({
      date: key,
      chats: chats.filter((e) => dayKey(new Date(e.ts)) === key).length,
      vt: vts.filter((e) => ['hash', 'url_lookup', 'upload', 'url_scan', 'rescan'].includes(e.kind) && dayKey(new Date(e.ts)) === key).length,
    });
  }
  const verdicts = { malicious: 0, suspicious: 0, clean: 0, unrated: 0 };
  vts.filter((e) => e.kind === 'verdict').forEach((e) => { verdicts[e.verdict] = (verdicts[e.verdict] || 0) + 1; });
  const count = (k) => vts.filter((e) => e.kind === k).length;

  res.json({
    days,
    totals: {
      chats: chats.length,
      ok: chats.filter((e) => e.ok).length,
      errors: chats.filter((e) => !e.ok && !e.aborted).length,
      tokensOut: chats.reduce((n, e) => n + (e.ok ? tokens(e) : 0), 0),
      images: chats.reduce((n, e) => n + (e.images || 0), 0),
    },
    perModel,
    perDay,
    vt: {
      configured: Boolean(VT_KEY),
      lookups: count('hash') + count('url_lookup'),
      uploads: count('upload'),
      urlScans: count('url_scan'),
      rescans: count('rescan'),
      verdicts,
      usedToday: vtUsedToday(),
      dailyLimit: VT_DAILY,
    },
  });
});

app.delete('/api/stats', (req, res) => {
  stats = { chat: [], vt: [], vtDaily: stats.vtDaily }; // keep the quota counter honest
  flushStats();
  res.json({ ok: true });
});

// ---- static + SPA fallback ----
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, HOST, () => {
  console.log(`AI Hub on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(KEY ? 'NVIDIA key loaded.' : 'WARNING: NVIDIA_API_KEY not set — model chat will not work.');
  console.log(VT_KEY ? 'VirusTotal key loaded.' : 'Note: VT_API_KEY not set — VirusTotal scanner disabled.');
});
