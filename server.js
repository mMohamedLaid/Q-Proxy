// server.js - OpenAI to NVIDIA NIM Proxy with Multi-Provider Support
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================================
// API KEYS (set in Render environment variables)
// ============================================================
const NIM_API_KEY       = process.env.NIM_API_KEY;
const ZAI_API_KEY       = process.env.ZAI_API_KEY;
const GOOGLE_API_KEY    = process.env.GOOGLE_API_KEY;
const GOOGLE_RELAY_BASE = process.env.GOOGLE_RELAY_BASE || 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEEPSEEK_API_KEY  = process.env.DEEPSEEK_API_KEY; // worthless. thought it gave free tokens at first login.
const MEGANOVA_API_KEY  = process.env.MEGANOVA_API_KEY; // set this in Render once you've got a key from console.meganova.ai

const LITEROUTER_KEYS = [
  process.env.LITEROUTER_KEY_1,
].filter(Boolean);

const OPENROUTER_KEYS = [
  process.env.OPENROUTER_KEY_1,
  process.env.OPENROUTER_KEY_2,
  process.env.OPENROUTER_KEY_3,
  process.env.OPENROUTER_KEY_4,
  process.env.OPENROUTER_KEY_5,
].filter(Boolean);

// Literouter: simple round-robin (only one key configured right now anyway)
let literouterIndex = 0;
function getNextLiterouterKey() {
  const key = LITEROUTER_KEYS[literouterIndex % LITEROUTER_KEYS.length];
  literouterIndex++;
  return key;
}

// OpenRouter: drain key 1 fully (its full daily cap) before moving to key 2, etc.
// Resets daily. This is a self-tracked counter, not synced with OpenRouter's own
// dashboard, so a process restart resets it to 0 even if the real usage wasn't.
const OPENROUTER_DAILY_CAP = 50;
const openrouterKeyState = OPENROUTER_KEYS.map(() => ({ count: 0, day: '' }));
let openrouterKeyIndex = 0;

function getNextOpenRouterKey() {
  const today = new Date().toISOString().slice(0, 10);
  openrouterKeyState.forEach(s => { if (s.day !== today) { s.day = today; s.count = 0; } });

  for (let i = 0; i < OPENROUTER_KEYS.length; i++) {
    const idx = (openrouterKeyIndex + i) % OPENROUTER_KEYS.length;
    if (openrouterKeyState[idx].count < OPENROUTER_DAILY_CAP) {
      openrouterKeyIndex = idx;
      openrouterKeyState[idx].count++;
      return OPENROUTER_KEYS[idx];
    }
  }
  // all keys drained for today — hand back the last one, it'll 429 and bubble up
  return OPENROUTER_KEYS[openrouterKeyIndex];
}

// ============================================================
// DEEPSEEK ROLLING TOKEN BUDGET
// ============================================================
const DEEPSEEK_MONTHLY_TOKENS = parseInt(process.env.DEEPSEEK_MONTHLY_TOKENS || '5000000');
const deepseekBudget = {
  tokensUsed: 0,
  monthStart: new Date().toISOString().slice(0, 7),
};

function checkDeepSeekBudget() {
  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);
  if (currentMonth !== deepseekBudget.monthStart) {
    deepseekBudget.tokensUsed = 0;
    deepseekBudget.monthStart = currentMonth;
  }
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();
  const daysLeft = daysInMonth - dayOfMonth + 1;
  const tokensLeft = DEEPSEEK_MONTHLY_TOKENS - deepseekBudget.tokensUsed;
  const dailyLimit = Math.floor(tokensLeft / daysLeft);
  return { tokensLeft, dailyLimit, daysLeft };
}

// ============================================================
// USER KEYS / RATE LIMITING
// ── Keys come from env vars, NOT hardcoded.
// ── Set MY_KEY (and USER1_KEY etc.) in Render environment panel.
// ── To add a user: add USER2_KEY env var, add entry to SHARED_KEYS.
// ── To rotate a key: just change the env var, no redeploy needed.
// ============================================================
const MODE = 'solo'; // 'solo' | 'shared'

const SOLO_KEYS = {
  [process.env.MY_KEY]: { name: 'me', limit: 40 }
};

const SHARED_KEYS = {
  [process.env.MY_KEY]:    { name: 'me',    limit: 20   },
  [process.env.USER1_KEY]: { name: 'user1', limit: null },
  // [process.env.USER2_KEY]: { name: 'user2', limit: null },
  // [process.env.USER3_KEY]: { name: 'user3', limit: null },
};

