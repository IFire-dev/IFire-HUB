// app.js — AI Hub client

// ---------- config ----------
// Link/iframe tools. Add more here.
//   embed: true  -> opens inside the hub (iframe, with fallback)
//   embed: false -> opens in a new tab (use for sites that refuse framing, e.g. github.com)
//   check: true  -> show an online/unreachable dot
const TOOLS = [
  { id: 'thesearch', name: 'TheSearch', tagline: 'self-hosted search engine', url: 'https://thesearch.onrender.com', embed: true, check: true },
  { id: 'virustotal', name: 'VirusTotal', tagline: 'check files, hashes & URLs (hash-first, no upload by default)', builtin: 'vt' },
  { id: 'github', name: 'GitHub', tagline: 'IFire-dev \u2014 repos & projects', url: 'https://github.com/IFire-dev', embed: false, check: false },
];

const MAX_CONTEXT_MSGS = 30;   // how many recent messages are sent to the model
const MAX_IMAGES = 4;
const OLD_LS_KEY = 'aihub.history.v1';   // history kept by versions before 2.0 (browser storage)

// What the performance tab can show (the user picks in Settings).
const PERF_DEFS = [
  { key: 'health', label: 'model status (from background checks)' },
  { key: 'ttfb', label: 'first token time (last reply)' },
  { key: 'total', label: 'total time (last reply)' },
  { key: 'tps', label: 'speed in tokens/s (last reply, estimate)' },
  { key: 'ctx', label: 'context used (estimate)' },
  { key: 'tokens', label: 'tokens generated (last reply, estimate)' },
  { key: 'avgTtfb', label: 'average first token time (this session)' },
  { key: 'session', label: 'requests and errors (this session)' },
];
const DEFAULT_PERF = { health: true, ttfb: true, total: true, tps: true, ctx: true, tokens: false, avgTtfb: false, session: false };
const THEMES = ['amber', 'green', 'ice', 'violet', 'white'];

// ---------- elements ----------
const $ = (id) => document.getElementById(id);
const bootEl = $('boot'), bootTextEl = $('boot-text'), loginEl = $('login');
const hubEl = $('hub'), sectionsEl = $('sections'), toolCountEl = $('tool-count');
const clockEl = $('clock'), persistEl = $('persist-indicator'), settingsEl = $('settings');
const gridView = $('grid-view'), launchView = $('launch-view'), chatView = $('chat-view'), vtView = $('vt-view');
const backBtn = $('back-btn'), breadcrumbEl = $('breadcrumb'), newTabBtn = $('newtab-btn');
const toolFrame = $('tool-frame'), fallbackEl = $('fallback'), fallbackLink = $('fallback-link');
const statsPanel = $('stats-panel');
const vtBack = $('vt-back'), vtQuota = $('vt-quota'), vtDrop = $('vt-drop');
const vtFile = $('vt-file'), vtInput = $('vt-input'), vtGo = $('vt-go'), vtOut = $('vt-out');
const chatAttach = $('chat-attach'), chatFile = $('chat-file'), attachRow = $('attach-row');
const chatBack = $('chat-back'), chatNew = $('chat-new'), chatBreadcrumb = $('chat-breadcrumb');
const chatLog = $('chat-log'), chatInput = $('chat-input'), chatSend = $('chat-send'), chatStop = $('chat-stop');
const perfChips = $('perf-chips'), perfRecheck = $('perf-recheck'), perfConfig = $('perf-config');

// ---------- state ----------
let authMode = 'local';
let me = { id: 'local', isAdmin: true, mode: 'local' };
let settings = { saveHistory: true, fullWidth: true, perf: { ...DEFAULT_PERF } };
let history = {};          // { [modelId]: [{role, content, images?, imageCount?, reasoning?}] }
let models = [];
let keyConfigured = false;
let vtStatus = { keyConfigured: false };
let healthData = null;
let modelCards = [];       // cards whose health dot updates live
let current = null;        // model open in chat
let streaming = false;
let abortCtrl = null;
let pendingImages = [];    // data URLs for the next message (never saved)
let statsDays = 7;
let statsScope = 'all';
let persistFailed = false;
let frameTimeout = null;
let perfNote = '';
const sessionPerf = {};    // per model, this page session

// ---------- helpers ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtNum = (n) => Number(n || 0).toLocaleString();
const fmtMs = (ms) => (ms == null ? '\u2013' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// ---------- fetch wrapper: attaches the Clerk session token to /api calls ----------
const rawFetch = window.fetch.bind(window);
let signedOutHandled = false;
window.fetch = async (input, init = {}) => {
  const isApi = typeof input === 'string' && input.startsWith('/api');
  if (isApi && authMode === 'clerk') {
    let token = null;
    try { token = window.Clerk && window.Clerk.session ? await window.Clerk.session.getToken() : null; } catch { token = null; }
    if (token) init = { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } };
  }
  const res = await rawFetch(input, init);
  if (isApi && authMode === 'clerk' && res.status === 401 && !signedOutHandled) {
    signedOutHandled = true;
    location.reload();   // session expired: the sign-in screen comes back after reload
  }
  return res;
};

// =====================================================================
// boot + auth
// =====================================================================
const BOOT_LINES = ['> AI HUB v2.0.0', '> booting dashboard...', `> registered tools: ${TOOLS.length}`, '> ready.'];

function runBoot() {
  return new Promise((resolve) => {
    let i = 0;
    const type = () => {
      if (i >= BOOT_LINES.length) { setTimeout(resolve, 250); return; }
      bootTextEl.textContent += (i > 0 ? '\n' : '') + BOOT_LINES[i];
      i += 1;
      setTimeout(type, 220);
    };
    type();
  });
}
function hideBoot() {
  bootEl.classList.add('boot--done');
  setTimeout(() => { bootEl.hidden = true; }, 400);
}

