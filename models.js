// models.js — single source of truth for the chat models (server side).
// To add a model: copy a block, change id/name/category. That's it.
//
// vision:true    -> chat shows an image-attach button (text+image models).
// apiReady:false  -> card is shown greyed out as "preview only" and the server
//                    refuses to call it. Flip to true once NVIDIA opens its API.
// defaults        -> sent to NVIDIA with every request (temperature, top_p, ...).
// extra           -> any additional body fields, e.g. { reasoning_effort: 'high' }.
//
// Model IDs verified against build.nvidia.com on 2026-11-11.

module.exports = [
  // ---------- Flagship ----------
  {
    id: 'moonshotai/kimi-k3.1-pro', // GUESS: confirm exact id from the API tab once it opens
    name: 'Kimi K3.1 Pro',
    category: 'Flagship',
    tagline: '2.8T MoE, 1M context, agentic coding',
    ctx: '1M',
    apiReady: false,
    note: 'Playground only on build.nvidia.com — no API key works yet.',
    playground: 'https://build.nvidia.com/moonshotai/kimi-k3_1-pro',
    defaults: { temperature: 1.0, top_p: 0.95, max_tokens: 4096 },
  },
  {
    id: 'mistralai/mistral-large-4-1t-a52b',
    name: 'Mistral Large 4',
    category: 'Flagship',
    tagline: '1T MoE, text + image, reasoning',
    ctx: '262K',
    apiReady: true,
    vision: true,
    note: 'May need credits on a free key (a 402/403 means exactly that).',
    defaults: { temperature: 0.5, top_p: 1, max_tokens: 4096 },
    extra: {},
  },

  // ---------- Code & agents ----------
  {
    id: 'deepseek-ai/deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    category: 'Code & agents',
    tagline: '552B MoE (8B active), 1M context, reasoning',
    ctx: '1M',
    apiReady: true,
    vision: true,
    note: 'Free endpoint, but users reported long hangs/timeouts in Sept. Be patient or retry.',
    defaults: { temperature: 0.6, top_p: 0.95, max_tokens: 4096 },
  },
  {
    id: 'z-ai/glm-5.3-flash',
    name: 'GLM-5.3 Flash',
    category: 'Code & agents',
    tagline: '320B MoE (18B active), 1M context, reasoning + tools',
    ctx: '1M',
    apiReady: true,
    vision: true,
    note: 'Free endpoint; also had timeout reports in Sept.',
    defaults: { temperature: 0.5, top_p: 1, max_tokens: 4096 },
  },

  // ---------- Vision ----------
  {
    id: 'google/gemma-4-31b-it',
    name: 'Gemma 4 31B IT',
    category: 'Vision',
    tagline: 'dense 31B, text + image input, reasoning',
    ctx: '262K',
    apiReady: true,
    vision: true,
    note: 'Attach or paste images in chat. Video input is not wired up.',
    defaults: { temperature: 1.0, top_p: 0.95, max_tokens: 4096 },
  },

  // ---------- Fast ----------
  {
    id: 'nvidia/nemotron-3.5-bolt-e4b',
    name: 'Nemotron 3.5 Bolt E4B',
    category: 'Fast / light',
    tagline: '4B-effective, quick replies, tool use',
    ctx: '64K',
    apiReady: true,
    note: 'Small model: great for speed, weak at hard reasoning.',
    defaults: { temperature: 1, top_p: 0.95, max_tokens: 2048 },
  },
];
