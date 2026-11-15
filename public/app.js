// app.js — AI Hub client logic

// ---------- config ----------
// Link/iframe tools. Add more here.
//   embed: true  -> opens inside the hub (iframe, with fallback)
//   embed: false -> opens in a new tab (use for sites that refuse framing, e.g. github.com)
//   check: true  -> show an online/unreachable dot
const TOOLS = [
  { id: 'thesearch', name: 'TheSearch', tagline: 'self-hosted search engine', url: 'https://thesearch.onrender.com', embed: true, check: true },
  { id: 'virustotal', name: 'VirusTotal', tagline: 'check files, hashes & URLs (hash-first, no upload by default)', builtin: 'vt' },
  { id: 'github', name: 'GitHub', tagline: 'IFire-dev — repos & projects', url: 'https://github.com/IFire-dev', embed: false, check: false },
];

const HISTORY_KEY = 'aihub.history.v1';
const MAX_CONTEXT_MSGS = 30;   // how many recent messages are sent to the model
const MAX_STORED_MSGS = 200;   // per model thread, when saving to disk

// ---------- elements ----------
const $ = (id) => document.getElementById(id);
const bootEl = $('boot'), bootTextEl = $('boot-text');
const consentEl = $('consent'), consentInfoEl = $('consent-info');
const hubEl = $('hub'), sectionsEl = $('sections'), toolCountEl = $('tool-count');
const clockEl = $('clock'), persistEl = $('persist-indicator');
const gridView = $('grid-view'), launchView = $('launch-view'), chatView = $('chat-view');
const backBtn = $('back-btn'), breadcrumbEl = $('breadcrumb'), newTabBtn = $('newtab-btn');
const toolFrame = $('tool-frame'), fallbackEl = $('fallback'), fallbackLink = $('fallback-link');
const chatBack = $('chat-back'), chatNew = $('chat-new'), chatBreadcrumb = $('chat-breadcrumb');
const statsPanel = $('stats-panel');
const vtView = $('vt-view'), vtBack = $('vt-back'), vtQuota = $('vt-quota'), vtDrop = $('vt-drop');
const vtFile = $('vt-file'), vtInput = $('vt-input'), vtGo = $('vt-go'), vtOut = $('vt-out');
const chatAttach = $('chat-attach'), chatFile = $('chat-file'), attachRow = $('attach-row');
const chatLog = $('chat-log'), chatInput = $('chat-input'), chatSend = $('chat-send'), chatStop = $('chat-stop');

let frameTimeout = null;
let persist = false;       // set by the start-page question
let history = {};          // { [modelId]: [{role, content}] }
let models = [];
let keyConfigured = false;
let current = null;        // model currently open in chat
let streaming = false;
let abortCtrl = null;
let vtStatus = { keyConfigured: false };
let statsDays = 7;
let pendingImages = [];   // data URLs attached to the next message (never saved to disk)
const MAX_IMAGES = 4;