function loadScript(src, attrs = {}) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v));
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${new URL(src).host}`));
    document.head.appendChild(s);
  });
}

// Follows Clerk's current script-tag quickstart for plain JavaScript.
async function loadClerk(publishableKey) {
  const domain = atob(publishableKey.split('_')[2]).slice(0, -1);   // Frontend API domain is inside the key
  const work = (async () => {
    await loadScript(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`);
    await loadScript(`https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, { 'data-clerk-publishable-key': publishableKey });
    await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  })();
  await Promise.race([work, sleep(20000).then(() => { throw new Error('timed out'); })]);
}

const CLERK_APPEARANCE = {
  variables: {
    colorPrimary: '#ffb000', colorPrimaryForeground: '#0b0904',
    colorBackground: '#14100a', colorForeground: '#f2c879',
    colorMutedForeground: '#c9a65d', colorInput: '#0b0904', colorInputForeground: '#f2c879',
    colorBorder: '#8a5c00',
    fontFamily: "'JetBrains Mono', 'Courier New', monospace", borderRadius: '0px',
  },
};

function showLogin({ msg, retry, signout, hideForm } = {}) {
  hideBoot();
  hubEl.hidden = true;
  loginEl.hidden = false;
  $('clerk-signin').hidden = Boolean(hideForm);
  const m = $('login-msg');
  m.hidden = !msg;
  m.textContent = msg || '';
  $('login-retry').hidden = !retry;
  $('login-signout').hidden = !signout;
}
$('login-retry').addEventListener('click', () => location.reload());
$('login-signout').addEventListener('click', async () => {
  try { await window.Clerk.signOut(); } catch { /* ignore */ }
  location.reload();
});

async function ensureSignedIn() {
  try { await loadClerk(cfgKey); } catch (e) {
    showLogin({ msg: `Could not load the sign-in (${e.message}). It needs an internet connection.`, retry: true, hideForm: true });
    return false;
  }
  if (!window.Clerk.isSignedIn) {
    showLogin({});
    window.Clerk.mountSignIn($('clerk-signin'), { appearance: CLERK_APPEARANCE });
    await new Promise((resolve) => {
      let unsub;   // declared first: Clerk may call the listener immediately
      const check = () => { if (window.Clerk.isSignedIn) { resolve(); return true; } return false; };
      unsub = window.Clerk.addListener(() => { if (check() && typeof unsub === 'function') unsub(); });
    });
    try { window.Clerk.unmountSignIn($('clerk-signin')); } catch { /* ignore */ }
  }
  return true;
}

let cfgKey = null;
async function startApp() {
  let cfg;
  try { cfg = await (await fetch('/api/config')).json(); } catch {
    bootTextEl.textContent += '\n> server unreachable. is it running?';
    return;
  }
  if (cfg.mode === 'setup') {
    bootTextEl.textContent += '\n> Cloudflare setup incomplete: add the Clerk keys to Worker secrets.';
    return;
  }
  authMode = cfg.mode;
  cfgKey = cfg.clerkPublishableKey;
  if (authMode === 'clerk' && !(await ensureSignedIn())) return;

  const meRes = await fetch('/api/me');
  if (meRes.status === 403) {
    const j = await meRes.json().catch(() => ({}));
    return showLogin({ msg: `${j.error || 'Not allowed.'}\nYour id: ${j.userId || '?'}`, signout: true, hideForm: true });
  }
  if (!meRes.ok) return showLogin({ msg: 'Could not reach the hub server.', retry: true, hideForm: true });
  me = await meRes.json();
  if (authMode === 'clerk' && me.isAdmin) $('welcome-title').textContent = 'Welcome, Owner';

  await loadUserData();
  applySettings();
  hideBoot();
  loginEl.hidden = true;
  hubEl.hidden = false;
  if (authMode === 'clerk') { try { window.Clerk.mountUserButton($('user-btn'), { appearance: CLERK_APPEARANCE }); } catch { /* ignore */ } }
  loadModels();
  loadHealth();
  setInterval(loadHealth, 60000);
}

// =====================================================================
// per-account settings + history (stored on the server)
// =====================================================================
function normSettings(s) {
  const raw = s || {};
  return {
    saveHistory: true,
    fullWidth: true,
    ...raw,
    theme: THEMES.includes(raw.theme) ? raw.theme : 'amber',
    perf: { ...DEFAULT_PERF, ...(raw.perf || {}) },
  };
}
async function loadUserData() {
  try {
    const d = await (await fetch('/api/user-data')).json();
    settings = normSettings(d.settings);
    history = d.history || {};
  } catch { /* keep defaults */ }
}

let settingsTimer = null;
function saveSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }).catch(() => {});
  }, 400);
}

function updatePersistLabel() {
  persistEl.textContent = persistFailed ? 'history: SAVE FAILED' : settings.saveHistory ? 'history: saved on server' : 'history: not saved';
  persistEl.className = `titlebar__persist${settings.saveHistory && !persistFailed ? ' titlebar__persist--on' : ''}`;
}
function applySettings() {
  document.body.classList.toggle('narrow', !settings.fullWidth);
  document.body.dataset.theme = settings.theme || 'amber';
  updatePersistLabel();
  if (current) renderPerf();
}

async function putThread(modelId) {
  const msgs = (history[modelId] || []).map(({ role, content, images, imageCount }) => ({
    role, content, imageCount: imageCount || (images ? images.length : 0) || undefined,
  }));
  try {
    const r = await fetch(`/api/history/${modelId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: msgs }) });
    persistFailed = !r.ok;
  } catch { persistFailed = true; }
  updatePersistLabel();
}
const saveTimers = {};
function saveThreadSoon(modelId) {
  if (!settings.saveHistory) return;
  clearTimeout(saveTimers[modelId]);
  saveTimers[modelId] = setTimeout(() => putThread(modelId), 500);
}

// =====================================================================
// settings modal
// =====================================================================
function readOldLocal() {
  try { return JSON.parse(localStorage.getItem(OLD_LS_KEY)) || {}; } catch { return {}; }
}
function countMsgs(o) { return Object.values(o).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0); }

function openSettings(scrollToPerf) {
  $('set-save').checked = settings.saveHistory;
  $('set-wide').checked = settings.fullWidth;
  $('set-theme').value = settings.theme || 'amber';
  $('save-note').textContent = authMode === 'clerk'
    ? 'Saved in your own file on the hub\u2019s server, so it follows you to other devices. The person who runs the hub can read it.'
    : 'Saved in data/users/local.json on this PC. Turning this off stops new saving; it does not delete what is already saved.';

  const box = $('set-perf');
  box.textContent = '';
  PERF_DEFS.forEach((d) => {
    const lab = el('label', 'check');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = Boolean(settings.perf[d.key]);
    cb.addEventListener('change', () => { settings.perf[d.key] = cb.checked; renderPerf(); saveSettingsSoon(); });
    lab.appendChild(cb); lab.appendChild(el('span', '', d.label));
    box.appendChild(lab);
  });

  const hd = healthData;
  $('set-health').textContent = !hd ? 'loading\u2026'
    : hd.enabled === false ? 'Background checks are off (HEALTH_ENABLED=0 in .env).'
      : `Each model gets one tiny test request at startup and then every ${Math.round(hd.intervalMs / 60000 * 10) / 10} min `
        + '(set HEALTH_INTERVAL_MIN in .env). Two failures in a row mark a model "down". '
        + (hd.lastCycle ? `Last full round: ${new Date(hd.lastCycle).toLocaleTimeString()}.` : 'First round has not finished yet.');

  $('set-account').textContent = authMode === 'clerk'
    ? `signed in \u00b7 ${me.isAdmin ? 'owner (admin)' : 'member'} \u00b7 id: ${me.id}`
    : 'local mode: no login, everything stays on this PC.';
  $('set-account-hint').textContent = authMode === 'clerk' && !me.isAdmin
    ? 'To become the owner, add this id to ADMIN_USER_IDS in the server\u2019s .env and restart it.' : '';
  $('set-copyid').hidden = authMode !== 'clerk';

  const old = readOldLocal();
  const n = countMsgs(old);
  $('set-import').hidden = n === 0;
  $('set-import').textContent = `import old browser history (${n} messages)`;

  settingsEl.hidden = false;
  if (scrollToPerf) $('set-perf-sec').scrollIntoView({ block: 'start' });
}
function closeSettings() { settingsEl.hidden = true; }