function buildKeyMap() {
  const keys = {};
  const src = MODE === 'solo' ? SOLO_KEYS : SHARED_KEYS;
  for (const [k, v] of Object.entries(src)) {
    if (k && k !== 'undefined') keys[k] = v;
  }
  if (MODE !== 'solo') {
    const userKeys = Object.entries(keys).filter(([_, v]) => v.limit === null);
    const perUser = userKeys.length > 0 ? Math.floor(20 / userKeys.length) : 0;
    for (const [k, v] of userKeys) keys[k] = { ...v, limit: perUser };
  }
  return keys;
}

const usageTracker = {};

function checkRateLimit(apiKey) {
  const keyMap = buildKeyMap();
  const keyInfo = keyMap[apiKey];
  if (!keyInfo) return { allowed: false, reason: 'Invalid API key' };
  const now = Date.now();
  if (!usageTracker[apiKey] || now > usageTracker[apiKey].resetAt) {
    usageTracker[apiKey] = { count: 0, resetAt: now + 60000 };
  }
  if (usageTracker[apiKey].count >= keyInfo.limit) {
    const waitSec = Math.ceil((usageTracker[apiKey].resetAt - now) / 1000);
    return { allowed: false, reason: `Rate limit hit. Try again in ${waitSec}s` };
  }
  usageTracker[apiKey].count++;
  return { allowed: true };
}

// ============================================================
// LOGGING
// ============================================================
function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

// ============================================================
// TOKEN ESTIMATE (rough heuristic — chars/4 — good enough for a threshold check)
// ============================================================
function estimateTokens(messages) {
  const text = (messages || []).map(m => String(m.content || '')).join(' ');
  return Math.ceil(text.length / 4);
}