// ---------- tiny helpers ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ---------- history storage ----------
function readSaved() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || {}; } catch { return {}; }
}
function countSaved(obj) {
  return Object.values(obj).reduce((n, arr) => n + (Array.isArray(arr) ? arr.length : 0), 0);
}
function saveHistory() {
  if (!persist) return;
  try {
    const trimmed = {};
    for (const [k, v] of Object.entries(history)) {
      trimmed[k] = v.slice(-MAX_STORED_MSGS).map(({ role, content, images, imageCount }) =>
        ({ role, content, imageCount: imageCount || (images ? images.length : 0) || undefined }));
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
    setPersistLabel(true);
  } catch {
    persistEl.textContent = 'history: SAVE FAILED (storage full/blocked)';
    persistEl.className = 'titlebar__persist';
  }
}
function setPersistLabel(ok = true) {
  persistEl.textContent = persist ? 'history: saved on this device' : 'history: session only';
  persistEl.className = 'titlebar__persist' + (persist && ok ? ' titlebar__persist--on' : '');
}

// ---------- boot sequence + history question ----------
const BOOT_LINES = [
  '> AI HUB v1.3.0',
  '> booting dashboard...',
  `> registered tools: ${TOOLS.length}`,
  '> ready.',
];

function runBoot() {
  let i = 0;
  const type = () => {
    if (i >= BOOT_LINES.length) { setTimeout(askConsent, 250); return; }
    bootTextEl.textContent += (i > 0 ? '\n' : '') + BOOT_LINES[i];
    i += 1;
    setTimeout(type, 220);
  };
  type();
}

function askConsent() {
  const saved = readSaved();
  const n = countSaved(saved);
  consentInfoEl.textContent = n
    ? `found ${n} saved message${n === 1 ? '' : 's'} from earlier. "no" leaves them untouched on disk but does not load or add to them.`
    : 'nothing saved yet. "yes" stores chats in this browser only (localStorage), never on a server.';
  $('consent-wipe').hidden = n === 0;
  consentEl.hidden = false;

  const choose = (yes) => {
    document.removeEventListener('keydown', onKey);
    persist = yes;
    history = yes ? saved : {};
    finishBoot();
  };
  const wipe = () => {
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
    consentInfoEl.textContent = 'saved history wiped.';
    $('consent-wipe').hidden = true;
    saved && Object.keys(saved).forEach((k) => delete saved[k]);
  };
  function onKey(e) {
    const k = e.key.toLowerCase();
    if (k === 'y') choose(true);
    else if (k === 'n') choose(false);
    else if (k === 'w' && !$('consent-wipe').hidden) wipe();
  }
  $('consent-yes').onclick = () => choose(true);
  $('consent-no').onclick = () => choose(false);
  $('consent-wipe').onclick = wipe;
  document.addEventListener('keydown', onKey);
}

function finishBoot() {
  setPersistLabel();
  bootEl.classList.add('boot--done');
  setTimeout(() => { bootEl.hidden = true; hubEl.hidden = false; }, 400);
}

// ---------- clock ----------
function tickClock() {
  clockEl.textContent = new Date().toLocaleTimeString([], { hour12: false });
}

// ---------- cards ----------
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
  const card = el('button', 'card' + (m.apiReady ? '' : ' card--disabled'));
  card.type = 'button';

  const top = el('div', 'card__top');
  top.appendChild(el('span', 'card__name', m.name));
  const status = el('span', 'card__status');
  let dotCls = 'dot--idle', label = 'preview only';
  if (m.apiReady) {
    if (keyConfigured) { dotCls = 'dot--online'; label = 'ready'; }
    else { dotCls = 'dot--offline'; label = 'no api key'; }
  }
  status.appendChild(el('span', `dot ${dotCls}`));
  status.appendChild(el('span', '', label));
  top.appendChild(status);
  card.appendChild(top);

  card.appendChild(el('p', 'card__tagline', m.tagline));
  card.appendChild(el('p', 'card__meta', `${m.ctx} context${m.vision ? ' \u00b7 image input' : ''} \u00b7 ${m.note || ''}`));

  if (m.apiReady) {
    card.appendChild(el('span', 'card__launch', 'chat \u2192'));
    card.addEventListener('click', () => openChat(m));
  } else if (m.playground) {
    const a = el('a', 'card__link', 'open playground \u2197');
    a.href = m.playground; a.target = '_blank'; a.rel = 'noopener';
    card.appendChild(a);
  }
  return card;
}

function renderHome() {
  sectionsEl.textContent = '';

  sectionsEl.appendChild(el('h2', 'section-title', 'tools'));
  const toolGrid = el('div', 'cards');
  TOOLS.forEach((t) => { const c = toolCard(t); toolGrid.appendChild(c); if (t.check) checkStatus(t, c._dot, c._label); });
  sectionsEl.appendChild(toolGrid);

  const cats = [...new Set(models.map((m) => m.category))];
  cats.forEach((cat) => {
    sectionsEl.appendChild(el('h2', 'section-title', `models // ${cat}`));
    const grid = el('div', 'cards');
    models.filter((m) => m.category === cat).forEach((m) => grid.appendChild(modelCard(m)));
    sectionsEl.appendChild(grid);
  });

  toolCountEl.textContent = `${TOOLS.length} tools \u00b7 ${models.length} models`
    + (keyConfigured ? '' : ' \u00b7 NVIDIA_API_KEY missing (see .env.example)');
}