$('settings-btn').addEventListener('click', () => openSettings(false));
$('settings-close').addEventListener('click', closeSettings);
settingsEl.addEventListener('click', (e) => { if (e.target === settingsEl) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settingsEl.hidden) closeSettings(); });
perfConfig.addEventListener('click', () => openSettings(true));

$('set-save').addEventListener('change', (e) => {
  settings.saveHistory = e.target.checked;
  updatePersistLabel();
  saveSettingsSoon();
  if (settings.saveHistory) Object.keys(history).forEach(saveThreadSoon);   // keep what was typed while it was off
});
$('set-wide').addEventListener('change', (e) => {
  settings.fullWidth = e.target.checked;
  applySettings();
  saveSettingsSoon();
});
$('set-theme').addEventListener('change', (e) => {
  settings.theme = e.target.value;
  applySettings();
  saveSettingsSoon();
});
$('set-delete').addEventListener('click', async () => {
  if (!confirm('Delete ALL your saved chat history on the server? This cannot be undone.')) return;
  try { await fetch('/api/history', { method: 'DELETE' }); } catch { /* ignore */ }
  history = {};
  if (current) renderThread();
});
$('set-import').addEventListener('click', async () => {
  const old = readOldLocal();
  if (!confirm('Copy the chat history stored in this browser into your account? (It is then removed from the browser.)')) return;
  for (const [id, arr] of Object.entries(old)) {
    if (!Array.isArray(arr) || !models.some((m) => m.id === id)) continue;
    if (!(history[id] && history[id].length)) {
      history[id] = arr.filter((m) => m && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content, imageCount: m.imageCount }));
      await putThread(id);
    }
  }
  try { localStorage.removeItem(OLD_LS_KEY); } catch { /* ignore */ }
  $('set-import').hidden = true;
  if (current) renderThread();
});
$('set-copyid').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(me.id); $('set-copyid').textContent = 'copied'; } catch { $('set-copyid').textContent = me.id; }
});

// =====================================================================
// views
// =====================================================================
function show(view) {
  gridView.hidden = view !== 'grid';
  launchView.hidden = view !== 'launch';
  chatView.hidden = view !== 'chat';
  vtView.hidden = view !== 'vt';
  if (view === 'grid') loadStats();
}

function tickClock() { clockEl.textContent = new Date().toLocaleTimeString([], { hour12: false }); }

// =====================================================================
// home: cards
// =====================================================================
function toolCard(tool) {
  const interactive = tool.embed || tool.builtin;
  const card = el(interactive ? 'button' : 'a', 'card');
  if (interactive) card.type = 'button';
  else { card.href = tool.url; card.target = '_blank'; card.rel = 'noopener'; }

  const top = el('div', 'card__top');
  top.appendChild(el('span', 'card__name', tool.name));
  const status = el('span', 'card__status');
  if (tool.check) {
    card._dot = el('span', 'dot dot--checking');
    card._label = el('span', '', 'checking');
    status.appendChild(card._dot);
    status.appendChild(card._label);
  } else if (tool.builtin === 'vt') {
    status.appendChild(el('span', `dot ${vtStatus.keyConfigured ? 'dot--online' : 'dot--offline'}`));
    status.appendChild(el('span', '', vtStatus.keyConfigured ? 'ready' : 'no api key'));
  } else {
    status.appendChild(el('span', '', tool.embed ? '' : 'external'));
  }
  top.appendChild(status);
  card.appendChild(top);
  card.appendChild(el('p', 'card__tagline', tool.tagline));
  card.appendChild(el('span', 'card__launch', interactive ? 'open \u2192' : 'open \u2197'));
  if (tool.embed) card.addEventListener('click', () => launchTool(tool));
  if (tool.builtin === 'vt') card.addEventListener('click', openVT);
  return card;
}

function modelCard(m) {
  const card = el('button', `card${m.apiReady ? '' : ' card--disabled'}`);
  card.type = 'button';

  const top = el('div', 'card__top');
  top.appendChild(el('span', 'card__name', m.name));
  const status = el('span', 'card__status');
  card._dot = el('span', 'dot dot--idle');
  card._label = el('span', '', 'preview only');
  if (m.apiReady) {
    if (keyConfigured) { card._dot.className = 'dot dot--online'; card._label.textContent = 'ready'; }
    else { card._dot.className = 'dot dot--offline'; card._label.textContent = 'no api key'; }
  }
  status.appendChild(card._dot);
  status.appendChild(card._label);
  top.appendChild(status);
  card.appendChild(top);

  card.appendChild(el('p', 'card__tagline', m.tagline));
  card.appendChild(el('p', 'card__meta', `${m.ctx} context${m.vision ? ' \u00b7 image input' : ''} \u00b7 ${m.note || ''}`));

  if (m.apiReady) {
    card.appendChild(el('span', 'card__launch', 'chat \u2192'));
    card.addEventListener('click', () => openChat(m));
    if (keyConfigured) { card._model = m; modelCards.push(card); }
  } else if (m.playground) {
    const a = el('a', 'card__link', 'open playground \u2197');
    a.href = m.playground; a.target = '_blank'; a.rel = 'noopener';
    card.appendChild(a);
  }
  return card;
}

function renderHome() {
  sectionsEl.textContent = '';
  modelCards = [];

  const toolGroup = el('section', 'catalog-group catalog-group--tools');
  toolGroup.appendChild(el('h2', 'section-title', 'tools'));
  const toolGrid = el('div', 'cards');
  TOOLS.forEach((t) => { const c = toolCard(t); toolGrid.appendChild(c); if (t.check) checkStatus(t, c._dot, c._label); });
  toolGroup.appendChild(toolGrid);
  sectionsEl.appendChild(toolGroup);

  [...new Set(models.map((m) => m.category))].forEach((cat) => {
    const group = el('section', 'catalog-group catalog-group--models');
    group.appendChild(el('h2', 'section-title', `models // ${cat}`));
    const grid = el('div', 'cards');
    models.filter((m) => m.category === cat).forEach((m) => grid.appendChild(modelCard(m)));
    group.appendChild(grid);
    sectionsEl.appendChild(group);
  });

  toolCountEl.textContent = `${TOOLS.length} tools \u00b7 ${models.length} models`
    + (keyConfigured ? '' : ' \u00b7 NVIDIA_API_KEY missing (see .env.example)');
  updateHealthUI();
}

