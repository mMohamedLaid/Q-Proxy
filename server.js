// server.js - Q-proxy
// OpenAI-compatible router across NVIDIA NIM, Z.AI, Google, OpenRouter,
// Literouter, MegaNova (and DeepSeek, currently disabled). Quartermaster,
// not the agent: doesn't do the talking, just makes sure someone always
// picks up when you call.
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

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
const MEGANOVA_API_KEY  = process.env.MEGANOVA_API_KEY; 

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
const MODELS_PATH = path.join(__dirname, 'models.json');

// Model config now lives in models.json instead of hardcoded here, so the
// admin panel (see ADMIN ROUTES below) can add/edit/remove models without
// a redeploy — same "just change it, no redeploy" philosophy as the key
// rotation below. loadModels() re-reads from disk; saveModels() persists
// admin edits back to it.
//
// NOTE ON PERSISTENCE: on Render, a Free web service has no persistent
// disk at all — any change written here is lost on the next restart or
// redeploy, same as the in-memory counters below always have been. On a
// paid Render plan you can attach a Disk (Render Docs > Persistent Disks)
// and mount it over this file's directory to make admin edits durable.
// Without that, treat admin edits as living until the next restart.
function loadModels() {
  try {
    const raw = fs.readFileSync(MODELS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Could not load ${MODELS_PATH}: ${e.message}. Make sure models.json is deployed alongside server.js.`);
  }
}

function saveModels(mapping) {
  fs.writeFileSync(MODELS_PATH, JSON.stringify(mapping, null, 2));
}

let MODEL_MAPPING = loadModels();

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
// PROVIDER / MODEL USAGE TRACKING (for the admin dashboard)
// ── In-memory only — same ephemerality caveat as everything else
//    in this file. Counts requests per provider+model so entries
//    that have no other budget signal (NIM, Z.AI, Literouter,
//    MegaNova, Google) still show *something* in /admin.
// ============================================================
const providerUsage = {}; // { "nvidia|z-ai/glm-5.2": { count, errors, lastUsed, lastStatus } }

function trackUsage(provider, model, ok, status) {
  const k = `${provider}|${model}`;
  if (!providerUsage[k]) providerUsage[k] = { provider, model, count: 0, errors: 0, lastUsed: null, lastStatus: null };
  const u = providerUsage[k];
  if (ok) u.count++; else u.errors++;
  u.lastUsed = new Date().toISOString();
  u.lastStatus = ok ? 'ok' : (status || 'error');
}

// ============================================================
// MAKE API CALL (walks the full fallback chain, any depth)
// ── 4xx client errors mostly do NOT trigger fallback (your
//    request is wrong; a different provider won't fix it).
// ── 5xx, 429 (rate limit), 408 (timeout), 404, network errors DO
//    trigger fallback (server-side / transient / "this model
//    isn't here anymore" issues). 404 was added deliberately: a
//    deprecated-and-pulled model reads as 404 from NIM, not 5xx,
//    so without this a deprecation would bypass the fallback
//    chain entirely and just error out at the primary hop.
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
      trackUsage(providerConfig.provider, providerConfig.model, true);
      return { response, usedProvider: providerConfig.provider, usedModel: providerConfig.model };

    } catch (err) {
      const status = err.response?.status;
      trackUsage(providerConfig.provider, providerConfig.model, false, status);

      if (status && status >= 400 && status < 500 && status !== 429 && status !== 408 && status !== 404) {
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
    id: m, object: 'model', created: Date.now(), owned_by: 'q'
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

// ============================================================
// ADMIN AUTH
// ── Fails closed: no ADMIN_KEY env var set → admin routes are
//    disabled outright rather than open with no auth. Set
//    ADMIN_KEY in Render the same way you set MY_KEY etc.
// ── Lockout: after 5 wrong keys, backs off exponentially (30s,
//    60s, 120s… capped at 1hr) so guessing the key isn't
//    practical even if it's short. Resets on a correct attempt.
//    In-memory only, same ephemerality as everything else here.
// ── CORS: the blanket app.use(cors()) above applies everywhere,
//    including here — fine for /v1/* if you call it from browser
//    JS, but the admin dashboard is same-origin by construction
//    and never needs cross-origin access. This strips the CORS
//    grant specifically for /admin/*, so even if a key leaked
//    into some other origin's JS, a browser can't use it to call
//    this API from that origin. Doesn't affect curl/server-side
//    calls at all — CORS is a browser-enforced rule, not a server one.
// ============================================================
const ADMIN_KEY = process.env.ADMIN_KEY;
const adminAuthFails = { count: 0, lockedUntil: 0 };

app.use('/admin', (req, res, next) => {
  res.removeHeader('Access-Control-Allow-Origin');
  next();
});

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) {
    return res.status(503).json({
      error: { message: 'Admin panel disabled — set ADMIN_KEY in your environment to enable it.', type: 'admin_disabled', code: 503 }
    });
  }
  const now = Date.now();
  if (now < adminAuthFails.lockedUntil) {
    const waitSec = Math.ceil((adminAuthFails.lockedUntil - now) / 1000);
    return res.status(429).json({ error: { message: `Too many failed admin key attempts. Try again in ${waitSec}s.`, type: 'rate_limit_error', code: 429 } });
  }
  const provided = req.headers['x-admin-key'] || req.query.key || '';
  if (provided !== ADMIN_KEY) {
    adminAuthFails.count++;
    if (adminAuthFails.count >= 5) {
      const lockSec = Math.min(3600, 30 * Math.pow(2, adminAuthFails.count - 5));
      adminAuthFails.lockedUntil = now + lockSec * 1000;
      log('WARN', `[admin] locking out admin auth for ${lockSec}s after ${adminAuthFails.count} failed attempts`);
    }
    return res.status(401).json({ error: { message: 'Invalid or missing admin key.', type: 'unauthorized', code: 401 } });
  }
  adminAuthFails.count = 0;
  next();
}

// ============================================================
// ADMIN: MODELS CRUD
// ── Mutations write straight through to models.json via
//    saveModels(). See the persistence note above loadModels():
//    on Render Free this does NOT survive a restart/redeploy.
// ============================================================
app.get('/admin/api/models', requireAdmin, (req, res) => {
  res.json({ models: MODEL_MAPPING });
});

app.post('/admin/api/models', requireAdmin, (req, res) => {
  const { id, entry } = req.body || {};
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: { message: 'Body must include a string "id".', type: 'invalid_request_error', code: 400 } });
  }
  if (!entry || !entry.model || !entry.provider) {
    return res.status(400).json({ error: { message: 'Body must include "entry" with at least "model" and "provider".', type: 'invalid_request_error', code: 400 } });
  }
  MODEL_MAPPING[id] = entry;
  try {
    saveModels(MODEL_MAPPING);
  } catch (e) {
    return res.status(500).json({ error: { message: `Saved in memory but failed to write models.json: ${e.message}`, type: 'server_error', code: 500 } });
  }
  log('INFO', `[admin] upserted model "${id}"`);
  res.json({ ok: true, id, entry });
});

app.delete('/admin/api/models/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (!MODEL_MAPPING[id]) {
    return res.status(404).json({ error: { message: `No model "${id}"`, type: 'invalid_request_error', code: 404 } });
  }
  delete MODEL_MAPPING[id];
  try {
    saveModels(MODEL_MAPPING);
  } catch (e) {
    return res.status(500).json({ error: { message: `Deleted in memory but failed to write models.json: ${e.message}`, type: 'server_error', code: 500 } });
  }
  log('INFO', `[admin] deleted model "${id}"`);
  res.json({ ok: true, id });
});

// Re-read models.json from disk without restarting the process —
// handy if you edited the file directly (e.g. via git).
app.post('/admin/api/models/reload', requireAdmin, (req, res) => {
  try {
    MODEL_MAPPING = loadModels();
  } catch (e) {
    return res.status(500).json({ error: { message: e.message, type: 'server_error', code: 500 } });
  }
  res.json({ ok: true, count: Object.keys(MODEL_MAPPING).length });
});

// ============================================================
// ADMIN: USAGE / CREDITS
// ── Combines everything this proxy can actually know:
//    - self-tracked per-provider/per-model counts (always available,
//      reset on restart, not authoritative — just "have we been
//      hitting this a lot")
//    - OpenRouter: REAL data from GET /api/v1/key (rate limit +
//      spend for that exact key)
//    - DeepSeek: REAL data from GET /user/balance (meaningful once
//      the account actually has funds)
//    - per-user (MY_KEY / USER1_KEY) rate-limit state
//    NVIDIA NIM, Z.AI, Google, Literouter, and MegaNova don't
//    publish a credits/balance API as far as we could find, so
//    those only ever show the self-tracked counts — check their
//    dashboards directly for anything authoritative.
// ============================================================
app.get('/admin/api/usage', requireAdmin, async (req, res) => {
  const keyMap = buildKeyMap();
  const now = Date.now();
  const perKeyLimits = Object.entries(keyMap).map(([key, info]) => ({
    name: info.name,
    limit: info.limit,
    usedThisMinute: usageTracker[key]?.count || 0,
    resetsInSec: usageTracker[key] ? Math.max(0, Math.ceil((usageTracker[key].resetAt - now) / 1000)) : null
  }));

  const dsBudget = checkDeepSeekBudget();
  const today = new Date().toISOString().slice(0, 10);
  const openrouterSelfTracked = OPENROUTER_KEYS.map((_, i) => ({
    key: `OPENROUTER_KEY_${i + 1}`,
    usedToday: openrouterKeyState[i].day === today ? openrouterKeyState[i].count : 0,
    cap: OPENROUTER_DAILY_CAP
  }));

  const openrouterLive = await Promise.all(OPENROUTER_KEYS.map(async (k, i) => {
    try {
      const r = await axios.get('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${k}` },
        timeout: 8000
      });
      return { key: `OPENROUTER_KEY_${i + 1}`, ok: true, data: r.data?.data || r.data };
    } catch (e) {
      return { key: `OPENROUTER_KEY_${i + 1}`, ok: false, error: e.response?.data?.error?.message || e.message };
    }
  }));

  let deepseekLive = null;
  if (DEEPSEEK_API_KEY) {
    try {
      const r = await axios.get('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        timeout: 8000
      });
      deepseekLive = { ok: true, data: r.data };
    } catch (e) {
      deepseekLive = { ok: false, error: e.response?.data?.error?.message || e.message };
    }
  }

  res.json({
    perKeyLimits,
    providerUsage: Object.values(providerUsage),
    openrouter: { selfTracked: openrouterSelfTracked, live: openrouterLive },
    deepseek: { selfTrackedBudget: dsBudget, tokensUsedThisMonth: deepseekBudget.tokensUsed, live: deepseekLive },
    literouterKeysLoaded: LITEROUTER_KEYS.length
  });
});