// Best-effort reachability check (no-cors: only tells whether the request went through).
function checkStatus(tool, dot, label) {
  fetch(tool.url, { mode: 'no-cors', cache: 'no-store' })
    .then(() => { dot.className = 'dot dot--online'; label.textContent = 'online'; })
    .catch(() => { dot.className = 'dot dot--offline'; label.textContent = 'unreachable'; });
}

async function loadModels() {
  try {
    const r = await fetch('/api/models');
    const j = await r.json();
    models = j.models; keyConfigured = j.keyConfigured;
  } catch {
    models = []; keyConfigured = false;
  }
  try { vtStatus = await (await fetch('/api/vt/status')).json(); } catch { vtStatus = { keyConfigured: false }; }
  renderHome();
  loadStats();
}

// ---------- iframe tools ----------
function launchTool(tool) {
  breadcrumbEl.textContent = `ai-hub > ${tool.id}`;
  newTabBtn.href = tool.url;
  fallbackLink.href = tool.url;
  fallbackEl.hidden = true;
  toolFrame.hidden = false;
  toolFrame.src = tool.url;
  gridView.hidden = true;
  launchView.hidden = false;

  // Blocked framing fires no error event, so this is a timeout heuristic.
  clearTimeout(frameTimeout);
  let loaded = false;
  toolFrame.onload = () => { loaded = true; };
  frameTimeout = setTimeout(() => {
    if (!loaded) { toolFrame.hidden = true; fallbackEl.hidden = false; }
  }, 6000);
}
function closeTool() {
  clearTimeout(frameTimeout);
  toolFrame.src = 'about:blank';
  launchView.hidden = true;
  gridView.hidden = false;
  loadStats();
}
backBtn.addEventListener('click', closeTool);

// ---------- chat ----------
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

function nearBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
}
function scrollDown() { window.scrollTo(0, document.body.scrollHeight); }

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
  const body = el('div', 'msg__body' + (streamingNow ? ' msg__body--streaming' : ''));
  body.innerHTML = renderLite(msg.content);
  wrap.appendChild(body);
  return wrap;
}

function renderThread() {
  chatLog.textContent = '';
  const t = thread();
  if (!t.length) chatLog.appendChild(el('div', 'chat-empty', `> new chat with ${current.name}. say something.`));
  t.forEach((m) => chatLog.appendChild(messageNode(m)));
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

function openChat(m) {
  current = m;
  chatBreadcrumb.textContent = `ai-hub > chat > ${m.name}`;
  clearImages();
  chatAttach.hidden = !m.vision;
  renderThread();
  gridView.hidden = true;
  chatView.hidden = false;
  chatInput.focus();
  scrollDown();
}
function closeChat() {
  chatView.hidden = true;
  gridView.hidden = false;
  current = null;
  loadStats();
}
chatBack.addEventListener('click', closeChat);

chatNew.addEventListener('click', () => {
  if (thread().length && !confirm('Clear this conversation?')) return;
  history[current.id] = [];
  saveHistory();
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
  let failure = null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: current.id, messages: ctx }),
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

  // Settle history. A user turn with no reply is removed and its text restored,
  // so the thread keeps alternating user/assistant (some chat templates require it).
  if (reply.content) {
    if (reasoning) reply.reasoning = reasoning;   // shown this session, never saved
    t.push(reply);
  } else {
    t.pop();
    chatInput.value = text;
    sentImages.forEach((u) => addImage(u));
  }
  saveHistory();
  renderThread();
  if (failure) { errorBubble(failure.message, failure.detail); scrollDown(); }
  else scrollDown();
  chatInput.focus();
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
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); // flatten transparency
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