// Best-effort reachability check (no-cors: only tells whether the request went through).
function checkStatus(tool, dot, label) {
  fetch(tool.url, { mode: 'no-cors', cache: 'no-store' })
    .then(() => { dot.className = 'dot dot--online'; label.textContent = 'online'; })
    .catch(() => { dot.className = 'dot dot--offline'; label.textContent = 'unreachable'; });
}

async function loadModels() {
  try {
    const j = await (await fetch('/api/models')).json();
    models = j.models; keyConfigured = j.keyConfigured;
  } catch { models = []; keyConfigured = false; }
  try { vtStatus = await (await fetch('/api/vt/status')).json(); } catch { vtStatus = { keyConfigured: false }; }
  renderHome();
  loadStats();
}

// ---------- model health ----------
function healthView(id) {
  if (!healthData || healthData.enabled === false) return null;
  const h = healthData.models && healthData.models[id];
  if (!h) return null;
  switch (h.status) {
    case 'up': return { cls: 'dot--online', label: `up \u00b7 ${fmtMs(h.latency)}`, tone: 'ok', h };
    case 'slow': return { cls: 'dot--warn', label: `slow \u00b7 ${fmtMs(h.latency)}`, tone: 'warn', h };
    case 'suspect': return { cls: 'dot--warn', label: 'no response \u00b7 rechecking', tone: 'warn', h };
    case 'down': return { cls: 'dot--offline', label: 'down', tone: 'bad', h };
    case 'busy': return { cls: 'dot--warn', label: 'rate limited', tone: 'warn', h };
    case 'blocked': return { cls: 'dot--offline', label: h.error || 'blocked', tone: 'bad', h };
    case 'unknown': return { cls: 'dot--checking', label: 'checking\u2026', tone: '', h };
    default: return null;
  }
}
function updateHealthUI() {
  modelCards.forEach((card) => {
    const v = healthView(card._model.id);
    if (!v) return;
    card._dot.className = `dot ${v.cls}`;
    card._label.textContent = v.label;
    card._label.parentElement.title = (v.h.ts ? `last checked ${new Date(v.h.ts).toLocaleTimeString()}` : '') + (v.h.error ? ` \u00b7 ${v.h.error}` : '');
  });
  if (current) renderPerf();
}
async function loadHealth() {
  try {
    const r = await fetch('/api/health');
    if (!r.ok) return;
    healthData = await r.json();
    updateHealthUI();
  } catch { /* ignore */ }
}

// =====================================================================
// stats panel
// =====================================================================
function tile(num, label, sub) {
  const t = el('div', 'tile');
  t.appendChild(el('div', 'tile__num', num));
  t.appendChild(el('div', 'tile__lbl', label));
  if (sub) t.appendChild(el('div', 'tile__sub', sub));
  return t;
}

async function loadStats() {
  try {
    const r = await fetch(`/api/stats?days=${statsDays}&scope=${statsScope}`);
    if (!r.ok) throw new Error('stats unavailable');
    renderStats(await r.json());
  } catch { statsPanel.textContent = ''; }
}

function renderStats(d) {
  statsPanel.textContent = '';

  const details = el('details', 'stats__details');
  const summary = el('summary', 'section-title');
  summary.textContent = `stats // ${d.scope === 'all' && authMode === 'clerk' ? 'everyone' : (authMode === 'clerk' ? 'you' : 'this hub')} // last ${d.days} days`;
  details.appendChild(summary);
  const content = el('div', 'stats__content');
  details.appendChild(content);
  statsPanel.appendChild(details);

  const head = el('div', 'stats__head');
  const ctl = el('div', 'stats__ctl');
  if (me.isAdmin && authMode === 'clerk') {
    [['all', 'everyone'], ['me', 'just me']].forEach(([val, lbl]) => {
      const b = el('button', `btn${statsScope === val ? ' btn--primary' : ''}`, lbl);
      b.type = 'button';
      b.addEventListener('click', () => { statsScope = val; loadStats(); });
      ctl.appendChild(b);
    });
  }
  [7, 30].forEach((n) => {
    const b = el('button', `btn${n === d.days ? ' btn--primary' : ''}`, `${n}d`);
    b.type = 'button';
    b.addEventListener('click', () => { statsDays = n; loadStats(); });
    ctl.appendChild(b);
  });
  if (me.isAdmin) {
    const wipe = el('button', 'btn btn--danger', 'wipe stats');
    wipe.type = 'button';
    wipe.addEventListener('click', async () => {
      if (!confirm('Delete all recorded stats? (Chat history is not affected.)')) return;
      try { await fetch('/api/stats', { method: 'DELETE' }); } catch { /* ignore */ }
      loadStats();
    });
    ctl.appendChild(wipe);
  }
  head.appendChild(ctl);
  content.appendChild(head);

  const t = d.totals, v = d.vt;
  const rate = t.chats ? `${Math.round((t.ok / t.chats) * 100)}%` : '\u2013';
  const tiles = el('div', 'stats__tiles');
  tiles.appendChild(tile(fmtNum(t.chats), 'chat requests', `${t.errors} failed`));
  tiles.appendChild(tile(rate, 'success rate'));
  tiles.appendChild(tile(`~${fmtNum(t.tokensOut)}`, 'tokens generated', 'estimate'));
  tiles.appendChild(tile(fmtNum(t.images), 'images sent'));
  tiles.appendChild(tile(fmtNum(v.lookups + v.uploads + v.urlScans + v.rescans), 'virustotal requests',
    v.configured ? `quota today ${v.usedToday}/${v.dailyLimit}` : 'no VT_API_KEY'));
  if (me.isAdmin) tiles.appendChild(tile(fmtNum(d.healthChecksToday), 'health checks today', 'background model tests'));
  statsPanel.insertBefore(tiles, details);

  const cols = el('div', 'stats__cols');

  const mbox = el('div', 'stats__box');
  mbox.appendChild(el('div', 'stats__boxtitle', 'by model'));
  if (!d.perModel.length) {
    mbox.appendChild(el('div', 'dim', 'no chats recorded yet \u2014 open a model and say something.'));
  } else {
    const max = Math.max(...d.perModel.map((m) => m.count));
    const hdr = el('div', 'mrow mrow--hdr');
    ['model', 'requests', 'first token', 'total', 'errors'].forEach((h) => hdr.appendChild(el('span', '', h)));
    mbox.appendChild(hdr);
    d.perModel.forEach((m) => {
      const row = el('div', 'mrow');
      row.appendChild(el('span', 'mrow__name', m.name));
      const bar = el('span', 'mrow__bar');
      const fill = el('i'); fill.style.width = `${Math.max(4, Math.round((m.count / max) * 100))}%`;
      bar.appendChild(fill); bar.appendChild(el('b', '', String(m.count)));
      row.appendChild(bar);
      row.appendChild(el('span', '', fmtMs(m.avgTtfb)));
      row.appendChild(el('span', '', fmtMs(m.avgTotal)));
      row.appendChild(el('span', m.errors ? 'mrow__err' : '', String(m.errors)));
      mbox.appendChild(row);
    });
  }
  cols.appendChild(mbox);

  const abox = el('div', 'stats__box');
  abox.appendChild(el('div', 'stats__boxtitle', 'activity per day'));
  const peak = Math.max(1, ...d.perDay.flatMap((x) => [x.chats, x.vt]));
  const chart = el('div', 'chart');
  d.perDay.forEach((x, i) => {
    const col = el('div', 'chart__col');
    col.title = `${x.date}: ${x.chats} chat request(s), ${x.vt} VirusTotal request(s)`;
    const bars = el('div', 'chart__bars');
    const a = el('i', 'chart__bar chart__bar--chat'); a.style.height = x.chats ? `${Math.max(4, (x.chats / peak) * 100)}%` : '0';
    const b = el('i', 'chart__bar chart__bar--vt'); b.style.height = x.vt ? `${Math.max(4, (x.vt / peak) * 100)}%` : '0';
    bars.appendChild(a); bars.appendChild(b);
    col.appendChild(bars);
    const showLbl = d.perDay.length <= 10 || i % 5 === 0 || i === d.perDay.length - 1;
    col.appendChild(el('span', 'chart__lbl', showLbl ? x.date.slice(5) : '\u00a0'));
    chart.appendChild(col);
  });
  abox.appendChild(chart);
  const legend = el('div', 'chart__legend');
  legend.appendChild(el('span', 'chart__key chart__key--chat', 'chat'));
  legend.appendChild(el('span', 'chart__key chart__key--vt', 'virustotal'));
  abox.appendChild(legend);
  cols.appendChild(abox);
  content.appendChild(cols);

  const vbox = el('div', 'stats__box');
  vbox.appendChild(el('div', 'stats__boxtitle', 'virustotal'));
  const vv = v.verdicts;
  vbox.appendChild(el('div', 'stats__line', `lookups ${v.lookups} \u00b7 uploads ${v.uploads} \u00b7 url scans ${v.urlScans} \u00b7 rescans ${v.rescans}`));
  const verdictLine = el('div', 'stats__line');
  [['malicious', vv.malicious, 'bad'], ['suspicious', vv.suspicious, 'warn'], ['clean', vv.clean, 'ok'], ['unrated', vv.unrated, '']]
    .forEach(([lbl, n, cls]) => verdictLine.appendChild(el('span', `vchip ${cls ? `vchip--${cls}` : ''}`, `${lbl} ${n || 0}`)));
  vbox.appendChild(verdictLine);
  content.appendChild(vbox);

  content.appendChild(el('p', 'stats__note dim',
    'stored only in data/stats.json on the hub: model, timings, sizes and counts. never message text, filenames or files.'));
}