// ============================================================
// MODEL MAPPING
// ── Naming convention ───────────────────────────────────────
// model            → smart auto-route: walks the full fallback chain,
//                    tries providers in priority order until one works
// model-g          → Google AI Studio specifically
// model-nv         → NVIDIA NIM specifically
// model-z          → Z.AI specifically
// model-or         → OpenRouter specifically (round-robin/drain across keys)
// model-lr         → Literouter specifically
// model-mn         → MegaNova specifically
// model-ds         → DeepSeek direct API (disabled — $0 balance)
//
// thinking types:
// null   = no thinking params sent
// 'glm'  = enable_thinking:true (GLM style)
// 'dsv4' = thinking:true + reasoning_effort (DeepSeek V4 style)
//
// per-hop fields:
//   timeoutMs → overrides the default 300000ms timeout for that hop only
//   tpmLimit  → if set, the request's estimated token cost is checked
//               against this BEFORE the call is attempted; if it would
//               exceed the budget, that hop is skipped straight to the
//               next one in the chain (saves burning a doomed request)
//
// Provider base URLs:
//   NVIDIA NIM:   https://integrate.api.nvidia.com/v1
//   Z.AI:         https://api.z.ai/api/paas/v4
//   Google:       https://generativelanguage.googleapis.com/v1beta/openai
//   OpenRouter:   https://openrouter.ai/api/v1
//   Literouter:   https://api.literouter.com/v1  (~100 req/hr soft cap per model, not truly infinite)
//   MegaNova:     https://api.meganova.ai/v1
//   DeepSeek:     DISABLED — $0 balance, no free tokens
// ============================================================
const MODEL_MAPPING = {

  // ══════════════════════════════════════════════════════════
  // GLM-5.2
  // ══════════════════════════════════════════════════════════
  'glm-5.2-nv':       { model: 'z-ai/glm-5.2', provider: 'nvidia', thinking: null  }, // free ✅ 1M context
  'glm-5.2-think-nv': { model: 'z-ai/glm-5.2', provider: 'nvidia', thinking: 'glm' }, // free ✅ 1M context
  'glm-5.2-lr':       { model: 'glm-free',     provider: 'literouter', thinking: null }, // ~2400/day soft cap

  'glm-5.2':       { model: 'z-ai/glm-5.2', provider: 'nvidia', thinking: null,  fallback: { model: 'glm-free', provider: 'literouter', thinking: null } },
  'glm-5.2-think': { model: 'z-ai/glm-5.2', provider: 'nvidia', thinking: 'glm', fallback: { model: 'glm-free', provider: 'literouter', thinking: null } },


  // ══════════════════════════════════════════════════════════
  // GLM-4.7
  // ══════════════════════════════════════════════════════════
  'glm-4.7-nv':      { model: 'z-ai/glm4.7',   provider: 'nvidia', thinking: null }, // free ✅ thinks by default, NIM slug has no dash
  'glm-4.7-flash-z': { model: 'glm-4.7-flash', provider: 'zai',    thinking: null }, // PERMANENTLY FREE ✅ lowercase slug
  'glm-4.5-flash-z': { model: 'glm-4.5-flash', provider: 'zai',    thinking: null }, // PERMANENTLY FREE ✅ lowercase slug
  'glm-4.7-lr':      { model: 'glm-free',       provider: 'literouter', thinking: null },

  'glm-4.7':   { model: 'z-ai/glm4.7',   provider: 'nvidia', thinking: null, fallback: { model: 'glm-4.7-flash', provider: 'zai',        thinking: null } },
  'glm-flash': { model: 'glm-4.7-flash', provider: 'zai',    thinking: null, fallback: { model: 'glm-free',      provider: 'literouter', thinking: null } },


  // ══════════════════════════════════════════════════════════
  // Gemma 4
  // ══════════════════════════════════════════════════════════
  'gemma-4-31b-g':  { model: 'gemma-4-31b-it',     provider: 'google',     thinking: null, tpmLimit: 14000 }, // 14K RPD, 16K TPM — buffer kept under real cap
  'gemma-4-26b-g':  { model: 'gemma-4-26b-a4b-it', provider: 'google',     thinking: null, tpmLimit: 14000 }, // faster (MoE)
  'gemma-4-31b-nv': { model: 'google/gemma-4-31b-it', provider: 'nvidia', thinking: null }, // free ✅
  'gemma-4-31b-or': { model: 'google/gemma-4-31b-it:free',    provider: 'openrouter', thinking: null }, // 262K context, 50/day per key
  'gemma-4-26b-or': { model: 'google/gemma-4-26b-a4b-it:free', provider: 'openrouter', thinking: null },
  'gemma-3-27b-lr': { model: 'gemma-3-27b-it-free', provider: 'literouter', thinking: null }, // ⚠️ Gemma 3, not 4
  'gemma-lr':       { model: 'gemma-free',          provider: 'literouter', thinking: null }, // version unconfirmed

  // bare chain: Google first, NVIDIA next (dies after 30s instead of hanging), OpenRouter last.
  // Literouter left out of this chain on purpose — its Gemma slug's version isn't confirmed
  // to actually be Gemma 4, so it stays a manual pick only (gemma-lr / gemma-3-27b-lr).
  'gemma-4-31b': {
    model: 'gemma-4-31b-it', provider: 'google', thinking: null, tpmLimit: 14000,
    fallback: {
      model: 'google/gemma-4-31b-it', provider: 'nvidia', thinking: null, timeoutMs: 30000,
      fallback: {
        model: 'google/gemma-4-31b-it:free', provider: 'openrouter', thinking: null
      }
    }
  },
  'gemma-4-26b': { model: 'gemma-4-26b-a4b-it', provider: 'google', thinking: null, tpmLimit: 14000, fallback: { model: 'google/gemma-4-26b-a4b-it:free', provider: 'openrouter', thinking: null } },


  // ══════════════════════════════════════════════════════════
  // Gemini — Google AI Studio
  // ══════════════════════════════════════════════════════════
  'gemini-flash-lite-g': { model: 'gemini-3.1-flash-lite-preview', provider: 'google',     thinking: null }, // 500/day ✅ primary
  'gemini-flash-g':      { model: 'gemini-3-flash',                provider: 'google',     thinking: null }, // 20/day ⚠️ sparingly
  'gemini-2.5-flash-g':  { model: 'gemini-2.5-flash',              provider: 'google',     thinking: null }, // 20/day ⚠️ sparingly
  'gemini-lr':            { model: 'gemini-free',                   provider: 'literouter', thinking: null },
  'gemini':       { model: 'gemini-3.1-flash-lite-preview', provider: 'google', thinking: null, fallback: { model: 'gemini-free', provider: 'literouter', thinking: null } },
  'gemini-flash': { model: 'gemini-3-flash',                provider: 'google', thinking: null, fallback: { model: 'gemini-free', provider: 'literouter', thinking: null } },

  // free quota window: through Aug 20, 2026 — bills at standard rate from Aug 21 onward.
  // kept as a standalone pick, not wired into the 'gemini' chain above, so nothing
  // silently starts costing money once the window closes.
  'gemini-3.7-flash-mn': { model: 'gemini/gemini-3.7-flash', provider: 'meganova', thinking: null },


  // ══════════════════════════════════════════════════════════
  // DeepSeek
  // ══════════════════════════════════════════════════════════
  'deepseek-v4-pro-nv':         { model: 'deepseek-ai/deepseek-v4-pro',   provider: 'nvidia', thinking: null   }, // free ✅ 1M context, 40 RPM
  'deepseek-v4-pro-think-nv':   { model: 'deepseek-ai/deepseek-v4-pro',   provider: 'nvidia', thinking: 'dsv4' },
  'deepseek-v4-flash-nv':       { model: 'deepseek-ai/deepseek-v4-flash', provider: 'nvidia', thinking: null   }, // free ✅ 1M context, faster
  'deepseek-v4-flash-think-nv': { model: 'deepseek-ai/deepseek-v4-flash', provider: 'nvidia', thinking: 'dsv4' },
  'deepseek-v4-lr': { model: 'deepseek-v4-flash-free', provider: 'literouter', thinking: null },
  'deepseek-v3-lr': { model: 'deepseek-v3-0324-free',  provider: 'literouter', thinking: null },
  'deepseek-lr':    { model: 'deepseek-free',          provider: 'literouter', thinking: null },

  'deepseek-r1': { model: 'deepseek-ai/deepseek-v4-pro',   provider: 'nvidia', thinking: 'dsv4', fallback: { model: 'deepseek-free',          provider: 'literouter', thinking: null } },
  'deepseek-v4': { model: 'deepseek-ai/deepseek-v4-flash', provider: 'nvidia', thinking: null,   fallback: { model: 'deepseek-v4-flash-free', provider: 'literouter', thinking: null } },
  'deepseek-v3': { model: 'deepseek-v3-0324-free', provider: 'literouter', thinking: null, fallback: { model: 'deepseek-ai/deepseek-v4-flash', provider: 'nvidia', thinking: null } },


  // ══════════════════════════════════════════════════════════
  // Kimi (Moonshot AI)
  // ══════════════════════════════════════════════════════════
  'kimi-k2.6-nv': { model: 'moonshotai/kimi-k2.6', provider: 'nvidia', thinking: null }, // free ✅ 262K context
  'kimi-lr':      { model: 'kimi-k2.5-free',        provider: 'literouter', thinking: null },
  'kimi': { model: 'moonshotai/kimi-k2.6', provider: 'nvidia', thinking: null, fallback: { model: 'kimi-k2.5-free', provider: 'literouter', thinking: null } },


  // ══════════════════════════════════════════════════════════
  // GPT-OSS (OpenAI open weights)
  // ══════════════════════════════════════════════════════════
  'gpt-oss-120b-nv': { model: 'openai/gpt-oss-120b', provider: 'nvidia',     thinking: null },
  'gpt-oss-20b-nv':  { model: 'openai/gpt-oss-20b',  provider: 'nvidia',     thinking: null },
  'gpt-oss-120b-lr': { model: 'gpt-oss-120b-free',   provider: 'literouter', thinking: null },
  'gpt-oss-20b-lr':  { model: 'gpt-oss-20b-free',    provider: 'literouter', thinking: null },
  'gpt-oss-120b-or': { model: 'openai/gpt-oss-120b:free', provider: 'openrouter', thinking: null },
  'gpt-oss-20b-or':  { model: 'openai/gpt-oss-20b:free',  provider: 'openrouter', thinking: null },

  'gpt-oss-120b': { model: 'openai/gpt-oss-120b', provider: 'nvidia', thinking: null, fallback: { model: 'gpt-oss-120b-free', provider: 'literouter', thinking: null } },
  'gpt-oss-20b':  { model: 'openai/gpt-oss-20b',  provider: 'nvidia', thinking: null, fallback: { model: 'gpt-oss-20b-free',  provider: 'literouter', thinking: null } },


  // ══════════════════════════════════════════════════════════
  // Qwen / OpenRouter-only free models
  // ══════════════════════════════════════════════════════════
  'qwen3-coder-or':      { model: 'qwen/qwen3-coder:free',                  provider: 'openrouter', thinking: null }, // coding-focused
  'minimax-m2.5-or':     { model: 'minimax/minimax-m2.5:free',              provider: 'openrouter', thinking: null },
  'nemotron-3-super-or': { model: 'nvidia/nemotron-3-super-120b-a12b:free', provider: 'openrouter', thinking: null }, // 262K context

  'qwen3-32b-lr': { model: 'qwen3-32b-free',    provider: 'literouter', thinking: null }, // uncensored
  'qwen3-4b-lr':  { model: 'qwen3-4b-fp8-free', provider: 'literouter', thinking: null }, // uncensored, fast
  'qwen-lr':      { model: 'qwen-free',          provider: 'literouter', thinking: null },

  // near-frontier open-weight coder — 56.2 SWE-bench Pro, 200K context
  'minimax-m2.7-lr': { model: 'minimax-m2.7:free', provider: 'literouter', thinking: null },


  // ══════════════════════════════════════════════════════════
  // MiMo V2 Flash
  // ══════════════════════════════════════════════════════════
  'mimo-lr': { model: 'mimo-v2-flash-free', provider: 'literouter', thinking: null },


  // ══════════════════════════════════════════════════════════
  // Llama Nemotron
  // ══════════════════════════════════════════════════════════
  'llama-nemotron': { model: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', provider: 'nvidia', thinking: null },


  // ══════════════════════════════════════════════════════════
  // Misc Literouter free models (route through Pollinations)
  // ══════════════════════════════════════════════════════════
  'mistral-lr':  { model: 'mistral-free',  provider: 'literouter', thinking: null },
  'nemotron-lr': { model: 'nemotron-free', provider: 'literouter', thinking: null },
  'devstral-lr': { model: 'devstral-free', provider: 'literouter', thinking: null }, // coding specialist
  'grok-lr':     { model: 'grok-free',     provider: 'literouter', thinking: null },

};

// ============================================================
// PROVIDER CONFIG
// ============================================================
function getProviderConfig(provider) {
  switch (provider) {
    case 'zai':        return { base: 'https://api.z.ai/api/paas/v4',                key: ZAI_API_KEY };
    case 'google':     return { base: GOOGLE_RELAY_BASE,                             key: GOOGLE_API_KEY };
    case 'deepseek':   return { base: 'https://api.deepseek.com',                    key: DEEPSEEK_API_KEY };
    case 'openrouter': return { base: 'https://openrouter.ai/api/v1',                key: getNextOpenRouterKey() };
    case 'literouter': return { base: 'https://api.literouter.com/v1',               key: getNextLiterouterKey() };
    case 'meganova':   return { base: 'https://api.meganova.ai/v1',                  key: MEGANOVA_API_KEY };
    default:           return { base: 'https://integrate.api.nvidia.com/v1',         key: NIM_API_KEY };
  }
}

// ============================================================
// THINKING PARAMS
// ============================================================
function getExtraBody(thinkingType) {
  if (thinkingType === 'glm')  return { chat_template_kwargs: { enable_thinking: true, clear_thinking: false } };
  if (thinkingType === 'dsv4') return { chat_template_kwargs: { thinking: true, reasoning_effort: 'high' } };
  return undefined;
}

// ============================================================
// PARSE <think> TAGS
// ============================================================
function parseThinkTags(rawText) {
  if (!rawText) return { reasoning: null, content: rawText };
  const match = rawText.match(/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
  if (match) return { reasoning: match[1].trim(), content: match[2].trim() };
  return { reasoning: null, content: rawText };
}

// ============================================================
// MAKE API CALL (walks the full fallback chain, any depth)
// ── 4xx client errors do NOT trigger fallback (your request is
//    wrong; a different provider won't fix it).
// ── 5xx, 429 (rate limit), 408 (timeout), network errors DO
//    trigger fallback (server-side / transient issues).
// ── Exception: 401/403 also skip fallback (auth failure).
// ── A hop with tpmLimit set is skipped straight to the next hop
//    if the request's estimated tokens would exceed it.
// ============================================================
async function makeAPICall(mapping, nimRequest, stream) {
  const providers = [];
  let current = mapping;
  while (current) { providers.push(current); current = current.fallback; }

  let lastError;
  for (const providerConfig of providers) {
    if (providerConfig.tpmLimit) {
      const estimated = estimateTokens(nimRequest.messages) + (nimRequest.max_tokens || 0);
      if (estimated > providerConfig.tpmLimit) {
        log('WARN', `Skipping ${providerConfig.provider} — estimated ${estimated} tokens exceeds its ${providerConfig.tpmLimit} TPM budget`);
        continue;
      }
    }

    const { base, key } = getProviderConfig(providerConfig.provider);
    const extraBody = getExtraBody(providerConfig.thinking);
    const body = { ...nimRequest, model: providerConfig.model, ...(extraBody || {}) };

    try {
      const response = await axios.post(
        `${base}/chat/completions`,
        body,
        {
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          responseType: stream ? 'stream' : 'json',
          timeout: providerConfig.timeoutMs || 300000
        }
      );
      return { response, usedProvider: providerConfig.provider, usedModel: providerConfig.model };

    } catch (err) {
      const status = err.response?.status;

      if (status && status >= 400 && status < 500 && status !== 429 && status !== 408) {
        log('WARN', `Provider ${providerConfig.provider} returned ${status} (client error) — not falling back`);
        throw err;
      }

      log('WARN', `Provider ${providerConfig.provider} failed [${status || 'network/timeout'}]: ${err.message} — trying fallback...`);
      lastError = err;
    }
  }
  throw lastError;
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  const keyMap = buildKeyMap();
  const now = Date.now();
  const status = Object.entries(keyMap).map(([key, info]) => ({
    name: info.name,
    limit: info.limit,
    used: usageTracker[key]?.count || 0,
    resetsIn: usageTracker[key]
      ? Math.max(0, Math.ceil((usageTracker[key].resetAt - now) / 1000)) + 's'
      : 'n/a'
  }));
  const dsBudget = checkDeepSeekBudget();
  const today = new Date().toISOString().slice(0, 10);
  const orStatus = OPENROUTER_KEYS.map((_, i) => ({
    key: `OPENROUTER_KEY_${i + 1}`,
    usedToday: openrouterKeyState[i].day === today ? openrouterKeyState[i].count : 0,
    cap: OPENROUTER_DAILY_CAP
  }));
  res.json({
    status: 'ok',
    mode: MODE,
    users: status,
    deepseek_budget: {
      tokens_left: dsBudget.tokensLeft,
      daily_limit: dsBudget.dailyLimit,
      days_left: dsBudget.daysLeft
    },
    openrouter_keys: orStatus,
    literouter_keys: LITEROUTER_KEYS.length
  });
});

// ============================================================
// BUDGET CHECK ENDPOINT
// ============================================================
app.get('/budget', (req, res) => {
  const ds = checkDeepSeekBudget();
  res.json({
    deepseek: {
      monthly_total: DEEPSEEK_MONTHLY_TOKENS,
      tokens_used: deepseekBudget.tokensUsed,
      tokens_left: ds.tokensLeft,
      daily_limit_today: ds.dailyLimit,
      days_left_in_month: ds.daysLeft
    }
  });
});

// ============================================================
// MODELS LIST
// ============================================================
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(m => ({
    id: m, object: 'model', created: Date.now(), owned_by: 'nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

// ============================================================
// CHAT ENDPOINT
// ============================================================
app.post('/v1/chat/completions', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const userKey = authHeader.replace('Bearer ', '').trim();
  const keyMap = buildKeyMap();
  const userName = keyMap[userKey]?.name || 'unknown';

  const rateCheck = checkRateLimit(userKey);
  if (!rateCheck.allowed) {
    log('WARN', `[${userName}] Rate limit hit`);
    return res.status(429).json({
      error: { message: rateCheck.reason, type: 'rate_limit_error', code: 429 }
    });
  }

  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    log('INFO', `[${userName}] REQUEST → model: ${model} | stream: ${stream || false}`);
    messages.forEach((m, i) => {
      log('DEBUG', `  [msg ${i}] ${m.role}: ${String(m.content).slice(0, 300)}`);
    });

    const mapping = MODEL_MAPPING[model];
    if (!mapping) {
      return res.status(404).json({
        error: { message: `Model "${model}" not found. GET /v1/models for full list.`, type: 'invalid_request_error', code: 404 }
      });
    }

    const nimRequest = {
      model: mapping.model,
      messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      stream: stream || false
    };

    const { response, usedProvider, usedModel } = await makeAPICall(mapping, nimRequest, stream || false);
    log('INFO', `[${userName}] → provider: ${usedProvider} | model: ${usedModel}`);

    if (usedProvider === 'deepseek' && !stream) {
      const tokens = response.data?.usage?.total_tokens || 0;
      deepseekBudget.tokensUsed += tokens;
      log('INFO', `[DeepSeek budget] used ${tokens} tokens | total this month: ${deepseekBudget.tokensUsed}`);
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let thinkBuffer = '';
      let inThink = false;
      let thinkSent = false;
      let accumRaw = '';

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(line => {
          if (!line.startsWith('data: ')) return;
          if (line.includes('[DONE]')) { res.write(line + '\n\n'); return; }

          try {
            const data = JSON.parse(line.slice(6));
            const delta = data.choices?.[0]?.delta;
            if (!delta) { res.write(`data: ${JSON.stringify(data)}\n\n`); return; }

            const nativeReasoning = delta.reasoning_content || null;
            const rawContent = delta.content || '';

            log('DEBUG', `[CHUNK] native_reasoning: ${JSON.stringify(nativeReasoning?.slice(0, 80))} | content: ${JSON.stringify(rawContent?.slice(0, 80))}`);

            if (nativeReasoning) {
              res.write(`data: ${JSON.stringify(data)}\n\n`);
              return;
            }

            accumRaw += rawContent;

            if (!inThink && !thinkSent) {
              if (accumRaw.includes('<think>')) {
                inThink = true;
                const start = accumRaw.indexOf('<think>') + 7;
                thinkBuffer += accumRaw.slice(start);
                accumRaw = '';
                return;
              } else if (accumRaw.length > 10 && !accumRaw.startsWith('<')) {
                thinkSent = true;
              }
            }

            if (inThink) {
              thinkBuffer += rawContent;
              if (thinkBuffer.includes('</think>')) {
                const end = thinkBuffer.indexOf('</think>');
                const reasoningText = thinkBuffer.slice(0, end).trim();
                const afterThink = thinkBuffer.slice(end + 8).trim();
                inThink = false;
                thinkSent = true;

                const reasoningChunk = {
                  ...data,
                  choices: [{
                    ...data.choices[0],
                    delta: { role: 'assistant', content: '', reasoning_content: reasoningText }
                  }]
                };
                res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);

                if (afterThink) {
                  delta.content = afterThink;
                  delete delta.reasoning_content;
                  res.write(`data: ${JSON.stringify(data)}\n\n`);
                }
              }
              return;
            }

            delta.content = rawContent;
            delete delta.reasoning_content;
            res.write(`data: ${JSON.stringify(data)}\n\n`);

          } catch (e) {
            log('ERROR', `chunk parse error: ${e.message}`);
            res.write(line + '\n');
          }
        });
      });

      response.data.on('end', () => {
        log('INFO', `[${userName}] ✓ stream complete`);
        res.end();
      });
      response.data.on('error', (err) => {
        log('ERROR', `[${userName}] stream error: ${err.message}`);
        res.end();
      });

    } else {
      const rawText = response.data.choices[0]?.message?.content || '';
      const nativeReasoning = response.data.choices[0]?.message?.reasoning_content || null;

      log('DEBUG', `[${userName}] RESPONSE: native_reasoning: ${!!nativeReasoning} | content length: ${rawText.length}`);

      const { reasoning, content } = parseThinkTags(rawText);
      const finalReasoning = nativeReasoning || reasoning;

      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: {
            role: response.data.choices[0].message.role,
            content: content,
            ...(finalReasoning ? { reasoning_content: finalReasoning } : {})
          },
          finish_reason: response.data.choices[0].finish_reason
        }],
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };

      res.json(openaiResponse);
    }

  } catch (error) {
    let errorBody = 'unavailable';
    try { errorBody = JSON.stringify(error.response?.data); } catch (e) { errorBody = '[stream/circular error]'; }
    log('ERROR', `[${userName}] ${error.message} | status: ${error.response?.status} | body: ${errorBody}`);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found`, type: 'invalid_request_error', code: 404 } });
});

app.listen(PORT, () => {
  log('INFO', `Proxy running on port ${PORT} — mode: ${MODE}`);
  log('INFO', `OpenRouter keys loaded: ${OPENROUTER_KEYS.length}`);
  log('INFO', `Literouter keys loaded: ${LITEROUTER_KEYS.length}`);
});