// ============================================================
// ADMIN: SYNC — ask a provider what models it actually has live
// right now and diff against what's configured. Deliberately
// does NOT auto-add or auto-remove anything: a newly-listed model
// might not actually be free, might behave differently, or might
// just be noise, so a human approves changes. This is the check
// that would have caught the glm-5.2 deprecation, and the way to
// confirm whether kimi-k3 is actually live, days ahead of time.
// ============================================================
const SYNCABLE_PROVIDERS = new Set(['nvidia', 'zai', 'google', 'openrouter']);

app.get('/admin/api/sync/:provider', requireAdmin, async (req, res) => {
  const provider = req.params.provider;
  if (!SYNCABLE_PROVIDERS.has(provider)) {
    return res.status(400).json({
      error: { message: `No live catalog check available for "${provider}" (Literouter/MegaNova don't publish one that we could find) — track it manually.`, type: 'invalid_request_error', code: 400 }
    });
  }

  const { base, key } = getProviderConfig(provider);
  try {
    const r = await axios.get(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 15000
    });
    const liveIds = (r.data?.data || []).map(m => m.id);

    const configuredIds = new Set();
    for (const entry of Object.values(MODEL_MAPPING)) {
      let hop = entry;
      while (hop) {
        if (hop.provider === provider) configuredIds.add(hop.model);
        hop = hop.fallback;
      }
    }

    const newlyAvailable = liveIds.filter(id => !configuredIds.has(id));
    const noLongerListed = [...configuredIds].filter(id => !liveIds.includes(id));

    res.json({ provider, liveCount: liveIds.length, newlyAvailable, noLongerListed });
  } catch (e) {
    res.status(502).json({
      error: { message: `Couldn't reach ${provider}'s /models: ${e.response?.status || ''} ${e.message}`, type: 'upstream_error', code: 502 }
    });
  }
});

// ============================================================
// ADMIN PANEL PAGE
// ── The page itself is public (just a login shell); every API
//    call it makes carries the admin key, checked above.
// ============================================================
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found`, type: 'invalid_request_error', code: 404 } });
});

app.listen(PORT, () => {
  log('INFO', `Proxy running on port ${PORT} — mode: ${MODE}`);
  log('INFO', `OpenRouter keys loaded: ${OPENROUTER_KEYS.length}`);
  log('INFO', `Literouter keys loaded: ${LITEROUTER_KEYS.length}`);
});