// ---------- stats panel ----------
const fmtNum = (n) => Number(n || 0).toLocaleString();
const fmtMs = (ms) => (ms == null ? '\u2013' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function tile(num, label, sub) {
  const t = el('div', 'tile');
  t.appendChild(el('div', 'tile__num', num));
  t.appendChild(el('div', 'tile__lbl', label));
  if (sub) t.appendChild(el('div', 'tile__sub', sub));
  return t;
}

async function loadStats() {
  try {
    const r = await fetch(`/api/stats?days=${statsDays}`);
    if (!r.ok) throw new Error('stats unavailable');
    renderStats(await r.json());
  } catch { statsPanel.textContent = ''; }
}

function renderStats(d) {
  statsPanel.textContent = '';

  const head = el('div', 'stats__head');
  head.appendChild(el('h2', 'section-title stats__title', `stats // last ${d.days} days`));
  const ctl = el('div', 'stats__ctl');
  [7, 30].forEach((n) => {
    const b = el('button', `btn${n === d.days ? ' btn--primary' : ''}`, `${n}d`);
    b.type = 'button';
    b.addEventListener('click', () => { statsDays = n; loadStats(); });
    ctl.appendChild(b);
  });
  const wipe = el('button', 'btn btn--danger', 'wipe stats');
  wipe.type = 'button';
  wipe.addEventListener('click', async () => {
    if (!confirm('Delete all recorded stats? (Your chat history is not affected.)')) return;
    try { await fetch('/api/stats', { method: 'DELETE' }); } catch { /* ignore */ }
    loadStats();
  });
  ctl.appendChild(wipe);
  head.appendChild(ctl);
  statsPanel.appendChild(head);

  const t = d.totals, v = d.vt;
  const rate = t.chats ? `${Math.round((t.ok / t.chats) * 100)}%` : '\u2013';
  const tiles = el('div', 'stats__tiles');
  tiles.appendChild(tile(fmtNum(t.chats), 'chat requests', `${t.errors} failed`));
  tiles.appendChild(tile(rate, 'success rate'));
  tiles.appendChild(tile(`~${fmtNum(t.tokensOut)}`, 'tokens generated', 'estimate'));
  tiles.appendChild(tile(fmtNum(t.images), 'images sent'));
  tiles.appendChild(tile(fmtNum(v.lookups + v.uploads + v.urlScans + v.rescans), 'virustotal requests',
    v.configured ? `quota today ${v.usedToday}/${v.dailyLimit}` : 'no VT_API_KEY'));
  statsPanel.appendChild(tiles);

  const cols = el('div', 'stats__cols');

  // per-model
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

  // activity chart
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
  statsPanel.appendChild(cols);

  // virustotal summary
  const vbox = el('div', 'stats__box');
  vbox.appendChild(el('div', 'stats__boxtitle', 'virustotal'));
  const vv = v.verdicts;
  vbox.appendChild(el('div', 'stats__line',
    `lookups ${v.lookups} \u00b7 uploads ${v.uploads} \u00b7 url scans ${v.urlScans} \u00b7 rescans ${v.rescans}`));
  const verdictLine = el('div', 'stats__line');
  [['malicious', vv.malicious, 'bad'], ['suspicious', vv.suspicious, 'warn'], ['clean', vv.clean, 'ok'], ['unrated', vv.unrated, '']]
    .forEach(([lbl, n, cls]) => verdictLine.appendChild(el('span', `vchip ${cls ? `vchip--${cls}` : ''}`, `${lbl} ${n || 0}`)));
  vbox.appendChild(verdictLine);
  statsPanel.appendChild(vbox);

  statsPanel.appendChild(el('p', 'stats__note dim',
    'stored only in data/stats.json on this PC: model, timings, sizes and counts. never message text, filenames or files.'));
}

// ---------- virustotal ----------
const VT_HASH_RE = /^([a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})$/i;
const VT_MAX_UPLOAD = 32 * 1024 * 1024;
const VT_MAX_HASH = 256 * 1024 * 1024;
let vtRun = 0;   // bumping this cancels any in-flight flow

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  gridView.hidden = true;
  vtView.hidden = false;
  refreshVtQuota().then(() => {
    if (!vtStatus.keyConfigured) vtMsg('VT_API_KEY is not set. Add it to .env (free key from virustotal.com) and restart the server.', 'vt-msg--error');
  });
}
function closeVT() {
  vtRun += 1;
  vtView.hidden = true;
  gridView.hidden = false;
  loadStats();
}
vtBack.addEventListener('click', closeVT);

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
    return vtMsg('hashing needs a secure context \u2014 open the hub via http://127.0.0.1:3000 or http://localhost:3000.', 'vt-msg--error');
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
  // unknown to VirusTotal
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

// ---------- init ----------
runBoot();
loadModels();
tickClock();
setInterval(tickClock, 1000);