// =====================================================================
// iframe tools
// =====================================================================
function launchTool(tool) {
  breadcrumbEl.textContent = `ai-hub > ${tool.id}`;
  newTabBtn.href = tool.url;
  fallbackLink.href = tool.url;
  fallbackEl.hidden = true;
  toolFrame.hidden = false;
  toolFrame.src = tool.url;
  show('launch');

  // Blocked framing fires no error event, so this is a timeout heuristic.
  clearTimeout(frameTimeout);
  let loaded = false;
  toolFrame.onload = () => { loaded = true; };
  frameTimeout = setTimeout(() => {
    if (!loaded) { toolFrame.hidden = true; fallbackEl.hidden = false; }
  }, 6000);
}
backBtn.addEventListener('click', () => {
  clearTimeout(frameTimeout);
  toolFrame.src = 'about:blank';
  show('grid');
});

// =====================================================================
// chat
// =====================================================================
// Escape first, then allow only ``` fences, `inline code` and **bold**.
function renderLite(src) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = src.split('```');
  return parts.map((p, i) => {
    if (i % 2 === 1) {
      const nl = p.indexOf('\n');
      const body = nl >= 0 && /^[\w+#.-]*$/.test(p.slice(0, nl).trim()) ? p.slice(nl + 1) : p;
      return `<pre class="code"><code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
    }
    let t = p;
    if (i > 0) t = t.replace(/^\n/, '');
    if (i < parts.length - 1) t = t.replace(/\n$/, '');
    return esc(t)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  }).join('');
}

function thread() {
  if (!history[current.id]) history[current.id] = [];
  return history[current.id];
}
function nearBottom() { return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 160; }
function scrollDown() { chatLog.scrollTop = chatLog.scrollHeight; }

function messageNode(msg, { streamingNow = false, reasoning = '' } = {}) {
  const wrap = el('div', `msg msg--${msg.role}`);
  wrap.appendChild(el('div', 'msg__role', msg.role === 'user' ? 'you' : current.name));
  const think = reasoning || msg.reasoning;
  if (think) {
    const d = el('details', 'msg__think');
    d.appendChild(el('summary', '', 'thinking'));
    d.appendChild(el('div', '', think));
    wrap.appendChild(d);
  }
  if (msg.images && msg.images.length) {
    const row = el('div', 'msg__imgs');
    msg.images.forEach((u) => { const im = el('img'); im.src = u; im.alt = 'attached image'; row.appendChild(im); });
    wrap.appendChild(row);
  } else if (msg.imageCount) {
    wrap.appendChild(el('div', 'msg__imgnote', `[${msg.imageCount} image${msg.imageCount === 1 ? '' : 's'} not saved]`));
  }
  const body = el('div', `msg__body${streamingNow ? ' msg__body--streaming' : ''}`);
  body.innerHTML = renderLite(msg.content);
  wrap.appendChild(body);
  return wrap;
}

function renderThread() {
  chatLog.textContent = '';
  const t = thread();
  if (!t.length) chatLog.appendChild(el('div', 'chat-empty', `> new chat with ${current.name}. say something.`));
  t.forEach((m) => chatLog.appendChild(messageNode(m)));
  renderPerf();
}

function setStreaming(on) {
  streaming = on;
  chatSend.hidden = on;
  chatStop.hidden = !on;
  chatInput.disabled = on;
  chatAttach.disabled = on;
  chatNew.disabled = on;
  chatBack.disabled = on;
}

// ---------- performance tab ----------
const estTokens = (chars) => Math.round(chars / 4);
function parseCtx(s) {
  const m = /^([\d.]+)\s*([KM])?$/i.exec(s || '');
  if (!m) return null;
  return parseFloat(m[1]) * (m[2] ? (m[2].toUpperCase() === 'M' ? 1e6 : 1e3) : 1);
}
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

function recordPerf(modelId, { ok, ttfb, total, tokens }) {
  const sp = sessionPerf[modelId] || (sessionPerf[modelId] = { n: 0, errors: 0, ttfbSum: 0, ttfbN: 0, last: null });
  sp.n += 1;
  if (!ok) sp.errors += 1;
  else {
    sp.ttfbSum += ttfb; sp.ttfbN += 1;
    const gen = total - ttfb;
    sp.last = { ttfb, total, tokens, tps: gen > 300 && tokens > 0 ? tokens / (gen / 1000) : null };
  }
  renderPerf();
}

function renderPerf() {
  perfChips.textContent = '';
  if (!current) return;
  const sp = sessionPerf[current.id] || { n: 0, errors: 0, ttfbSum: 0, ttfbN: 0, last: null };
  const last = sp.last;
  const on = settings.perf || {};
  const add = (label, value, tone) => {
    const c = el('div', `pchip${tone ? ` pchip--${tone}` : ''}`);
    c.appendChild(el('span', 'pchip__l', label));
    c.appendChild(el('span', 'pchip__v', value));
    perfChips.appendChild(c);
  };
  if (on.health) {
    const hv = healthView(current.id);
    add('status', hv ? hv.label : (healthData && healthData.enabled === false ? 'checks off' : '\u2013'), hv ? hv.tone : '');
  }
  if (on.ttfb) add('first token', last ? fmtMs(last.ttfb) : '\u2013');
  if (on.total) add('total', last ? fmtMs(last.total) : '\u2013');
  if (on.tps) add('speed', last && last.tps ? `~${Math.round(last.tps)} tok/s` : '\u2013');
  if (on.tokens) add('tokens out', last ? `~${fmtNum(last.tokens)}` : '\u2013');
  if (on.ctx) {
    const chars = thread().reduce((n, m) => n + m.content.length + ((m.images && m.images.length) || 0) * 3200, 0);
    const used = estTokens(chars);
    const max = parseCtx(current.ctx);
    add('context', max ? `~${fmtTok(used)} / ${current.ctx} (${Math.min(100, Math.round((used / max) * 100))}%)` : `~${fmtTok(used)}`,
      max && used / max > 0.8 ? 'warn' : '');
  }
  if (on.avgTtfb) add('avg first token', sp.ttfbN ? fmtMs(Math.round(sp.ttfbSum / sp.ttfbN)) : '\u2013');
  if (on.session) add('session', `${sp.n} req \u00b7 ${sp.errors} err`, sp.errors ? 'warn' : '');
  if (perfNote) add('note', perfNote, 'bad');
  if (!perfChips.children.length) perfChips.appendChild(el('span', 'dim', 'nothing selected \u2014 press configure.'));
}

perfRecheck.addEventListener('click', async () => {
  if (!current) return;
  perfRecheck.disabled = true;
  try {
    const r = await fetch(`/api/health/recheck/${current.id}`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    await loadHealth();
  } catch (e) {
    perfNote = e.message;
    renderPerf();
    setTimeout(() => { perfNote = ''; renderPerf(); }, 5000);
  } finally { perfRecheck.disabled = false; }
});

function openChat(m) {
  current = m;
  chatBreadcrumb.textContent = `ai-hub > chat > ${m.name}`;
  clearImages();
  chatAttach.hidden = !m.vision;
  show('chat');
  renderThread();
  chatInput.focus();
  scrollDown();
  loadHealth();
}
chatBack.addEventListener('click', () => { current = null; show('grid'); });

chatNew.addEventListener('click', () => {
  if (thread().length && !confirm('Clear this conversation?')) return;
  history[current.id] = [];
  putThread(current.id);   // always applies, so a cleared chat is also cleared on the server
  renderThread();
});

function errorBubble(text, detail) {
  const wrap = el('div', 'msg msg--error');
  wrap.appendChild(el('div', 'msg__role', 'error'));
  wrap.appendChild(el('div', 'msg__body', detail ? `${text}\n${detail}` : text));
  chatLog.appendChild(wrap);
}

async function send() {
  if (streaming || !current) return;
  const text = chatInput.value.trim();
  if (!text) return;
  const model = current;

  const t = thread();
  const sentImages = pendingImages.slice();
  t.push({ role: 'user', content: text, images: sentImages.length ? sentImages : undefined });
  chatInput.value = '';
  clearImages();
  renderThread();

  const reply = { role: 'assistant', content: '' };
  let reasoning = '';
  let bubble = messageNode(reply, { streamingNow: true });
  chatLog.appendChild(bubble);
  scrollDown();

  // The model must see a conversation that starts with a user turn.
  let ctx = t.slice(-MAX_CONTEXT_MSGS);
  while (ctx.length && ctx[0].role !== 'user') ctx = ctx.slice(1);
  // Images go out only with the newest user message; older ones become a text note.
  ctx = ctx.map((m, i) => {
    const hadImgs = (m.images && m.images.length) || m.imageCount;
    if (i === ctx.length - 1 && m.images && m.images.length) {
      return { role: 'user', content: [
        ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
        { type: 'text', text: m.content },
      ] };
    }
    return { role: m.role, content: hadImgs ? `${m.content}\n[an image was attached here earlier]` : m.content };
  });

  abortCtrl = new AbortController();
  setStreaming(true);
  const tStart = performance.now();
  let tFirst = null;
  let failure = null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model.id, messages: ctx }),
      signal: abortCtrl.signal,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { detail: j.detail });
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) throw new Error(j.error.message || 'stream error');
        const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        const r = d.reasoning_content || d.reasoning;
        if (r) reasoning += r;
        if (d.content) reply.content += d.content;
        if ((r || d.content) && tFirst === null) tFirst = performance.now();

        const stick = nearBottom();
        const fresh = messageNode(reply, { streamingNow: true, reasoning });
        bubble.replaceWith(fresh);
        bubble = fresh;
        if (stick) scrollDown();
      }
    }
    if (!reply.content && !reasoning) throw new Error('The model returned an empty response.');
  } catch (e) {
    if (e.name !== 'AbortError') failure = e;
  } finally {
    setStreaming(false);
    abortCtrl = null;
  }

  const tEnd = performance.now();
  recordPerf(model.id, {
    ok: !failure && tFirst !== null,
    ttfb: tFirst !== null ? Math.round(tFirst - tStart) : 0,
    total: Math.round(tEnd - tStart),
    tokens: estTokens(reply.content.length + reasoning.length),
  });

  // Settle history. A user turn with no reply is removed and its text restored,
  // so the thread keeps alternating user/assistant (some chat templates require it).
  if (current && current.id === model.id) {
    if (reply.content) {
      if (reasoning) reply.reasoning = reasoning;   // shown this session, never saved
      t.push(reply);
    } else {
      t.pop();
      chatInput.value = text;
      sentImages.forEach((u) => addImage(u));
    }
    saveThreadSoon(model.id);
    renderThread();
    if (failure) errorBubble(failure.message, failure.detail);
    scrollDown();
    chatInput.focus();
  } else if (reply.content) {
    t.push(reply);
    saveThreadSoon(model.id);
  }
}

chatSend.addEventListener('click', send);
chatStop.addEventListener('click', () => { if (abortCtrl) abortCtrl.abort(); });
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// ---------- image attach (vision models) ----------
function renderAttachRow() {
  attachRow.textContent = '';
  attachRow.hidden = pendingImages.length === 0;
  pendingImages.forEach((u, i) => {
    const chip = el('div', 'attach-chip');
    const im = el('img'); im.src = u; im.alt = 'attachment';
    const x = el('button', 'attach-chip__x', '\u00d7');
    x.type = 'button'; x.title = 'remove';
    x.addEventListener('click', () => { pendingImages.splice(i, 1); renderAttachRow(); });
    chip.appendChild(im); chip.appendChild(x);
    attachRow.appendChild(chip);
  });
}
function addImage(url) {
  if (pendingImages.length >= MAX_IMAGES) return;
  pendingImages.push(url);
  renderAttachRow();
}
function clearImages() { pendingImages = []; renderAttachRow(); }

// Downscale to max 1280px and re-encode as JPEG: keeps requests small and fast.
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objUrl = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(objUrl);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error('not an image')); };
    img.src = objUrl;
  });
}
async function attachFiles(files) {
  if (!current || !current.vision) return;
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try { addImage(await fileToDataUrl(f)); } catch { /* skip unreadable file */ }
  }
}
chatAttach.addEventListener('click', () => chatFile.click());
chatFile.addEventListener('change', () => { attachFiles([...chatFile.files]); chatFile.value = ''; });
chatInput.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
  if (files.length && current && current.vision) { e.preventDefault(); attachFiles(files); }
});

// =====================================================================
// virustotal
// =====================================================================
const VT_HASH_RE = /^([a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/i;
const VT_MAX_UPLOAD = 32 * 1024 * 1024;
const VT_MAX_HASH = 256 * 1024 * 1024;
let vtRun = 0;   // bumping this cancels any in-flight flow

async function vtApi(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function vtMsg(text, cls = '') {
  vtOut.textContent = '';
  vtOut.appendChild(el('div', `vt-msg ${cls}`, text));
}
function vtFail(e, run) {
  if (run !== vtRun) return;
  vtMsg(e.message, 'vt-msg--error');
  refreshVtQuota();
}
async function refreshVtQuota() {
  try {
    vtStatus = await (await fetch('/api/vt/status')).json();
    vtQuota.textContent = vtStatus.keyConfigured
      ? `quota today: ${vtStatus.usedToday}/${vtStatus.dailyLimit} \u00b7 free tier ${vtStatus.perMinute}/min`
      : '';
  } catch { vtQuota.textContent = ''; }
}

function openVT() {
  vtRun += 1;
  vtOut.textContent = '';
  vtInput.value = '';
  show('vt');
  refreshVtQuota().then(() => {
    if (!vtStatus.keyConfigured) vtMsg('VT_API_KEY is not set. Add it to .env (free key from virustotal.com) and restart the server.', 'vt-msg--error');
  });
}
vtBack.addEventListener('click', () => { vtRun += 1; show('grid'); });

async function sha256Hex(file) {
  const buf = await file.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const mb = (n) => (n / 1048576).toFixed(1);

async function handleFile(file) {
  if (!file) return;
  vtRun += 1;
  const run = vtRun;
  if (!window.isSecureContext || !(window.crypto && crypto.subtle)) {
    return vtMsg('hashing needs a secure context \u2014 open the hub over https, or via http://localhost:3000.', 'vt-msg--error');
  }
  if (file.size > VT_MAX_HASH) {
    return vtMsg(`this file is ${mb(file.size)} MB \u2014 too big to hash in the browser (limit 256 MB). Hash it yourself (Windows: certutil -hashfile "file" SHA256) and paste the hash below.`, 'vt-msg--error');
  }
  vtMsg(`hashing ${file.name} (${mb(file.size)} MB) in your browser\u2026`);
  let sha;
  try { sha = await sha256Hex(file); } catch { return vtMsg('could not read that file.', 'vt-msg--error'); }
  if (run !== vtRun) return;
  lookupHash(sha, run, file);
}

async function lookupHash(hash, run, file) {
  vtMsg(`looking up ${hash.slice(0, 16)}\u2026 (nothing is uploaded)`);
  let j;
  try { j = await vtApi(`/api/vt/hash/${hash}`); } catch (e) { return vtFail(e, run); }
  if (run !== vtRun) return;
  refreshVtQuota();
  if (j.found) {
    return renderReport(j.report, {
      onRescan: async () => {
        vtRun += 1; const r2 = vtRun;
        vtMsg('asking VirusTotal to re-analyse\u2026');
        try {
          const a = await vtApi(`/api/vt/rescan/${hash}`, { method: 'POST' });
          pollAnalysis(a.analysisId, r2, 're-analysis');
        } catch (e) { vtFail(e, r2); }
      },
    });
  }
  vtOut.textContent = '';
  const box = el('div', 'vt-report');
  box.appendChild(el('div', 'vt-verdict vt-verdict--unrated', 'UNKNOWN TO VIRUSTOTAL'));
  box.appendChild(el('p', '', `VirusTotal has never seen this file (sha-256 ${hash}).`));
  if (file && file.size <= VT_MAX_UPLOAD) {
    box.appendChild(el('p', 'dim', 'uploading shares the file with VirusTotal and its security-vendor partners. only upload files you are fine sharing.'));
    const b = el('button', 'btn btn--primary', `upload & scan (${mb(file.size)} MB)`);
    b.type = 'button';
    b.addEventListener('click', () => uploadFile(file));
    box.appendChild(b);
  } else if (file) {
    box.appendChild(el('p', 'dim', `this file is ${mb(file.size)} MB. direct upload on the free tier stops at 32 MB, so it can't be scanned from here.`));
  } else {
    box.appendChild(el('p', 'dim', 'you pasted a hash, so there is no file to upload.'));
  }
  vtOut.appendChild(box);
}

async function uploadFile(file) {
  vtRun += 1;
  const run = vtRun;
  vtMsg(`uploading ${file.name}\u2026`);
  try {
    const j = await vtApi('/api/vt/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    if (run !== vtRun) return;
    pollAnalysis(j.analysisId, run, 'scan');
  } catch (e) { vtFail(e, run); }
}

async function pollAnalysis(id, run, label) {
  const t0 = Date.now();
  for (let n = 0; n < 30; n += 1) {
    if (run !== vtRun) return;
    let j;
    try { j = await vtApi(`/api/vt/analysis/${encodeURIComponent(id)}`); } catch (e) { return vtFail(e, run); }
    if (run !== vtRun) return;
    refreshVtQuota();
    if (j.status === 'completed') return renderReport(j.report, {});
    vtMsg(`${label}: ${j.status}\u2026 ${Math.round((Date.now() - t0) / 1000)}s. each check uses one of your ${vtStatus.perMinute || 4} requests/min, so this polls slowly.`);
    await sleep(8000);
  }
  if (run === vtRun) vtMsg('still not finished after about 5 minutes. look the hash up again later.', 'vt-msg--error');
}

async function lookupUrl(url, run) {
  vtMsg(`looking up ${url}\u2026`);
  let j;
  try { j = await vtApi(`/api/vt/url?u=${encodeURIComponent(url)}`); } catch (e) { return vtFail(e, run); }
  if (run !== vtRun) return;
  refreshVtQuota();
  const scan = async () => {
    vtRun += 1; const r2 = vtRun;
    vtMsg('submitting URL for scanning\u2026');
    try {
      const a = await vtApi('/api/vt/url-scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
      pollAnalysis(a.analysisId, r2, 'url scan');
    } catch (e) { vtFail(e, r2); }
  };
  if (j.found) return renderReport(j.report, { onRescan: scan });
  vtOut.textContent = '';
  const box = el('div', 'vt-report');
  box.appendChild(el('div', 'vt-verdict vt-verdict--unrated', 'UNKNOWN URL'));
  box.appendChild(el('p', '', `VirusTotal has no report for ${url}`));
  box.appendChild(el('p', 'dim', 'submitting sends this URL to VirusTotal.'));
  const b = el('button', 'btn btn--primary', 'submit for scan');
  b.type = 'button'; b.addEventListener('click', scan);
  box.appendChild(b);
  vtOut.appendChild(box);
}

const INFO_LABELS = { type: 'type', size: 'size', name: 'name', threat: 'threat label', firstSeen: 'first seen',
  sha256: 'sha-256', url: 'url', title: 'title', timesSubmitted: 'times submitted', lastAnalysis: 'last analysed' };

function renderReport(rep, opts) {
  vtOut.textContent = '';
  const box = el('div', 'vt-report');
  const s = rep.stats || {};
  const flagged = (s.malicious || 0) + (s.suspicious || 0);
  const label = { malicious: 'MALICIOUS', suspicious: 'SUSPICIOUS', clean: 'NO DETECTIONS', unrated: 'NOT ENOUGH DATA' }[rep.verdict] || 'UNRATED';
  box.appendChild(el('div', `vt-verdict vt-verdict--${rep.verdict}`,
    rep.verdict === 'unrated' ? label : `${label} \u2014 ${flagged} of ${rep.engines} engines flag this`));

  const noResult = (s.timeout || 0) + (s['confirmed-timeout'] || 0) + (s.failure || 0) + (s['type-unsupported'] || 0);
  const chips = el('div', 'vt-chips');
  [['malicious', s.malicious, 'bad'], ['suspicious', s.suspicious, 'warn'], ['harmless', s.harmless, 'ok'],
    ['undetected', s.undetected, ''], ['no result', noResult, '']]
    .forEach(([l, n, c]) => chips.appendChild(el('span', `vchip ${c ? `vchip--${c}` : ''}`, `${l} ${n || 0}`)));
  box.appendChild(chips);

  const dl = el('dl', 'vt-info');
  Object.entries(rep.info || {}).forEach(([k, v]) => {
    dl.appendChild(el('dt', '', INFO_LABELS[k] || k));
    dl.appendChild(el('dd', '', String(v)));
  });
  box.appendChild(dl);

  if (rep.ageDays != null && rep.ageDays > 30) {
    box.appendChild(el('p', 'dim', `this analysis is ${rep.ageDays} days old. rescan for current results.`));
  }
  if (rep.detections && rep.detections.length) {
    box.appendChild(el('div', 'stats__boxtitle', 'flagged by'));
    const ul = el('ul', 'vt-det');
    rep.detections.forEach((d) => ul.appendChild(el('li', d.category === 'malicious' ? 'vt-det--bad' : 'vt-det--warn', `${d.engine}: ${d.result}`)));
    box.appendChild(ul);
  }
  if (rep.verdict === 'clean') {
    box.appendChild(el('p', 'dim', 'no detections is not proof of safety, especially for brand-new or targeted malware.'));
  }

  const actions = el('div', 'vt-actions');
  if (rep.link && rep.link.startsWith('https://www.virustotal.com/')) {
    const a = el('a', 'btn', 'open full report \u2197');
    a.href = rep.link; a.target = '_blank'; a.rel = 'noopener';
    actions.appendChild(a);
  }
  if (opts.onRescan) {
    const b = el('button', 'btn', 'rescan');
    b.type = 'button'; b.addEventListener('click', opts.onRescan);
    actions.appendChild(b);
  }
  box.appendChild(actions);
  vtOut.appendChild(box);
}

vtDrop.addEventListener('click', () => vtFile.click());
vtDrop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); vtFile.click(); } });
vtFile.addEventListener('change', () => { handleFile(vtFile.files[0]); vtFile.value = ''; });
['dragenter', 'dragover'].forEach((ev) => vtDrop.addEventListener(ev, (e) => { e.preventDefault(); vtDrop.classList.add('vt-drop--over'); }));
['dragleave', 'drop'].forEach((ev) => vtDrop.addEventListener(ev, (e) => { e.preventDefault(); vtDrop.classList.remove('vt-drop--over'); }));
vtDrop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

function vtSubmit() {
  const v = vtInput.value.trim();
  if (!v) return;
  vtRun += 1;
  const run = vtRun;
  if (VT_HASH_RE.test(v)) return lookupHash(v.toLowerCase(), run, null);
  let u = v;
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  try { new URL(u); } catch { return vtMsg('that is neither a valid hash nor a URL.', 'vt-msg--error'); }
  return lookupUrl(u, run);
}
vtGo.addEventListener('click', vtSubmit);
vtInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') vtSubmit(); });

// =====================================================================
// init
// =====================================================================
tickClock();
setInterval(tickClock, 1000);
runBoot().then(startApp);
