// health.js — background "is this model answering?" checks.
//
// Each check is one tiny real request (max_tokens: 1). A model counts as responding only if
// NVIDIA returns HTTP 200 AND the first real stream event arrives before the timeout.
//
// up       answered in time
// slow     answered, but slower than slowMs
// suspect  one failure; a confirming re-check runs shortly
// down     two failures in a row (5xx, timeout, empty stream, network error)
// busy     429 rate limit (not an outage)
// blocked  401/402/403/404/410: key, credits or access problem (not an outage)
// preview  API not open yet / nokey: no key configured
function createHealth({ models, getKey, url, intervalMs, timeoutMs, slowMs, confirmMs = 30000, onCheck }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = new Map();
  const lastManual = new Map();
  let running = false;
  let lastCycle = null;

  const checkable = () => models.filter((m) => m.apiReady);

  function blockedText(code) {
    return ({ 401: 'key rejected (401)', 402: 'no credits (402)', 403: 'not available to your key (403)',
      404: 'not found / not enabled (404)', 410: 'model retired (410)' })[code] || `HTTP ${code}`;
  }

  async function probe(m) {
    const ctrl = new AbortController();
    const t0 = Date.now();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getKey()}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: true }),
        signal: ctrl.signal,
      });
      if (!res.ok) { await res.text().catch(() => ''); return { ok: false, code: res.status, ms: Date.now() - t0 }; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return { ok: false, code: 200, ms: Date.now() - t0, error: 'stream ended with no data' };
        buf += dec.decode(value, { stream: true });
        const hit = buf.split('\n').some((l) => l.startsWith('data:') && l.slice(5).trim().length > 0);
        if (hit) { ctrl.abort(); return { ok: true, ms: Date.now() - t0 }; }
      }
    } catch (e) {
      return { ok: false, code: 0, ms: Date.now() - t0, error: ctrl.signal.aborted ? `no response in ${Math.round(timeoutMs / 1000)}s` : 'network error' };
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkOne(m) {
    if (!getKey()) { state.set(m.id, { status: 'nokey', ts: Date.now() }); return state.get(m.id); }
    if (onCheck) onCheck();
    const prev = state.get(m.id) || {};
    const r = await probe(m);
    let next;
    if (r.ok) {
      next = { status: r.ms > slowMs ? 'slow' : 'up', latency: r.ms, ts: Date.now(), fails: 0 };
    } else if ([401, 402, 403, 404, 410].includes(r.code)) {
      next = { status: 'blocked', code: r.code, error: blockedText(r.code), ts: Date.now(), fails: 0 };
    } else if (r.code === 429) {
      next = { status: 'busy', code: 429, error: 'rate limited (429)', ts: Date.now(), fails: 0 };
    } else {
      const fails = (prev.fails || 0) + 1;
      next = {
        status: fails >= 2 ? 'down' : 'suspect', fails, code: r.code,
        error: r.error || (r.code ? `HTTP ${r.code}` : 'no response'), ts: Date.now(),
        since: fails >= 2 ? (prev.since || Date.now()) : undefined,
      };
      if (fails === 1) setTimeout(() => checkOne(m), confirmMs).unref();   // confirm before calling it down
    }
    state.set(m.id, next);
    return next;
  }

  async function runCycle() {
    if (running) return;
    running = true;
    try {
      for (const m of checkable()) { await checkOne(m); await sleep(1500); }
      lastCycle = Date.now();
    } finally { running = false; }
  }

  return {
    start() {
      setTimeout(runCycle, 3000).unref();
      setInterval(runCycle, intervalMs).unref();
    },
    async recheck(id, cooldownMs = 30000) {
      const m = checkable().find((x) => x.id === id);
      if (!m) return null;
      const last = lastManual.get(id) || 0;
      if (Date.now() - last < cooldownMs) return { cooldown: true };
      lastManual.set(id, Date.now());
      return checkOne(m);
    },
    snapshot() {
      const out = {};
      for (const m of models) {
        out[m.id] = m.apiReady ? (state.get(m.id) || { status: 'unknown' }) : { status: 'preview' };
      }
      return { intervalMs, running, lastCycle, models: out };
    },
  };
}

module.exports = { createHealth };
