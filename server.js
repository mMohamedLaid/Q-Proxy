// server.js - OpenAI to NVIDIA NIM Proxy with Multi-Provider Support
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============================================================
// API KEYS (set in Render environment variables)
// ============================================================
const NIM_API_KEY      = process.env.NIM_API_KEY;
const ZAI_API_KEY      = process.env.ZAI_API_KEY;
const GOOGLE_API_KEY   = process.env.GOOGLE_API_KEY;
const GOOGLE_RELAY_BASE = process.env.GOOGLE_RELAY_BASE || 'https://generativelanguage.googleapis.com/v1beta/openai';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; //worthless. thought it gave free tokens at first login.

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

// Round-robin trackers
let openrouterIndex = 0;
let literouterIndex = 0;

function getNextOpenRouterKey() {
  const key = OPENROUTER_KEYS[openrouterIndex % OPENROUTER_KEYS.length];
  openrouterIndex++;
  return key;
}

function getNextLiterouterKey() {
  const key = LITEROUTER_KEYS[literouterIndex % LITEROUTER_KEYS.length];
  literouterIndex++;
  return key;
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
  // Filter out any undefined keys (env vars not set)
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
// MODEL MAPPING
// ── Naming convention ───────────────────────────────────────
// model-nv        → NVIDIA NIM specifically
// model-z         → Z.AI specifically
// model-g         → Google AI Studio specifically
// model-ds        → DeepSeek direct API
// model-or        → OpenRouter round-robin
// model-lit       → Literouter round-robin
// model (no suffix) → smart auto-route, best available
//
// thinking types:
// null   = no thinking params sent
// 'glm'  = enable_thinking:true (GLM style)
// 'dsv4' = thinking:true + reasoning_effort (DeepSeek V4 style)
//
// ── Verified model IDs (May 2026) ───────────────────────────
// NVIDIA NIM base:   https://integrate.api.nvidia.com/v1
// Z.AI base:         https://api.z.ai/api/paas/v4   ← FIXED (was /api/openai/v1)
// Google base:       https://generativelanguage.googleapis.com/v1beta/openai
// DeepSeek base:     https://api.deepseek.com
// OpenRouter base:   https://openrouter.ai/api/v1
// LiteRouter base:   https://api.literouter.com/v1
// ============================================================
/*const MODEL_MAPPING = {

  // ══════════════════════════════════════════════════════════
  // GLM-5.1
  // ── NVIDIA: z-ai/glm-5.1              ✅ verified
  // ── Z.AI:   glm-5.1                   ✅ verified
  // ── OpenRouter: z-ai/glm-5.1 (paid)   ✅ verified
  //    No free GLM-5 on OpenRouter; nearest free = glm-4.5-air:free
  // ══════════════════════════════════════════════════════════
  'glm-5.1-nv':          { model: 'z-ai/glm-5.1',           provider: 'nvidia',     thinking: null  },
  'glm-5.1-think-nv':    { model: 'z-ai/glm-5.1',           provider: 'nvidia',     thinking: 'glm' },
  'glm-5.1-z':           { model: 'glm-5.1',                provider: 'zai',        thinking: null  },
  'glm-5.1-think-z':     { model: 'glm-5.1',                provider: 'zai',        thinking: 'glm' },
  'glm-5.1-or':          { model: 'z-ai/glm-5.1',           provider: 'openrouter', thinking: null  }, // paid ~$1.05/M
  'glm-5.1-lit':         { model: 'glm-free',               provider: 'literouter', thinking: null  },
  // auto: try Z.AI first, fallback NVIDIA
  'glm-5.1':             { model: 'glm-5.1',                provider: 'zai',        thinking: null,  fallback: { model: 'z-ai/glm-5.1',  provider: 'nvidia', thinking: null  } },
  'glm-5.1-think':       { model: 'glm-5.1',                provider: 'zai',        thinking: 'glm', fallback: { model: 'z-ai/glm-5.1',  provider: 'nvidia', thinking: 'glm' } },

  // ══════════════════════════════════════════════════════════
  // GLM-4.7
  // ── NVIDIA: z-ai/glm4.7               ✅ verified (NIM slug is glm4.7 not glm-4.7)
  // ── Z.AI:   glm-4.7                   ✅ verified
  // ══════════════════════════════════════════════════════════
  'glm-4.7-nv':          { model: 'z-ai/glm4.7',            provider: 'nvidia',     thinking: null  },
  'glm-4.7-think-nv':    { model: 'z-ai/glm4.7',            provider: 'nvidia',     thinking: null  }, // thinks by default on NIM
  'glm-4.7-z':           { model: 'glm-4.7',                provider: 'zai',        thinking: null  },
  'glm-4.7-flash-z':     { model: 'glm-4.7-flash',          provider: 'zai',        thinking: null  }, // FIXED: was glm-4.7-Flash (lowercase)
  'glm-4.7-lit':         { model: 'glm-free',               provider: 'literouter', thinking: null  },
  // auto: NVIDIA (confirmed working + thinks by default)
  'glm-4.7':             { model: 'z-ai/glm4.7',            provider: 'nvidia',     thinking: null,  fallback: { model: 'glm-4.7', provider: 'zai', thinking: null } },

  // ══════════════════════════════════════════════════════════
  // GLM Flash (Z.AI free renewable)
  // ══════════════════════════════════════════════════════════
  'glm-4.7-flash':       { model: 'glm-4.7-flash',          provider: 'zai',        thinking: null  }, // FIXED: was glm-4.7-Flash
  'glm-4.5-flash':       { model: 'glm-4.5-flash',          provider: 'zai',        thinking: null  }, // FIXED: was glm-4.5-Flash
  // Free GLM on OpenRouter (best available free tier as of May 2026)
  'glm-free-or':         { model: 'z-ai/glm-4.5-air:free',  provider: 'openrouter', thinking: null  },

  // ══════════════════════════════════════════════════════════
  // DeepSeek
  // ── NVIDIA: deepseek-ai/deepseek-v4-pro   ✅ verified (added Apr 2026)
  // ── NVIDIA: deepseek-ai/deepseek-v3.2     ✅ verified
  // ── OR free: deepseek/deepseek-chat-v3.2:free  ✅ verified
  // ── OR free: deepseek/deepseek-r1:free        ✅ verified
  // ── NOTE: deepseek-v4-flash:free does NOT exist on OR (V4 is paid)
  // ══════════════════════════════════════════════════════════
  'deepseek-v4-nv':      { model: 'deepseek-ai/deepseek-v4-pro',   provider: 'nvidia',     thinking: null   },
  'deepseek-v4-think-nv':{ model: 'deepseek-ai/deepseek-v4-pro',   provider: 'nvidia',     thinking: 'dsv4' },
  'deepseek-v3.2-nv':    { model: 'deepseek-ai/deepseek-v3.2',     provider: 'nvidia',     thinking: null   },
  'deepseek-v4-ds':      { model: 'deepseek-chat',                 provider: 'deepseek',   thinking: null   },
  'deepseek-r1-ds':      { model: 'deepseek-reasoner',             provider: 'deepseek',   thinking: null   },
  'deepseek-v4-or':      { model: 'deepseek/deepseek-v4-flash',    provider: 'openrouter', thinking: null   }, // paid ~$0.14/M (very cheap)
  'deepseek-v3-or':      { model: 'deepseek/deepseek-chat-v3.2:free', provider: 'openrouter', thinking: null }, // FREE ✅ FIXED (was v4:free which doesn't exist)
  'deepseek-r1-or':      { model: 'deepseek/deepseek-r1:free',     provider: 'openrouter', thinking: null   }, // FREE ✅
  'deepseek-lit':        { model: 'deepseek-free',                 provider: 'literouter', thinking: null   },
  // auto: free V3 on OpenRouter, fallback DeepSeek direct
  'deepseek-v4':         { model: 'deepseek/deepseek-v4-flash',    provider: 'openrouter', thinking: null,  fallback: { model: 'deepseek-chat',     provider: 'deepseek', thinking: null } },
  'deepseek-r1':         { model: 'deepseek/deepseek-r1:free',     provider: 'openrouter', thinking: null,  fallback: { model: 'deepseek-reasoner', provider: 'deepseek', thinking: null } },

  // ══════════════════════════════════════════════════════════
  // Gemini
  // ── FIXED: gemini-2.5-pro-preview-05-06  → gemini-3.1-pro-preview
  // ── FIXED: gemini-2.5-flash-preview-04-17 → gemini-3-flash-preview
  // ── Stable aliases: gemini-2.5-pro, gemini-2.5-flash also work
  // ══════════════════════════════════════════════════════════
  'gemini-g':            { model: 'gemini-3.1-pro-preview',        provider: 'google',     thinking: null },
  'gemini-flash-g':      { model: 'gemini-3-flash-preview',        provider: 'google',     thinking: null },
  'gemini-stable-g':     { model: 'gemini-2.5-pro',               provider: 'google',     thinking: null }, // stable alias
  'gemini-flash-stable-g':{ model: 'gemini-2.5-flash',            provider: 'google',     thinking: null }, // stable alias
  'gemini-lit':          { model: 'gemini-free',                   provider: 'literouter', thinking: null },
  // auto: Google AI Studio
  'gemini':              { model: 'gemini-3.1-pro-preview',        provider: 'google',     thinking: null,  fallback: { model: 'gemini-free', provider: 'literouter', thinking: null } },
  'gemini-flash':        { model: 'gemini-3-flash-preview',        provider: 'google',     thinking: null,  fallback: { model: 'gemini-free', provider: 'literouter', thinking: null } },

  // ══════════════════════════════════════════════════════════
  // Kimi
  // ── NVIDIA: moonshotai/kimi-k2-instruct-0905  (Sep 2025 update, likely on NIM)
  // ── OpenRouter: moonshotai/kimi-k2.5 (paid $0.44/M)
  // ── OpenRouter FREE: moonshotai/kimi-k2-thinking:free ✅ FIXED
  // ── LiteRouter: kimi-k2.5-free ✅
  // ══════════════════════════════════════════════════════════
  'kimi-nv':             { model: 'moonshotai/kimi-k2-instruct-0905', provider: 'nvidia',     thinking: null },
  'kimi-or':             { model: 'moonshotai/kimi-k2.5',             provider: 'openrouter', thinking: null }, // paid
  'kimi-think-or':       { model: 'moonshotai/kimi-k2-thinking:free', provider: 'openrouter', thinking: null }, // FREE ✅ FIXED
  'kimi-lit':            { model: 'kimi-k2.5-free',                   provider: 'literouter', thinking: null },
  // auto: paid K2.5 on OR (best quality), fallback NVIDIA
  'kimi':                { model: 'moonshotai/kimi-k2.5',             provider: 'openrouter', thinking: null, fallback: { model: 'moonshotai/kimi-k2-instruct-0905', provider: 'nvidia', thinking: null } },

  // ══════════════════════════════════════════════════════════
  // GPT-OSS (NVIDIA + OpenRouter free)
  // ── NVIDIA: openai/gpt-oss-120b  ✅ verified
  // ── NVIDIA: openai/gpt-oss-20b   ✅ verified
  // ── OR free: openai/gpt-oss-120b:free ✅ verified
  // ══════════════════════════════════════════════════════════
  'gpt-oss-120b':        { model: 'openai/gpt-oss-120b',       provider: 'nvidia',     thinking: null },
  'gpt-oss-20b':         { model: 'openai/gpt-oss-20b',        provider: 'nvidia',     thinking: null },
  'gpt-oss-120b-or':     { model: 'openai/gpt-oss-120b:free',  provider: 'openrouter', thinking: null }, // FREE ✅
  'gpt-oss-20b-or':      { model: 'openai/gpt-oss-20b:free',   provider: 'openrouter', thinking: null }, // FREE ✅
  'gpt-oss-120b-lit':    { model: 'gpt-oss-120b-free',         provider: 'literouter', thinking: null },
  'gpt-oss-20b-lit':     { model: 'gpt-oss-20b-free',          provider: 'literouter', thinking: null },

  // ══════════════════════════════════════════════════════════
  // Qwen (NVIDIA)
  // ⚠️  These model IDs are UNVERIFIED on NIM as of May 2026.
  //     If you get 404s, check https://build.nvidia.com/models
  //     and update the model slugs.
  // ══════════════════════════════════════════════════════════
  'qwen-coder':          { model: 'qwen/qwen3-coder-480b-a35b-instruct', provider: 'nvidia', thinking: null },
  'qwen-thinking':       { model: 'qwen/qwen3-next-80b-a3b-thinking',    provider: 'nvidia', thinking: null },

  // ══════════════════════════════════════════════════════════
  // Llama Nemotron (NVIDIA)
  // ── nvidia/llama-3.1-nemotron-ultra-253b-v1  ✅ verified
  // ══════════════════════════════════════════════════════════
  'llama-nemotron':      { model: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', provider: 'nvidia', thinking: null },
};
*/
// ============================================================
// MODEL MAPPING — 100% FREE ONLY (verified May 2026)
//
// Naming convention:
//   model-nv   → NVIDIA NIM
//   model-z    → Z.AI (flash = free forever; full = paid, DISABLED)
//   model-g    → Google AI Studio
//   model-or   → OpenRouter round-robin
//   model-lit  → Literouter round-robin
//   model      → smart auto-route, best available
//
// Thinking types:
//   null   = no thinking params sent
//   'glm'  = chat_template_kwargs: { enable_thinking: true }
//   'dsv4' = chat_template_kwargs: { thinking: true, reasoning_effort: 'high' }
//
// Fallback: code only reads ONE level of fallback.
//   { model, provider, fallback: { model, provider } }  ← works
//   { ..., fallback: { ..., fallback: {} } }            ← level 2 silently ignored!
//
// Provider base URLs:
//   NVIDIA NIM:   https://integrate.api.nvidia.com/v1
//   Z.AI:         https://api.z.ai/api/paas/v4
//   Google:       https://generativelanguage.googleapis.com/v1beta/openai
//   OpenRouter:   https://openrouter.ai/api/v1
//   Literouter:   https://api.literouter.com/v1
//   DeepSeek:     DISABLED — $0 balance, no free tokens
// ============================================================
const MODEL_MAPPING = {

// ══════════════════════════════════════════════════════════
  // GLM-5.2
  //
  // NVIDIA NIM:  z-ai/glm-5.2 ✅ free endpoint, 1M context
  // Z.AI paid:   glm-5.2 DISABLED — balance $0, would charge real money
  // Literouter:  glm-free ✅ ∞/day (unknown GLM version, fast)
  //
  // Auto route:  NVIDIA first (free) → Literouter fallback (fast, unknown ver)
  // ══════════════════════════════════════════════════════════
  'glm-5.2-nv':        { model: 'z-ai/glm-5.2', provider: 'nvidia', thinking: null  }, // free ✅
  'glm-5.2-think-nv':  { model: 'z-ai/glm-5.2', provider: 'nvidia', thinking: 'glm' }, // free ✅
  // 'glm-5.2-z':      { model: 'glm-5.2',       provider: 'zai',   thinking: null  }, // PAID — disabled ($0 balance)
  // 'glm-5.2-think-z':{ model: 'glm-5.2',       provider: 'zai',   thinking: 'glm' }, // PAID — disabled ($0 balance)
  'glm-5.2-lit':       { model: 'glm-free',      provider: 'literouter', thinking: null }, // ∞/day ✅

  'glm-5.2':       { model: 'z-ai/glm-5.2', provider: 'nvidia', thinking: null,  fallback: { model: 'glm-free', provider: 'literouter', thinking: null } },
  'glm-5.2-think': { model: 'z-ai/glm-5.2', provider: 'nvidia', thinking: 'glm', fallback: { model: 'glm-free', provider: 'literouter', thinking: null } },

  // ══════════════════════════════════════════════════════════
  // GLM-4.7
  //
  // NVIDIA NIM:  z-ai/glm4.7 ✅ free endpoint — thinks by default, ~1 min
  //              NOTE: NIM slug is glm4.7 (no dash), NOT glm-4.7
  // Z.AI full:   glm-4.7 DISABLED — paid ($0.6/$2.2 per M tokens, balance $0)
  // Z.AI flash:  glm-4.7-flash ✅ PERMANENTLY FREE regardless of balance
  // Z.AI flash:  glm-4.5-flash ✅ PERMANENTLY FREE regardless of balance
  //              NOTE: model IDs are lowercase — glm-4.7-flash NOT glm-4.7-Flash
  // Literouter:  glm-free ✅ ∞/day (unknown GLM version)
  //
  // Auto route:  NVIDIA (confirmed working) → Z.AI flash fallback (free)
  // ══════════════════════════════════════════════════════════
  'glm-4.7-nv':      { model: 'z-ai/glm4.7',   provider: 'nvidia',     thinking: null }, // free ✅ thinks by default
  // 'glm-4.7-z':    { model: 'glm-4.7',        provider: 'zai',        thinking: null }, // PAID — disabled ($0 balance)
  'glm-4.7-flash-z': { model: 'glm-4.7-flash', provider: 'zai',        thinking: null }, // PERMANENTLY FREE ✅ lowercase!
  'glm-4.5-flash-z': { model: 'glm-4.5-flash', provider: 'zai',        thinking: null }, // PERMANENTLY FREE ✅ lowercase!
  'glm-lit':         { model: 'glm-free',       provider: 'literouter', thinking: null }, // ∞/day ✅

  'glm-4.7':   { model: 'z-ai/glm4.7',   provider: 'nvidia',     thinking: null, fallback: { model: 'glm-4.7-flash', provider: 'zai',        thinking: null } },
  'glm-flash': { model: 'glm-4.7-flash', provider: 'zai',        thinking: null, fallback: { model: 'glm-free',      provider: 'literouter', thinking: null } },


  // ══════════════════════════════════════════════════════════
  // Gemma 4 — BEST free daily quota anywhere
  //
  // Google AI Studio limits (free tier):
  //   gemma-4-31b-it:      15 RPM, unlimited TPM, 1500 RPD ✅ PRIMARY
  //   gemma-4-26b-a4b-it:  15 RPM, unlimited TPM, 1500 RPD ✅ MoE (3.8B active → faster)
  // OpenRouter free:
  //   google/gemma-4-31b-it:free      50/day per key ✅
  //   google/gemma-4-26b-a4b-it:free  50/day per key ✅
  // Literouter:
  //   gemma-3-27b-it-free  ∞/day ✅ (Gemma 3 not 4 — different model!)
  //   gemma-free           ∞/day ✅ (unknown Gemma version)
  //
  // ⚠️  Google AI Studio model strings unverified — test gemma-4-31b-it
  //     against the Studio UI before relying on it in prod.
  //
  // Auto route: Google (1500/day) → OR fallback (extra capacity)
  // ══════════════════════════════════════════════════════════
  'gemma-4-31b-g':   { model: 'gemma-4-31b-it',               provider: 'google',     thinking: null }, // 1500/day ✅
  'gemma-4-26b-g':   { model: 'gemma-4-26b-a4b-it',           provider: 'google',     thinking: null }, // 1500/day ✅ faster (MoE)
  'gemma-4-31b-or':  { model: 'google/gemma-4-31b-it:free',   provider: 'openrouter', thinking: null }, // 50/day per key ✅
  'gemma-4-26b-or':  { model: 'google/gemma-4-26b-a4b-it:free', provider: 'openrouter', thinking: null }, // 50/day per key ✅
  'gemma-3-27b-lit': { model: 'gemma-3-27b-it-free',          provider: 'literouter', thinking: null }, // ∞/day ✅ (Gemma 3!)
  'gemma-lit':       { model: 'gemma-free',                   provider: 'literouter', thinking: null }, // ∞/day ✅ version unknown
  'gemma-4':      { model: 'gemma-4-31b-it',     provider: 'google',     thinking: null, fallback: { model: 'google/gemma-4-31b-it:free',    provider: 'openrouter', thinking: null } },
  'gemma-4-fast': { model: 'gemma-4-26b-a4b-it', provider: 'google',     thinking: null, fallback: { model: 'google/gemma-4-26b-a4b-it:free', provider: 'openrouter', thinking: null } },


  // ══════════════════════════════════════════════════════════
  // Gemini — Google AI Studio
  //
  // Free tier limits:
  //   gemini-3.1-flash-lite-preview:  15 RPM, 250K TPM, 500 RPD ✅ BEST for daily use
  //   gemini-3-flash:                  5 RPM, 250K TPM,  20 RPD ⚠️ use sparingly
  //   gemini-2.5-flash:                5 RPM, 250K TPM,  20 RPD ⚠️ use sparingly
  //   gemini-2.5-pro / 3.1-pro:       LOCKED on free tier — 0 RPD
  // Literouter:
  //   gemini-free  ∞/day ✅ (unknown Gemini version, routes through Pollinations)
  //
  // Auto route: flash-lite (500/day) → Literouter fallback
  // ══════════════════════════════════════════════════════════
  'gemini-flash-lite-g': { model: 'gemini-3.1-flash-lite-preview', provider: 'google',     thinking: null }, // 500/day ✅ primary
  'gemini-flash-g':      { model: 'gemini-3-flash',                provider: 'google',     thinking: null }, // 20/day ⚠️ sparingly
  'gemini-2.5-flash-g':  { model: 'gemini-2.5-flash',             provider: 'google',     thinking: null }, // 20/day ⚠️ sparingly
  // 'gemini-g':         { model: 'gemini-3.1-pro-preview', ... }  // LOCKED — free tier 0 RPD
  // 'gemini-stable-g':  { model: 'gemini-2.5-pro', ... }          // LOCKED — free tier 0 RPD
  'gemini-lit':          { model: 'gemini-free',                   provider: 'literouter', thinking: null }, // ∞/day ✅ version unknown
  'gemini':       { model: 'gemini-3.1-flash-lite-preview', provider: 'google',     thinking: null, fallback: { model: 'gemini-free', provider: 'literouter', thinking: null } },
  'gemini-flash': { model: 'gemini-3-flash',                provider: 'google',     thinking: null, fallback: { model: 'gemini-free', provider: 'literouter', thinking: null } },


// ══════════════════════════════════════════════════════════
  // DeepSeek — NVIDIA NIM now hosts free V4 endpoints
  //
  // NVIDIA NIM: deepseek-ai/deepseek-v4-pro   ✅ free, 1M context, 40 RPM
  // NVIDIA NIM: deepseek-ai/deepseek-v4-flash ✅ free, 1M context, 40 RPM, faster/smaller
  // Both use thinking:true + reasoning_effort:'high' via chat_template_kwargs (the 'dsv4' type)
  // ══════════════════════════════════════════════════════════
  'deepseek-v4-pro-nv':        { model: 'deepseek-ai/deepseek-v4-pro',   provider: 'nvidia', thinking: null   },
  'deepseek-v4-pro-think-nv':  { model: 'deepseek-ai/deepseek-v4-pro',   provider: 'nvidia', thinking: 'dsv4' },
  'deepseek-v4-flash-nv':      { model: 'deepseek-ai/deepseek-v4-flash', provider: 'nvidia', thinking: null   },
  'deepseek-v4-flash-think-nv':{ model: 'deepseek-ai/deepseek-v4-flash', provider: 'nvidia', thinking: 'dsv4' },
  // DeepSeek direct: $0 balance, no free tokens. Removed.
  // OpenRouter free:
  //   deepseek/deepseek-r1:free            ✅ 50/day per key
  //   deepseek/deepseek-chat-v3-0324:free  ✅ 50/day per key
  //   ⚠️  There is NO deepseek/deepseek-v4-flash:free — V4 is paid only on OR
  //   ⚠️  deepseek-chat-v3.2:free is a WRONG slug — correct is v3-0324:free
  // Literouter:
  //   deepseek-v4-flash-free  ✅ 30/day (ONLY place to get free V4!)
  //   deepseek-v3-0324-free   ✅ 30/day
  //   deepseek-free           ✅ 30/day (unknown version)
  //
  // Auto route:
  //   deepseek-r1: OR free → literouter fallback
  //   deepseek-v4: literouter (only free V4 source) → OR V3 fallback
  //   deepseek-v3: OR free → literouter fallback
  // ══════════════════════════════════════════════════════════
  'deepseek-r1-or':  { model: 'deepseek/deepseek-r1:free',           provider: 'openrouter', thinking: null }, // 50/day ✅
  'deepseek-v3-or':  { model: 'deepseek/deepseek-chat-v3-0324:free', provider: 'openrouter', thinking: null }, // 50/day ✅ NOT v3.2:free!
  'deepseek-v4-lit': { model: 'deepseek-v4-flash-free',              provider: 'literouter', thinking: null }, // 30/day ✅ only free V4
  'deepseek-v3-lit': { model: 'deepseek-v3-0324-free',               provider: 'literouter', thinking: null }, // 30/day ✅
  'deepseek-lit':    { model: 'deepseek-free',                       provider: 'literouter', thinking: null }, // 30/day ✅ version unknown

  'deepseek-r1': { model: 'deepseek/deepseek-r1:free',           provider: 'openrouter', thinking: null, fallback: { model: 'deepseek-free',              provider: 'literouter', thinking: null } },
  'deepseek-v4': { model: 'deepseek-v4-flash-free',              provider: 'literouter', thinking: null, fallback: { model: 'deepseek/deepseek-chat-v3-0324:free', provider: 'openrouter', thinking: null } },
  'deepseek-v3': { model: 'deepseek/deepseek-chat-v3-0324:free', provider: 'openrouter', thinking: null, fallback: { model: 'deepseek-v3-0324-free',        provider: 'literouter', thinking: null } },


  // ══════════════════════════════════════════════════════════
  // Kimi (Moonshot AI)
  //
  // NVIDIA NIM:   moonshotai/kimi-k2-instruct-0905 ✅ free
  //               ⚠️  Deprecating soon — check build.nvidia.com for updated slug
  // OpenRouter free:
  //   moonshotai/kimi-k2-thinking:free  ✅ 50/day — has thinking mode
  //   moonshotai/kimi-k2.5 (no :free)   = PAID — removed
  // Literouter:
  //   kimi-k2.5-free  ✅ 30/day
  //
  // Auto route: OR free thinking → Literouter fallback
  // ══════════════════════════════════════════════════════════
  'kimi-k2.6-nv':  { model: 'moonshotai/kimi-k2.6', provider: 'nvidia', thinking: null }, // 262K context
  'kimi-think-or': { model: 'moonshotai/kimi-k2-thinking:free', provider: 'openrouter', thinking: null }, // 50/day ✅ has thinking
  'kimi-lit':      { model: 'kimi-k2.5-free',                   provider: 'literouter', thinking: null }, // 30/day ✅
  // 'kimi-or':    { model: 'moonshotai/kimi-k2.5', ... }  // PAID — removed (no :free suffix)
  'kimi': { model: 'moonshotai/kimi-k2-thinking:free', provider: 'openrouter', thinking: null, fallback: { model: 'kimi-k2.5-free', provider: 'literouter', thinking: null } },


  // ══════════════════════════════════════════════════════════
  // GPT-OSS (OpenAI open weights)
  //
  // NVIDIA NIM:  openai/gpt-oss-120b ✅ free endpoint confirmed
  //              openai/gpt-oss-20b  ✅ free endpoint confirmed
  // Literouter:  gpt-oss-120b-free ✅ ∞/day
  //              gpt-oss-20b-free  ✅ ∞/day
  // OpenRouter:  openai/gpt-oss-120b:free ✅ 50/day per key
  //              openai/gpt-oss-20b:free  ✅ 50/day per key
  //
  // Auto route: NVIDIA (no daily cap) → Literouter fallback
  // ══════════════════════════════════════════════════════════
  'gpt-oss-120b-nv':  { model: 'openai/gpt-oss-120b',      provider: 'nvidia',     thinking: null }, // free ✅
  'gpt-oss-20b-nv':   { model: 'openai/gpt-oss-20b',       provider: 'nvidia',     thinking: null }, // free ✅
  'gpt-oss-120b-lit': { model: 'gpt-oss-120b-free',        provider: 'literouter', thinking: null }, // ∞/day ✅
  'gpt-oss-20b-lit':  { model: 'gpt-oss-20b-free',         provider: 'literouter', thinking: null }, // ∞/day ✅
  'gpt-oss-120b-or':  { model: 'openai/gpt-oss-120b:free', provider: 'openrouter', thinking: null }, // 50/day ✅
  'gpt-oss-20b-or':   { model: 'openai/gpt-oss-20b:free',  provider: 'openrouter', thinking: null }, // 50/day ✅

  'gpt-oss-120b': { model: 'openai/gpt-oss-120b', provider: 'nvidia', thinking: null, fallback: { model: 'gpt-oss-120b-free', provider: 'literouter', thinking: null } },
  'gpt-oss-20b':  { model: 'openai/gpt-oss-20b',  provider: 'nvidia', thinking: null, fallback: { model: 'gpt-oss-20b-free',  provider: 'literouter', thinking: null } },


  // ══════════════════════════════════════════════════════════
  // Qwen (Literouter — best free option, uncensored)
  //
  // Literouter:
  //   qwen3-32b-free:    ∞/day ✅ uncensored
  //   qwen3-4b-fp8-free: ∞/day ✅ uncensored, smaller/faster
  //   qwen-free:         30/day ✅ uncensored, version unknown
  //
  // NVIDIA NIM Qwen slugs are UNVERIFIED — commented out.
  // If you want to try them, check build.nvidia.com first.
  // ══════════════════════════════════════════════════════════
  'qwen3-32b-lit': { model: 'qwen3-32b-free',    provider: 'literouter', thinking: null }, // ∞/day ✅ uncensored
  'qwen3-4b-lit':  { model: 'qwen3-4b-fp8-free', provider: 'literouter', thinking: null }, // ∞/day ✅ uncensored, fast
  'qwen-lit':      { model: 'qwen-free',          provider: 'literouter', thinking: null }, // 30/day ✅ uncensored, version unknown
  // 'qwen-coder-nv':   { model: 'qwen/qwen3-coder-480b-a35b-instruct', provider: 'nvidia', thinking: null }, // ⚠️ slug unverified
  // 'qwen-think-nv':   { model: 'qwen/qwen3-next-80b-a3b-thinking',    provider: 'nvidia', thinking: null }, // ⚠️ slug unverified


  // ══════════════════════════════════════════════════════════
  // MiMo V2 Flash (Literouter)
  //
  // mimo-v2-flash-free: ∞/day ✅
  // Reportedly competitive with Claude Sonnet 4.5 on coding/reasoning.
  // Supports hybrid thinking toggle.
  // ══════════════════════════════════════════════════════════
  'mimo-lit': { model: 'mimo-v2-flash-free', provider: 'literouter', thinking: null }, // ∞/day ✅


  // ══════════════════════════════════════════════════════════
  // Llama Nemotron (NVIDIA NIM)
  //
  // nvidia/llama-3.1-nemotron-ultra-253b-v1 ✅ free endpoint confirmed
  // ══════════════════════════════════════════════════════════
  'llama-nemotron': { model: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', provider: 'nvidia', thinking: null }, // free ✅


  // ══════════════════════════════════════════════════════════
  // Misc Literouter free models
  //
  // All route through Pollinations AI — actual model version may vary.
  // ══════════════════════════════════════════════════════════
  'mistral-lit':  { model: 'mistral-free',  provider: 'literouter', thinking: null }, // ∞/day ✅ uncensored
  'nemotron-lit': { model: 'nemotron-free', provider: 'literouter', thinking: null }, // ∞/day ✅
  'devstral-lit': { model: 'devstral-free', provider: 'literouter', thinking: null }, // 10/day ✅ coding specialist
  'grok-lit':     { model: 'grok-free',     provider: 'literouter', thinking: null }, // 30/day ✅

};
// ============================================================
// PROVIDER CONFIG
// ── Z.AI base URL FIXED: /api/paas/v4 (official docs)
// ── Previously was /api/openai/v1 which is undocumented
// ============================================================
function getProviderConfig(provider) {
  switch (provider) {
    case 'zai':        return { base: 'https://api.z.ai/api/paas/v4',                          key: ZAI_API_KEY };
    case 'google':     return { base: GOOGLE_RELAY_BASE, key: GOOGLE_API_KEY };
    case 'deepseek':   return { base: 'https://api.deepseek.com',                               key: DEEPSEEK_API_KEY };
    case 'openrouter': return { base: 'https://openrouter.ai/api/v1',                           key: getNextOpenRouterKey() };
    case 'literouter': return { base: 'https://api.literouter.com/v1',                          key: getNextLiterouterKey() };
    default:           return { base: 'https://integrate.api.nvidia.com/v1',                    key: NIM_API_KEY };
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
// MAKE API CALL (with smart fallback)
// ── 4xx client errors do NOT trigger fallback (your request is
//    wrong; a different provider won't fix it).
// ── 5xx, 429 (rate limit), 408 (timeout), network errors DO
//    trigger fallback (server-side / transient issues).
// ── Exception: 401/403 also skip fallback (auth failure).
// ============================================================
async function makeAPICall(mapping, nimRequest, stream) {
  const providers = [mapping];
  if (mapping.fallback) providers.push(mapping.fallback);

  let lastError;
  for (const providerConfig of providers) {
    const { base, key } = getProviderConfig(providerConfig.provider);
    const extraBody = getExtraBody(providerConfig.thinking);
    const body = { ...nimRequest, model: providerConfig.model, extra_body: extraBody || undefined };

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
          timeout: 120000
        }
      );
      return { response, usedProvider: providerConfig.provider, usedModel: providerConfig.model };

    } catch (err) {
      const status = err.response?.status;

      // Hard client errors — wrong params/model/auth, fallback won't help
      if (status && status >= 400 && status < 500 && status !== 429 && status !== 408) {
        log('WARN', `Provider ${providerConfig.provider} returned ${status} (client error) — not falling back`);
        throw err;
      }

      // 5xx, 429 (rate limited), 408 (timeout), or network error → try fallback
      log('WARN', `Provider ${providerConfig.provider} failed [${status || 'network'}]: ${err.message} — trying fallback...`);
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
  res.json({
    status: 'ok',
    mode: MODE,
    users: status,
    deepseek_budget: {
      tokens_left: dsBudget.tokensLeft,
      daily_limit: dsBudget.dailyLimit,
      days_left: dsBudget.daysLeft
    },
    openrouter_keys: OPENROUTER_KEYS.length,
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

    // Track DeepSeek token usage
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
