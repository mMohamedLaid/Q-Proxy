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

// ============================================================
// LOGGING
// ============================================================
// Declared FIRST, deliberately — before anything else in this file runs.
// This used to sit much further down, after the PROVIDER_QUOTAS_JSON
// parsing block, whose catch handler calls log() to report a malformed
// env var. Since log()'s body reads the const recentLogs below, and
// consts live in the temporal dead zone until their own declaration line
// actually executes, calling log() from code that runs BEFORE this
// point would throw "Cannot access 'recentLogs' before initialization" —
// turning a bad env var into a startup crash instead of a logged
// warning. Ring buffer feeds the admin dashboard's Logs section; capped
// so it can't grow unbounded, newest first.
const RECENT_LOGS_MAX = 1000;
const recentLogs = [];
// target: 'both' (default) | 'console' (Render logs only) | 'admin' (Admin panel only).
// Per-chunk stream lines go to 'console' only, so Render keeps the full
// clutter you can dig back through, while the Admin panel stays readable.
// Console (Render) line stamp: time first, then day-month-year. The server
// only knows UTC — the Admin panel converts to your own time zone.
function fmtServerTs(iso) {
  const d = new Date(iso);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)} ${p(d.getUTCDate())}-${p(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} UTC`;
}
// rid = short per-request id (#k3f9). Every line a request writes carries it,
// so two requests running in parallel (a stopped-and-retried generation, an
// agent firing several calls) can be told apart in Render's console (search
// the id) and in the Admin panel (click the chip to filter).
function log(level, msg, target = 'both', rid = null) {
  const ts = new Date().toISOString();
  if (target !== 'admin') console.log(`[${fmtServerTs(ts)}] [${level}] ${rid ? '#' + rid + ' ' : ''}${msg}`);
  if (target !== 'console') {
    recentLogs.unshift(rid ? { ts, level, msg, rid } : { ts, level, msg });
    if (recentLogs.length > RECENT_LOGS_MAX) recentLogs.length = RECENT_LOGS_MAX;
  }
}
function newRequestId() { return Math.random().toString(36).slice(2, 6).padEnd(4, '0'); }
// A log() bound to one request id. Used by shadowing `const log = logWith(rid)`
// at the top of a request-scoped function, so none of its call sites change.
function logWith(rid) { return (level, msg, target = 'both') => log(level, msg, target, rid); }
// One multi-line block (the stitched think / reply) copied to the Render
// console when a stream finishes. Every line carries the request id so the
// block stays attributable even if Render shows the lines interleaved with
// another request's; a single console.log call keeps the lines contiguous.
function consoleBlock(level, header, text, rid, maxChars = 150000) {
  const tag = rid ? '#' + rid : '·';
  let body = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
  let cut = '';
  if (body.length > maxChars) { cut = `\n… [cut off here in the console copy — the client got everything]`; body = body.slice(0, maxChars); }
  const lines = (body + cut).split('\n').map(l => `${tag} │ ${l}`);
  console.log([`[${fmtServerTs(new Date().toISOString())}] [${level}] ${tag} ${header}`, ...lines].join('\n'));
}

// Static, hand-pasted limit snapshots (Google AI Studio + Literouter). No API
// returns any of this, so it lives in provider-limits.json — refresh it by
// re-pasting the provider's dashboard and bumping capturedAt. Loaded once at
// boot — declared up here, above every function that reads it, so nothing can
// ever touch it before it exists; if the file is missing the proxy still runs, sync-add just won't
// pre-fill limits and Literouter models all show up as Unverified.
const PROVIDER_LIMITS_PATH = path.join(__dirname, 'provider-limits.json');
function loadProviderLimits() {
  try { return JSON.parse(fs.readFileSync(PROVIDER_LIMITS_PATH, 'utf8')); }
  catch (e) {
    log('WARN', `provider-limits.json not loaded (${e.message}) — sync-add won't pre-fill limits and Literouter models will all show as Unverified`);
    return {};
  }
}
const PROVIDER_LIMITS = loadProviderLimits();
// Re-read the file into the SAME object (other code holds references into it).
function reloadProviderLimits() {
  try {
    const fresh = JSON.parse(fs.readFileSync(PROVIDER_LIMITS_PATH, 'utf8'));
    for (const k of Object.keys(PROVIDER_LIMITS)) if (k !== 'literouter') delete PROVIDER_LIMITS[k];
    for (const [k, v] of Object.entries(fresh)) {
      if (k === 'literouter' && PROVIDER_LIMITS.literouter && PROVIDER_LIMITS.literouter.models && v && v.models) {
        const lm = PROVIDER_LIMITS.literouter.models;
        for (const m of Object.keys(lm)) delete lm[m];
        Object.assign(lm, v.models);
        Object.assign(PROVIDER_LIMITS.literouter, { ...v, models: lm });
      } else PROVIDER_LIMITS[k] = v;
    }
  } catch (e) { log('WARN', `provider-limits.json could not be reloaded (${e.message}) — keeping what was loaded at start`); }
}

// Admin-panel-only entry for streamed model text (reasoning or reply).
// Tokens are appended as they arrive and stitched into one readable block
// (the model's own line breaks are kept), instead of one log line per
// chunk. `msg` is a getter so the entry updates live in place — with
// Auto-refresh on you can watch a long think grow — without rebuilding a
// big string on every token. Capped so one huge reply can't eat memory.
const ADMIN_STREAM_LOG_MAX_CHARS = Number(process.env.ADMIN_STREAM_LOG_MAX_CHARS) || 150000;
function openLiveLog(level, label, rid) {
  let body = '';
  let status = 'streaming…';
  let capped = false;
  const entry = {
    ts: new Date().toISOString(),
    level,
    rid: rid || undefined,
    get msg() {
      const text = body.replace(/\n{3,}/g, '\n\n').trim();
      return `${label} — ${status}\n${text}${capped ? '\n… [cut off here in the Admin log only — Render logs and the client still got everything]' : ''}`;
    }
  };
  recentLogs.unshift(entry);
  if (recentLogs.length > RECENT_LOGS_MAX) recentLogs.length = RECENT_LOGS_MAX;
  return {
    append(text) {
      if (!text || capped) return;
      body += text;
      if (body.length > ADMIN_STREAM_LOG_MAX_CHARS) { body = body.slice(0, ADMIN_STREAM_LOG_MAX_CHARS); capped = true; }
    },
    close(note) { status = note; },
    text() { return body.replace(/\n{3,}/g, '\n\n').trim(); }
  };
}
function logStitchedText(level, label, text) {
  if (!text) return;
  const l = openLiveLog(level, label);
  l.append(text);
  l.close(`${text.length} chars`);
}

const app = express();
const PORT = process.env.PORT || 3000;
// Render (and most PaaS) put one reverse proxy hop in front of this app.
// Without this, req.ip is Render's edge IP for every single request —
// which would make the per-IP admin lockout below just as global as the
// bug it's fixing, since every visitor would collapse into one bucket.
app.set('trust proxy', 1);

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

// Both key lists are unbounded — set as many PREFIX_KEY_1, PREFIX_KEY_2,
// PREFIX_KEY_3... env vars as you have keys for. Numbers don't need to be
// contiguous; whatever's set gets picked up in numeric order at boot.
function loadNumberedKeys(prefix) {
  const found = [];
  for (const envName of Object.keys(process.env)) {
    const m = envName.match(new RegExp(`^${prefix}_(\\d+)$`));
    if (m && process.env[envName]) found.push({ n: parseInt(m[1], 10), key: process.env[envName], envName });
  }
  found.sort((a, b) => a.n - b.n);
  return found.map(f => ({ key: f.key, envName: f.envName }));
}

// Daily-quota boundaries are baked in per provider — no env vars:
//   Literouter        — 00:00 GMT+7 (docs.literouter.com/credits; their own
//                       dashboard counts down to it) = 17:00 UTC.
//   OpenRouter        — 00:00 UTC.
//   Google AI Studio  — midnight Pacific Time, DST-aware (see pacificDayKey).
const LITEROUTER_RESET_UTC_HOUR = 17;
const OPENROUTER_RESET_UTC_HOUR = 0;

// Date string that rolls over at `hourOffset`:00 UTC instead of 00:00 UTC.
function dayKeyAtUtcHourOffset(hourOffset) {
  return new Date(Date.now() - hourOffset * 3600000).toISOString().slice(0, 10);
}

const LITEROUTER_KEY_ENTRIES = loadNumberedKeys('LITEROUTER_KEY');
const LITEROUTER_KEYS = LITEROUTER_KEY_ENTRIES.map(e => e.key);
// GOOGLE_KEY_1, GOOGLE_KEY_2... — same numbered-key convention as
// OpenRouter/Literouter, added so a model can keep using the SAME key
// until IT specifically hits an RPM/TPM/RPD ceiling, then move only that
// model to the next key. Falls back to the old singular GOOGLE_API_KEY
// as key 1 if no numbered keys are set, so a single-key deployment needs
// no changes at all.
const GOOGLE_KEY_ENTRIES = loadNumberedKeys('GOOGLE_KEY').length
  ? loadNumberedKeys('GOOGLE_KEY')
  : (GOOGLE_API_KEY ? [{ n: 1, key: GOOGLE_API_KEY, envName: 'GOOGLE_API_KEY' }] : []);
const GOOGLE_KEYS = GOOGLE_KEY_ENTRIES.map(e => e.key);

const OPENROUTER_KEY_ENTRIES = loadNumberedKeys('OPENROUTER_KEY');
const OPENROUTER_KEYS = OPENROUTER_KEY_ENTRIES.map(e => e.key);

// OpenRouter: drain key 1 fully (its full daily cap) before moving to key 2, etc.
// Resets daily. This is a self-tracked counter, not synced with OpenRouter's own
// dashboard, so a process restart resets it to 0 even if the real usage wasn't.
const OPENROUTER_DAILY_CAP = 50;
const openrouterKeyState = OPENROUTER_KEYS.map(() => ({ count: 0, day: '' }));
let openrouterKeyIndex = 0;

function getNextOpenRouterKey() {
  const today = dayKeyAtUtcHourOffset(OPENROUTER_RESET_UTC_HOUR);
  openrouterKeyState.forEach(s => { if (s.day !== today) { s.day = today; s.count = 0; } });

  for (let i = 0; i < OPENROUTER_KEYS.length; i++) {
    const idx = (openrouterKeyIndex + i) % OPENROUTER_KEYS.length;
    if (openrouterKeyState[idx].count < OPENROUTER_DAILY_CAP) {
      openrouterKeyIndex = idx;
      openrouterKeyState[idx].count++;
      markUsageStateDirty();
      return OPENROUTER_KEYS[idx];
    }
  }
  // all keys drained for today — hand back the last one, it'll 429 and bubble up.
  // Modulo guard: openrouterKeyIndex is restored from usage-state.json on boot,
  // so it can point past the end if keys were removed since it was saved.
  return OPENROUTER_KEYS[openrouterKeyIndex % OPENROUTER_KEYS.length];
}

// ── Literouter: per-(key, model) daily usage. Its free-tier caps are
// per-model, not a blanket per-key cap like OpenRouter's — key 1 being
// drained for claude-haiku-4.5-cheap has zero effect on key 1's
// qwen3.5 bucket. dailyCap comes from the model's own hop config
// (models.json); undefined/null means Literouter lists it as unlimited,
// so it's never tracked, just round-robined for load spread.
const literouterKeyState = {}; // `${keyIndex}|${model}` -> { count, day }
let literouterRotationIndex = 0; // only used for UNCAPPED free models — nothing to "run out of" per model, so plain round-robin is fine
let literouterPremiumRotationIndex = 0; // shared on purpose — the premium pool is genuinely one bucket across models, not per-model
// Capped free models each keep their OWN key until THEY specifically run
// out, independent of what other models on the same provider are doing —
// `model -> keyIndex`. This is the piece that was missing: the old code
// shared literouterRotationIndex across every model, so draining key 1
// for model A would shift where model B's search started too, even
// though B's own quota was completely untouched.
const literouterFreeModelCursor = {};
let literouterLastResetDay = null;

// Both cursor types revert to key 0 at Literouter's own daily boundary
// ("at the end of a reset, they all revert to the first key") — called
// lazily at the top of pickLiterouterKey rather than on a timer, so it
// can't drift from whatever's actually calling it.
function maybeResetLiterouterCursors() {
  const today = dayKeyAtUtcHourOffset(LITEROUTER_RESET_UTC_HOUR);
  if (literouterLastResetDay === today) return;
  literouterLastResetDay = today;
  for (const k of Object.keys(literouterFreeModelCursor)) delete literouterFreeModelCursor[k];
  literouterPremiumRotationIndex = 0;
}

function literouterUsage(keyIndex, model) {
  const k = `${keyIndex}|${model}`;
  const today = dayKeyAtUtcHourOffset(LITEROUTER_RESET_UTC_HOUR);
  if (!literouterKeyState[k] || literouterKeyState[k].day !== today) {
    literouterKeyState[k] = { count: 0, day: today };
  }
  return literouterKeyState[k];
}

// Literouter's "premium" ("basic premium") tier shares one 50/day budget
// PER KEY across every premium model — the same shape as OpenRouter's
// pool below, unlike the free tier's per-(key,model) buckets above. Mark
// a hop with "literouterTier": "premium" in models.json to draw from
// this pool instead of a per-model dailyCap. Reuses the same
// LITEROUTER_RESET_UTC_HOUR-driven day boundary as the free tier — one
// knob governs both instead of two that could drift apart. The actual
// per-request cost of a premium model isn't modeled yet (each request
// just counts as 1 against the 50, same as OpenRouter's counting) —
// real per-model weighting is a follow-up once real cost data exists.
// Literouter's own docs (docs.literouter.com/credits) confirm: a ":free"
// suffixed model spends free credits (per-model daily cap, the existing
// tracking above); literally everything else — plain names, ":metered",
// ":full-context", ":metered:full-context" — spends the SAME shared
// "premium credits" pool, one balance per key, sized by the account's
// plan (their docs: "Your plan sets the daily allowance... with higher
// plans getting more" — so 50 is what THIS account's plan grants, not a
// universal number; override LITEROUTER_PREMIUM_DAILY_CAP if a key on a
// different plan is added later). Because the split is entirely
// determined by the ":free" suffix, tier is auto-detected from the model
// slug — no manual tagging needed per hop, current or future. An
// explicit "literouterTier" on a hop still overrides the guess, in case
// Literouter ever ships something that doesn't follow this rule.
const LITEROUTER_PREMIUM_DAILY_CAP = Number(process.env.LITEROUTER_PREMIUM_DAILY_CAP ?? 50);

function isLiterouterPremium(providerConfig) {
  if (providerConfig.literouterTier === 'premium') return true;
  if (providerConfig.literouterTier === 'free') return false;
  return !String(providerConfig.model || '').endsWith(':free');
}
const literouterPremiumKeyState = []; // index-aligned with LITEROUTER_KEYS: { count, day }

function literouterPremiumUsage(keyIndex) {
  const today = dayKeyAtUtcHourOffset(LITEROUTER_RESET_UTC_HOUR);
  if (!literouterPremiumKeyState[keyIndex] || literouterPremiumKeyState[keyIndex].day !== today) {
    literouterPremiumKeyState[keyIndex] = { count: 0, day: today };
  }
  return literouterPremiumKeyState[keyIndex];
}

// Returns { key, keyIndex } for the first Literouter key with daily headroom
// left, or null if every configured key is exhausted (caller should skip
// to the next hop, same as a tpm-budget skip). "premium" tier draws from
// the shared 50/day-per-key pool; otherwise it's the free tier's own
// per-(key,model) dailyCap.
function pickLiterouterKey(model, dailyCap, isPremium) {
  if (!LITEROUTER_KEYS.length) return null;
  maybeResetLiterouterCursors();
  if (isPremium) {
    for (let i = 0; i < LITEROUTER_KEYS.length; i++) {
      const idx = (literouterPremiumRotationIndex + i) % LITEROUTER_KEYS.length;
      const usage = literouterPremiumUsage(idx);
      if (usage.count < LITEROUTER_PREMIUM_DAILY_CAP) {
        usage.count++;
        markUsageStateDirty();
        literouterPremiumRotationIndex = idx;
        return { key: LITEROUTER_KEYS[idx], keyIndex: idx };
      }
    }
    return null;
  }
  if (dailyCap == null) {
    const idx = literouterRotationIndex % LITEROUTER_KEYS.length;
    literouterRotationIndex++;
    return { key: LITEROUTER_KEYS[idx], keyIndex: idx };
  }
  const startIdx = literouterFreeModelCursor[model] || 0;
  for (let i = 0; i < LITEROUTER_KEYS.length; i++) {
    const idx = (startIdx + i) % LITEROUTER_KEYS.length;
    const usage = literouterUsage(idx, model);
    if (usage.count < dailyCap) {
      usage.count++;
      markUsageStateDirty();
      literouterFreeModelCursor[model] = idx; // THIS model stays pinned to this key until it, specifically, runs out
      return { key: LITEROUTER_KEYS[idx], keyIndex: idx };
    }
  }
  return null;
}

// Snapshot of every (key, model) counter for a model that actually has a
// dailyCap, for Admin/health display — e.g. "12/30 (key 1), 0/30 (key 2)".
// Models with no dailyCap aren't tracked per-key, so they're omitted here.
function literouterCapSnapshot() {
  const today = dayKeyAtUtcHourOffset(LITEROUTER_RESET_UTC_HOUR);
  const byModel = {};
  for (const [id, entry] of Object.entries(MODEL_MAPPING || {})) {
    const hops = [];
    let cur = entry;
    let depth = 0;
    while (cur) {
      // Depth guard: models.json is hand-editable, and a fallback cycle in it
      // would otherwise hang this loop (and /health with it) forever.
      if (++depth > 50) break;
      if (cur.provider === 'literouter' && cur.dailyCap != null) hops.push(cur);
      cur = cur.fallback;
    }
    for (const hop of hops) {
      if (byModel[hop.model]) continue; // same model may appear under multiple ids — report once
      byModel[hop.model] = {
        model: hop.model,
        dailyCap: hop.dailyCap,
        keys: LITEROUTER_KEYS.map((_, idx) => {
          const state = literouterKeyState[`${idx}|${hop.model}`];
          const used = (state && state.day === today) ? state.count : 0;
          return { envName: LITEROUTER_KEY_ENTRIES[idx].envName, used, cap: hop.dailyCap };
        })
      };
    }
  }
  return Object.values(byModel);
}

// Same shape as above, but for the shared premium pool — one row per
// key, not per model, since premium models all draw from the same
// bucket. Weighting real per-model cost within that 50 is a follow-up;
// for now every premium request just counts as 1, same as OpenRouter.
function literouterPremiumSnapshot() {
  const today = dayKeyAtUtcHourOffset(LITEROUTER_RESET_UTC_HOUR);
  return LITEROUTER_KEYS.map((_, idx) => {
    const state = literouterPremiumKeyState[idx];
    const used = (state && state.day === today) ? state.count : 0;
    return { envName: LITEROUTER_KEY_ENTRIES[idx].envName, used, cap: LITEROUTER_PREMIUM_DAILY_CAP };
  });
}

// ============================================================
// PROVIDER CREDIT / QUOTA TRACKING
// ── Generic, optional, provider-agnostic. A provider can have:
//    • a self-tracked soft daily/monthly token limit; or
//    • no configured limit at all; or
//    • a future provider-specific balance source implemented separately.
// ── Never invents a provider balance. Missing values remain unknown.
// ============================================================
let PROVIDER_QUOTAS = {};
try {
  PROVIDER_QUOTAS = JSON.parse(process.env.PROVIDER_QUOTAS_JSON || '{}');
  if (!PROVIDER_QUOTAS || typeof PROVIDER_QUOTAS !== 'object' || Array.isArray(PROVIDER_QUOTAS)) PROVIDER_QUOTAS = {};
} catch (e) {
  log('WARN', `Ignoring invalid PROVIDER_QUOTAS_JSON: ${e.message}`);
  PROVIDER_QUOTAS = {};
}
// Example shape (only configure this when the provider actually grants/refills it):
// {
//   "some-provider": { "softDailyTokenLimit": 100000, "softMonthlyTokenLimit": 2000000 }
// }
// No provider is given a fictional balance by default.


const providerQuotaState = {};

function getProviderQuotaState(provider) {
  if (!providerQuotaState[provider]) {
    providerQuotaState[provider] = {
      day: new Date().toISOString().slice(0, 10),
      month: new Date().toISOString().slice(0, 7),
      dailyTokens: 0,
      monthlyTokens: 0
    };
  }
  return providerQuotaState[provider];
}

function recordProviderTokens(provider, tokens) {
  if (!tokens || tokens <= 0) return;
  const state = getProviderQuotaState(provider);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  if (state.day !== day) { state.day = day; state.dailyTokens = 0; }
  if (state.month !== month) { state.month = month; state.monthlyTokens = 0; }
  state.dailyTokens += tokens;
  state.monthlyTokens += tokens;
}

function getProviderQuotaSnapshot(provider) {
  const policy = PROVIDER_QUOTAS[provider] || {};
  const state = getProviderQuotaState(provider);
  return {
    provider,
    configured: Object.keys(policy).length > 0,
    policy,
    dailyTokensUsed: state.dailyTokens,
    monthlyTokensUsed: state.monthlyTokens,
    dailyTokensRemaining: Number.isFinite(policy.softDailyTokenLimit)
      ? Math.max(0, policy.softDailyTokenLimit - state.dailyTokens) : null,
    monthlyTokensRemaining: Number.isFinite(policy.softMonthlyTokenLimit)
      ? Math.max(0, policy.softMonthlyTokenLimit - state.monthlyTokens) : null
  };
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
  [process.env.MY_KEY]: { name: 'me', limit: null }
};

const SHARED_KEYS = {
  [process.env.MY_KEY]:    { name: 'me',    limit: null },
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
    const userKeys = Object.entries(keys).filter(([_, v]) => v.limit === null && v.name !== 'me');
    const perUser = userKeys.length > 0 ? Math.floor(20 / userKeys.length) : 0;
    for (const [k, v] of userKeys) keys[k] = { ...v, limit: perUser };
  }
  return keys;
}

const usageTracker = {};

function checkRateLimit(apiKey) {
  const keyMap = buildKeyMap();
  const keyInfo = keyMap[apiKey];
  if (!keyInfo) return { allowed: false, invalidKey: true, reason: 'Invalid API key' };
  const now = Date.now();
  if (!usageTracker[apiKey] || now > usageTracker[apiKey].resetAt) {
    usageTracker[apiKey] = { count: 0, resetAt: now + 60000 };
  }
  // Count unlimited keys too — otherwise /health and the Admin usage view
  // report 0 requests forever for exactly the key that sees all the traffic.
  // (count > limit below is equivalent to the old check-then-increment order.)
  usageTracker[apiKey].count++;
  if (keyInfo.limit === null || keyInfo.limit === undefined) {
    return { allowed: true, unlimited: true };
  }
  if (usageTracker[apiKey].count > keyInfo.limit) {
    const waitSec = Math.ceil((usageTracker[apiKey].resetAt - now) / 1000);
    return { allowed: false, reason: `Rate limit hit. Try again in ${waitSec}s` };
  }
  return { allowed: true };
}

// ============================================================
// TOKEN ESTIMATE (rough heuristic — chars/4 — good enough for a threshold check)
// ============================================================
// Text-ish size of a message, including the shapes coding agents send:
// array content parts ([{type:'text', text}, ...]) and assistant tool_calls.
function messageText(m) {
  let t = '';
  if (typeof m?.content === 'string') t = m.content;
  else if (Array.isArray(m?.content)) t = m.content.map(p => (typeof p === 'string' ? p : (p?.text || ''))).join(' ');
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length) t += ' ' + JSON.stringify(m.tool_calls);
  return t;
}
// ~4 chars per token — rough, but it matched a real NIM run for GLM-5.3.
function sizeStr(chars) {
  return `${chars} chars ≈ ${Math.round(chars / 4)} tokens`;
}
// 12345ms -> "12.345s"; 635694ms -> "10m 35s"; 3725000ms -> "1h 2m 5s".
// Hours only show up once it has actually been an hour; minutes once a minute.
function humanDuration(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(3)}s`;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`;
}
function estimateTokens(messages) {
  const text = (messages || []).map(messageText).join(' ');
  return Math.ceil(text.length / 4);
}

// What a provider's TPM (tokens per minute) actually counts: INPUT tokens —
// the prompt, plus tool/response-format schemas which are sent as input too.
// max_tokens is an OUTPUT allowance and must not be added here: a client
// sending max_tokens 0 (which becomes the 9024 fallback or a hop's maxTokens
// floor) used to inflate a ~9.5K prompt to ~18.5K and get the Google hop
// skipped for "exceeding" a 14K/16K limit it was nowhere near.
// Providers whose TPM counts INPUT tokens only (confirmed for Google AI
// Studio). For any provider NOT in this list, how its token limit is counted
// isn't known, so the estimate stays conservative: input + max_tokens.
// The list lives in provider-limits.json ("tpmCountsInputOnly"); add a
// provider there once its dashboard confirms it counts input only.
function tpmCountsInputOnly(provider) {
  const list = Array.isArray(PROVIDER_LIMITS.tpmCountsInputOnly) ? PROVIDER_LIMITS.tpmCountsInputOnly : ['google'];
  return list.includes(provider);
}
function fmtN(n) { return Number(n).toLocaleString('en-US'); }
// 4200ms -> "4s"; 254000ms -> "4m 14s" (whole seconds — for notices, not stats).
function shortDuration(ms) { return ms < 60000 ? `${Math.round(ms / 1000)}s` : humanDuration(ms); }
function secsToNextMinute() { return Math.max(1, Math.ceil((60000 - (Date.now() % 60000)) / 1000)); }
// A display name for logs/errors — Google hops are sometimes stored as
// "models/gemini-…"; the wire name is left alone, only the label is tidied.
function displayModel(provider, model) { return provider === 'google' ? String(model || '').replace(/^models\//i, '') : model; }
function hopLabel(pc) { return `${pc.provider}/${displayModel(pc.provider, pc.model)}`; }
function estimateInputTokens(req) {
  let n = estimateTokens(req && req.messages);
  for (const k of ['tools', 'response_format']) {
    if (req && req[k]) { try { n += Math.ceil(JSON.stringify(req[k]).length / 4); } catch (_) { /* unserializable — ignore */ } }
  }
  return n;
}
// Tokens a request counts against a limit on `provider`: input only where
// that is known (tpmCountsInputOnly), input + max_tokens where it isn't.
function estimateRequestTokens(req, provider) {
  const input = estimateInputTokens(req);
  return tpmCountsInputOnly(provider) ? input : input + ((req && req.max_tokens) || 0);
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
// A "container"/"bundle" entry (custom: true) is built by copying an
// existing model's config into each hop slot when it's added in the admin
// UI — a one-time COPY, not a live link. Editing the bundled copy afterward
// never touches the original standalone entry, and editing the original
// later never touches the copy — they fork apart the moment you add it.
// A bundle that's just one untouched copied hop behaves identically to the
// model it was copied from (same chain, new name) — effectively an alias,
// until you actually change something in it.
//
// "Unlimited"-labeled hops (and nvidia hops by default — see
// isUnlimitedRetryHop) get retried on the SAME hop, with backoff, before
// falling through to the next one — see makeAPICall.
//
// reasoning schemas live in reasoning-schemas.json. A schema describes how
// reasoning-related request parameters are represented (for example
// chat_template_kwargs or top-level fields), without pretending the schema is
// tied to one model vendor. Each model entry selects a reusable schema with
// `reasoningSchema` and stores its current values under `reasoning`.
// Missing schema = send no reasoning override and let the model/provider default.
//
// per-hop fields:
//   timeoutMs → overrides the default 300000ms timeout for that hop only
//   tpmLimit  → max INPUT size of a single request (estimated tokens, output/
//               max_tokens NOT counted). If a request is bigger, that hop is
//               skipped straight to the next one (saves burning a doomed
//               request). Not a per-minute budget — that is `tpm` (Google).
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
const REASONING_SCHEMAS_PATH = path.join(__dirname, 'reasoning-schemas.json');
const MODEL_PRESETS_PATH = path.join(__dirname, 'model-presets.json');
// OpenRouter/Literouter per-key usage counters — see "Persisting usage
// state across restarts" further down for why this exists.
const USAGE_STATE_PATH = path.join(__dirname, 'usage-state.json');

function loadReasoningSchemasFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(REASONING_SCHEMAS_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`Could not load ${REASONING_SCHEMAS_PATH}: ${e.message}. Make sure reasoning-schemas.json is deployed alongside server.js.`);
  }
}

// Model config now lives in models.json instead of hardcoded here, so the
// admin panel (see ADMIN ROUTES below) can add/edit/remove models without
// a redeploy — same "just change it, no redeploy" philosophy as the key
// rotation below. loadModelsFromDisk() re-reads from disk; saveModels()
// persists admin edits back to it (and to GitHub, see below).
function loadModelsFromDisk() {
  try {
    const raw = fs.readFileSync(MODELS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Could not load ${MODELS_PATH}: ${e.message}. Make sure models.json is deployed alongside server.js.`);
  }
}

// MODEL_PRESETS remembers a confirmed-good full reasoning config for a
// SPECIFIC model (keyed "provider/model", exact match), separate from the
// reasoning-schema match rules above which only pick a schema family-wide.
// Once you've actually tested a model and know what works, re-importing
// that exact model later (Admin > Sync) applies the saved config
// automatically instead of resetting to blank switches. Missing this file
// is not fatal — it just means nothing gets auto-applied on import yet.
function loadModelPresetsFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(MODEL_PRESETS_PATH, 'utf8'));
  } catch (e) {
    log('WARN', `Could not load ${MODEL_PRESETS_PATH} (${e.message}) — sync-import won't auto-apply any known-good configs.`);
    return {};
  }
}

// Bound but populated after the GitHub boot sync below (see
// bootstrapConfigAndStart) — REASONING_SCHEMAS and MODEL_PRESETS stay
// stable object references (mutated in place) so every existing
// `REASONING_SCHEMAS[x]`/`MODEL_PRESETS[x]` read/write elsewhere in this
// file keeps working untouched; MODEL_MAPPING is reassigned wholesale on
// load/reload, same as before.
const REASONING_SCHEMAS = {};
const MODEL_PRESETS = {};
let MODEL_MAPPING = {};

// Presets are keyed by exact "provider/model" — not a prefix or pattern —
// on purpose. A prefix match here would reintroduce exactly the trap this
// whole system was built to avoid: assuming two models with a similar
// name behave identically.
function presetKeyFor(provider, model) {
  return `${provider}/${model}`;
}



// ============================================================
// GITHUB SYNC (optional, free) — makes admin-panel edits survive a
// restart on Render's Free tier.
//
// Render's Free web services have NO persistent disk: every restart
// (crash, redeploy, or Render just cycling the instance) boots a fresh
// container from the last *deployed* image, not from whatever
// fs.writeFileSync left lying around. So admin edits used to live only
// until the next restart, exactly as the old comment here warned.
//
// If GITHUB_TOKEN + GITHUB_REPO are set (both free — a GitHub personal
// access token costs nothing), every admin save is committed straight to
// that repo, and on boot the server pulls the latest committed copy
// before falling back to whatever's baked into the deploy image. No paid
// disk, no external database, no new service to pay for.
//
// Required env vars to enable this:
//   GITHUB_TOKEN   - a fine-grained PAT scoped to this one repo,
//                    Contents: Read and write
//   GITHUB_REPO    - "your-username/your-repo-name"
// Optional:
//   GITHUB_BRANCH        - defaults to "main"
//   GITHUB_MODELS_PATH   - defaults to "models.json"
//   GITHUB_SCHEMAS_PATH  - defaults to "reasoning-schemas.json"
//
// If these aren't set, Q-Proxy runs exactly as before — local-disk-only,
// edits lost on restart — and logs a warning on boot so that's obvious
// rather than a silent surprise the next time the free instance recycles.
// ============================================================
const GITHUB_TOKEN        = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO         = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH       = process.env.GITHUB_BRANCH || 'main';
const GITHUB_MODELS_PATH  = process.env.GITHUB_MODELS_PATH || 'models.json';
const GITHUB_SCHEMAS_PATH = process.env.GITHUB_SCHEMAS_PATH || 'reasoning-schemas.json';
const GITHUB_PRESETS_PATH = process.env.GITHUB_PRESETS_PATH || 'model-presets.json';
const GITHUB_USAGE_PATH   = process.env.GITHUB_USAGE_PATH || 'usage-state.json';
const GITHUB_LIMITS_PATH  = process.env.GITHUB_LIMITS_PATH || 'provider-limits.json';
const GITHUB_SYNC_ENABLED = Boolean(GITHUB_TOKEN && GITHUB_REPO);

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'q-proxy-admin',
  };
}

async function githubFetchFile(repoPath) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(repoPath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
  const res = await axios.get(url, { headers: githubHeaders(), validateStatus: () => true, timeout: 10000 });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`GitHub GET ${repoPath} failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { sha: res.data.sha, content: Buffer.from(res.data.content, 'base64').toString('utf8') };
}

// Commits a file to the repo. Fetches the current sha first (GitHub's
// Contents API requires it for updating an existing file); if that check
// fails we still attempt the write, since a brand-new file needs no sha
// and GitHub will just reject it with a clear error otherwise.
async function githubPutFile(repoPath, contentString, message) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(repoPath)}`;
  let sha;
  try {
    const existing = await githubFetchFile(repoPath);
    sha = existing ? existing.sha : undefined;
  } catch (_) { /* fall through and let GitHub's own error surface below */ }
  const res = await axios.put(url, {
    message,
    content: Buffer.from(contentString, 'utf8').toString('base64'),
    branch: GITHUB_BRANCH,
    ...(sha ? { sha } : {}),
  }, { headers: githubHeaders(), validateStatus: () => true, timeout: 15000 });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`GitHub PUT ${repoPath} failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

// Pulls the latest committed config from GitHub down onto local disk
// before the server loads it, so a freshly-booted container starts from
// the last saved admin state instead of the code deploy's baked-in copy.
async function syncConfigFromGitHubOnBoot() {
  if (!GITHUB_SYNC_ENABLED) {
    log('WARN', 'GITHUB_TOKEN/GITHUB_REPO not set — admin panel edits will NOT survive a restart on Render Free. See README > Persistence.');
    return;
  }
  for (const [repoPath, localPath] of [[GITHUB_MODELS_PATH, MODELS_PATH], [GITHUB_SCHEMAS_PATH, REASONING_SCHEMAS_PATH], [GITHUB_PRESETS_PATH, MODEL_PRESETS_PATH], [GITHUB_USAGE_PATH, USAGE_STATE_PATH], [GITHUB_LIMITS_PATH, PROVIDER_LIMITS_PATH]]) {
    try {
      const remote = await githubFetchFile(repoPath);
      if (remote) {
        JSON.parse(remote.content); // sanity-check before overwriting the local copy
        fs.writeFileSync(localPath, remote.content);
        log('INFO', `[github-sync] pulled latest ${repoPath} from ${GITHUB_REPO}@${GITHUB_BRANCH} on boot`);
      } else {
        log('WARN', `[github-sync] ${repoPath} not found in ${GITHUB_REPO}@${GITHUB_BRANCH} — using the copy baked into this deploy instead`);
      }
    } catch (e) {
      log('WARN', `[github-sync] could not pull ${repoPath} from GitHub on boot (${e.message}) — using the copy baked into this deploy instead`);
    }
  }
  reloadProviderLimits();   // provider-limits.json is read at load time, i.e. BEFORE this pull
}

// Pushes a local save up to GitHub. Never throws — a GitHub outage or bad
// token should not stop the local save from succeeding; callers get a
// { ok, error } result back so the admin UI can show "saved locally, but
// GitHub sync failed" instead of silently losing the change on next restart.
async function githubSyncFile(repoPath, contentString, message) {
  if (!GITHUB_SYNC_ENABLED) return { ok: false, skipped: true };
  try {
    await githubPutFile(repoPath, contentString, message);
    return { ok: true };
  } catch (e) {
    log('WARN', `[github-sync] push of ${repoPath} failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Writes models.json/reasoning-schemas.json locally, then (if GitHub sync
// is configured) pushes the same content to the repo. The local write
// still throws on failure — that's a real problem and the request should
// fail. The GitHub push never throws; its result is returned so callers
// can tell the admin "saved, but not backed up to GitHub" instead of that
// failing silently until the next restart wipes the local-only change.
async function saveModels(mapping, commitMessage) {
  const json = JSON.stringify(mapping, null, 2);
  fs.writeFileSync(MODELS_PATH, json);
  return githubSyncFile(GITHUB_MODELS_PATH, json, commitMessage || 'Q-Proxy admin: update models.json');
}

async function saveReasoningSchemas(commitMessage) {
  const json = JSON.stringify(REASONING_SCHEMAS, null, 2);
  fs.writeFileSync(REASONING_SCHEMAS_PATH, json);
  return githubSyncFile(GITHUB_SCHEMAS_PATH, json, commitMessage || 'Q-Proxy admin: update reasoning-schemas.json');
}

async function saveModelPresets(commitMessage) {
  const json = JSON.stringify(MODEL_PRESETS, null, 2);
  fs.writeFileSync(MODEL_PRESETS_PATH, json);
  return githubSyncFile(GITHUB_PRESETS_PATH, json, commitMessage || 'Q-Proxy admin: update model-presets.json');
}

// ── Persisting usage state across restarts ──────────────────────────
// literouterKeyState / openrouterKeyState only ever lived in memory,
// which is a big part of why Q-Proxy's counters drift from Literouter's
// own tracker so often: Render recycles the container on every spin-
// down/wake cycle and every redeploy, wiping these counters to zero,
// while the providers' own server-side counts don't reset just because
// your process restarted. This persists them the same way models.json
// etc. already are — pulled from GitHub on boot, pushed back on a short
// debounce rather than on every single request (writing on every
// request would hammer the GitHub API and add latency to every
// completion for no real benefit) — so a restart loses at most a few
// seconds of counting instead of the whole day's.
function loadUsageStateFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_STATE_PATH, 'utf8'));
  } catch (e) {
    log('WARN', `Could not load ${USAGE_STATE_PATH} (${e.message}) — starting usage counters fresh (expected on first boot).`);
    return null;
  }
}

// Google limit mismatches learned from Google's own 429s (see learnGoogleLimitsFrom429).
// Persisted with the usage state so the "limits may be outdated" warning survives a restart.
let googleLimitMismatches = [];
// Hop warnings learned from the provider (see "Hop warnings" below) and when each provider's live list was last checked.
let hopWarnings = {};
let catalogCheckedAt = {};
// Drops warnings for models no longer configured. An EMPTY config (file missing/blanked) prunes nothing.
function pruneHopWarnings() {
  if (!Object.keys(MODEL_MAPPING).length) return;
  const live = new Set();
  forEachHop((id, hop) => live.add(hopWarnKey(hop.provider, hop.model)));
  for (const k of Object.keys(hopWarnings)) if (!live.has(k)) delete hopWarnings[k];
}
async function saveUsageState(commitMessage) {
  pruneHopWarnings();
  const snapshot = {
    savedAt: new Date().toISOString(),
    literouterKeyState,
    literouterPremiumKeyState,
    literouterFreeModelCursor,
    literouterLastResetDay,
    literouterRotationIndex,
    literouterPremiumRotationIndex,
    openrouterKeyState,
    openrouterKeyIndex,
    googleModelCursor,
    googleUsageWindows,
    googleLastResetDay,
    googleLimitMismatches,
    hopWarnings,
    catalogCheckedAt,
  };
  const json = JSON.stringify(snapshot, null, 2);
  fs.writeFileSync(USAGE_STATE_PATH, json);
  return githubSyncFile(GITHUB_USAGE_PATH, json, commitMessage || 'Q-Proxy: periodic usage-state snapshot');
}

// Called once at boot (see bootstrapConfigAndStart), after the GitHub
// pull has had a chance to put a fresher usage-state.json on local disk
// than whatever was baked into this deploy. literouterKeyState /
// openrouterKeyState stay the same object/array references (mutated in
// place) for the same reason REASONING_SCHEMAS/MODEL_PRESETS do —
// everywhere else in the file that already reads/writes them keeps
// working untouched.
function hydrateUsageStateFromDisk() {
  const saved = loadUsageStateFromDisk();
  if (!saved) return;
  if (saved.literouterKeyState) Object.assign(literouterKeyState, saved.literouterKeyState);
  if (Array.isArray(saved.literouterPremiumKeyState)) {
    saved.literouterPremiumKeyState.forEach((s, i) => { if (s) literouterPremiumKeyState[i] = s; });
  }
  if (saved.literouterFreeModelCursor) Object.assign(literouterFreeModelCursor, saved.literouterFreeModelCursor);
  if (typeof saved.literouterLastResetDay === 'string') literouterLastResetDay = saved.literouterLastResetDay;
  if (typeof saved.literouterRotationIndex === 'number') literouterRotationIndex = saved.literouterRotationIndex;
  if (typeof saved.literouterPremiumRotationIndex === 'number') literouterPremiumRotationIndex = saved.literouterPremiumRotationIndex;
  if (Array.isArray(saved.openrouterKeyState)) {
    saved.openrouterKeyState.forEach((s, i) => { if (openrouterKeyState[i] && s) Object.assign(openrouterKeyState[i], s); });
  }
  if (typeof saved.openrouterKeyIndex === 'number') openrouterKeyIndex = saved.openrouterKeyIndex;
  if (saved.googleModelCursor) Object.assign(googleModelCursor, saved.googleModelCursor);
  if (saved.googleUsageWindows) Object.assign(googleUsageWindows, saved.googleUsageWindows);
  if (typeof saved.googleLastResetDay === 'string') googleLastResetDay = saved.googleLastResetDay;
  if (Array.isArray(saved.googleLimitMismatches)) googleLimitMismatches = saved.googleLimitMismatches.slice(0, 20);
  if (saved.hopWarnings && typeof saved.hopWarnings === 'object' && !Array.isArray(saved.hopWarnings)) hopWarnings = saved.hopWarnings;
  if (saved.catalogCheckedAt && typeof saved.catalogCheckedAt === 'object' && !Array.isArray(saved.catalogCheckedAt)) catalogCheckedAt = saved.catalogCheckedAt;
  log('INFO', `[usage-state] restored from ${saved.savedAt || 'unknown time'} — Literouter/OpenRouter counters survive this restart instead of starting at zero.`);
}

// Mark-dirty + debounced flush: pickLiterouterKey/getNextOpenRouterKey
// call markUsageStateDirty() on every real increment; this only writes
// at most once per interval no matter how many requests land in
// between. The flag clears BEFORE the write starts, not after, so an
// increment landing mid-write sets it dirty again instead of being
// silently dropped.
let usageStateDirty = false;
function markUsageStateDirty() { usageStateDirty = true; }

// ── Hop warnings ───────────────────────────────────────────────────────
// Providers change their catalogs without notice (Literouter especially). A hop that is
// still configured here can be:
//   gone            the model no longer exists at the provider
//   turned-paid     it was free; the free version is gone / the table now says paid-only
//   limits-changed  our saved limits differ from the provider's current table
// Three sources: "catalog" (the provider's live /models list no longer has it — checked when
// the Sync panel opens and every 6 hours), "request" (the provider just answered "that model
// doesn't exist" to a real request; cleared by the next success) and "snapshot" (the pasted
// tables in provider-limits.json disagree with the hop). A warning never switches a hop off —
// you decide. Put "ignoreCatalog": true on a hop that is deliberately missing from the list
// (kimi-k3 on NIM works but is hidden from /models).
function hopWarnKey(provider, model) { return `${provider}|${provider === 'google' ? normalizeGoogleModelId(model) : model}`; }
function forEachHop(cb) {
  for (const [id, entry] of Object.entries(MODEL_MAPPING)) {
    let i = 0;
    for (let hop = entry; hop; hop = hop.fallback) cb(id, hop, i++);
  }
}
function similarLiveIds(id, live) {
  const strip = (x) => x.replace(/:free$/, '').replace(/-preview(-\d[\w-]*)?$/, '');
  return [...live].filter(l => l !== id && (strip(l) === strip(id) || l.startsWith(id + '-'))).slice(0, 3);
}
function catalogDriftFor(provider, live) {
  const canon = provider === 'google' ? normalizeGoogleModelId : (x) => x;
  const out = {};
  forEachHop((entryId, hop) => {
    if (hop.provider !== provider || hop.ignoreCatalog === true) return;
    const id = canon(hop.model), key = hopWarnKey(provider, hop.model);
    if (live.has(id) || out[key]) return;
    if (id.endsWith(':free') && live.has(id.slice(0, -5))) {
      out[key] = { kind: 'turned-paid', detail: `"${id}" is no longer listed, but "${id.slice(0, -5)}" is — it now costs credits` };
    } else {
      const instead = similarLiveIds(id, live);
      out[key] = { kind: 'gone', detail: `no longer in ${provider}'s live model list${instead.length ? ` — listed instead: ${instead.join(', ')}` : ''}`, ...(instead.length ? { instead } : {}) };
    }
  });
  return out;
}
function applyCatalogWarnings(provider, drift) {
  let changed = false;
  for (const [k, w] of Object.entries(hopWarnings)) {
    if (w.source === 'catalog' && k.startsWith(provider + '|') && !drift[k]) { delete hopWarnings[k]; changed = true; }
  }
  for (const [k, d] of Object.entries(drift)) {
    const prev = hopWarnings[k];
    if (prev && prev.source === 'catalog' && prev.kind === d.kind && prev.detail === d.detail) continue;
    hopWarnings[k] = { ...d, source: 'catalog', since: (prev && prev.source === 'catalog' && prev.kind === d.kind) ? prev.since : new Date().toISOString() };
    changed = true;
  }
  catalogCheckedAt[provider] = new Date().toISOString();
  if (changed) {
    markUsageStateDirty();
    const mine = Object.entries(hopWarnings).filter(([k, w]) => w.source === 'catalog' && k.startsWith(provider + '|'));
    const by = mine.reduce((a, [, w]) => (a[w.kind] = (a[w.kind] || 0) + 1, a), {});
    log('WARN', `[catalog] ${provider}: ${mine.length} configured model(s) need attention (${Object.entries(by).map(([k, n]) => `${HOP_WARNING_LABEL[k] || k} ${n}`).join(', ') || 'all clear'}) — see the warnings in the Admin panel`);
  }
  return changed;
}
const HOP_WARNING_LABEL = { gone: 'gone', 'turned-paid': 'turned paid', 'limits-changed': 'limits changed' };
function noteHopGone(providerConfig, detail) {
  const k = hopWarnKey(providerConfig.provider, providerConfig.model);
  const prev = hopWarnings[k];
  if (prev && prev.source === 'catalog') return;                       // the live list already says so
  if (prev && prev.source === 'request') { prev.detail = `the provider answered: ${detail}`; return; }
  hopWarnings[k] = { kind: 'gone', detail: `the provider answered: ${detail}`, source: 'request', since: new Date().toISOString() };
  markUsageStateDirty();
  log('WARN', `[warning] ${hopLabel(providerConfig)} looks gone — ${detail}`);
}
function clearRequestWarning(providerConfig) {
  const k = hopWarnKey(providerConfig.provider, providerConfig.model);
  if (hopWarnings[k] && hopWarnings[k].source === 'request') { delete hopWarnings[k]; markUsageStateDirty(); }
}
// Disagreements between a hop and the saved tables in provider-limits.json (local, no network).
// "gone"/"turned-paid" are about the MODEL (every hop using it); "limits-changed" is about one hop's
// own numbers, so it carries the table values and only the entries whose hop actually differs.
function snapshotWarnings() {
  const out = {};
  const googleRows = PROVIDER_LIMITS.google && PROVIDER_LIMITS.google.models;
  const haveLiterouter = Object.keys(LITEROUTER_KNOWN_MODELS).length > 0;   // an empty table (file missing) must not flag everything
  const add = (key, w, entryId) => {
    if (!out[key]) out[key] = { ...w, ...(w.table ? { onlyEntries: [] } : {}) };
    if (w.table && !out[key].onlyEntries.includes(entryId)) out[key].onlyEntries.push(entryId);
  };
  forEachHop((entryId, hop) => {
    const key = hopWarnKey(hop.provider, hop.model);
    if (hop.provider === 'google' && googleRows) {
      const row = googleLimitsFor(hop.model); if (!row) return;
      if (row.noFreeAccess) { add(key, { kind: 'turned-paid', detail: `AI Studio lists 0 / 0 / 0 for "${row.label}" on the free tier — paid only` }, entryId); return; }
      const fields = ['rpm', 'tpm', 'rpd'].filter(f => row[f] != null && hop[f] != null && hop[f] !== row[f]);
      if (fields.length) add(key, { kind: 'limits-changed', detail: fields.map(f => `${f} ${fmtN(hop[f])} here vs ${fmtN(row[f])} in the saved table`).join('; '), table: Object.fromEntries(fields.map(f => [f, row[f]])) }, entryId);
    } else if (hop.provider === 'literouter' && haveLiterouter) {
      const { base, variants } = literouterBaseAndVariants(hop.model);
      if (!variants.includes('free')) return;
      const row = LITEROUTER_KNOWN_MODELS[base];
      if (!row) { add(key, { kind: 'gone', detail: 'not in the saved Literouter catalog' }, entryId); return; }
      if (!row.hasFree) { add(key, { kind: 'turned-paid', detail: 'the saved Literouter catalog lists no free version of this model' }, entryId); return; }
      if ((row.freeDailyCap ?? null) !== (hop.dailyCap ?? null)) add(key, { kind: 'limits-changed', detail: `${hop.dailyCap == null ? 'no daily cap' : hop.dailyCap + '/day'} here vs ${row.freeDailyCap == null ? 'unlimited' : row.freeDailyCap + '/day'} in the saved catalog`, table: { dailyCap: row.freeDailyCap ?? null } }, entryId);
    }
  });
  return out;
}
function allHopWarnings() {
  const byKey = { ...hopWarnings };
  for (const [k, w] of Object.entries(snapshotWarnings())) if (!byKey[k]) byKey[k] = { ...w, source: 'snapshot' };
  const entriesFor = {};
  forEachHop((id, hop) => { const k = hopWarnKey(hop.provider, hop.model); (entriesFor[k] = entriesFor[k] || new Set()).add(id); });
  const items = [];
  for (const [k, w] of Object.entries(byKey)) {
    if (!entriesFor[k]) continue;                                       // no longer configured
    const [provider, ...rest] = k.split('|');
    const { onlyEntries, ...rest2 } = w;
    items.push({ key: k, provider, model: rest.join('|'), entries: onlyEntries || [...entriesFor[k]], ...rest2 });
  }
  return items.sort((a, b) => a.provider.localeCompare(b.provider) || a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model));
}
async function runCatalogCheck(onlyProvider) {
  const results = {};
  for (const provider of SYNCABLE_PROVIDERS) {
    if (onlyProvider && provider !== onlyProvider) continue;
    try {
      const { base, key } = getProviderConfigReadOnly(provider);
      if (!key) { results[provider] = 'no key'; continue; }
      const r = await axios.get(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, timeout: 15000 });
      const canon = provider === 'google' ? normalizeGoogleModelId : (x) => x;
      const live = new Set((r.data?.data || []).map(m => canon(m.id)));
      if (!live.size) { results[provider] = 'empty list — ignored'; continue; }   // an odd/empty answer must never flag everything
      applyCatalogWarnings(provider, catalogDriftFor(provider, live));
      results[provider] = 'ok';
    } catch (e) { results[provider] = `failed: ${e.message}`; }
  }
  return results;
}
function startCatalogWatch() {
  if (process.env.QP_NO_CATALOG_WATCH) return;                          // tests only
  const run = () => runCatalogCheck().catch(e => log('WARN', `[catalog] background check failed: ${e.message}`));
  setTimeout(run, 45 * 1000).unref();
  setInterval(run, 6 * 3600 * 1000).unref();
}
const GOOGLE_GENEROUS_RPD = 500;   // free requests/day: at or above = "generous"; below = "thin ice"; 0/0/0 = paid only
function tierNotesFor(provider) {
  if (provider === 'openrouter') return { freePerDayPerKey: OPENROUTER_DAILY_CAP };
  if (provider === 'google') return { generousRpd: GOOGLE_GENEROUS_RPD };
  return null;
}

// ── Learning from Google's own 429s ───────────────────────────────────
// A Google 429 (RESOURCE_EXHAUSTED) carries QuotaFailure details naming the quota that
// was hit (quotaId) and its value (quotaValue), e.g. ...RequestsPerMinute... = "5".
// If that value differs from what a Google hop has saved, the saved value is wrong:
// fix it on every hop for that model, and remember it so the Admin panel can warn that
// the rest of the saved table may be outdated too. Shape assumed from Google's quota
// errors, NOT verified against a live 429: anything unrecognised is ignored, never guessed.
function googleQuotaField(quotaId) {
  const t = String(quotaId || '').toLowerCase().replace(/[^a-z]/g, '');
  if (t.includes('perday') && t.includes('request')) return 'rpd';
  if (t.includes('perminute') && t.includes('token')) return 'tpm';
  if (t.includes('perminute') && t.includes('request')) return 'rpm';
  return null;
}
function collectQuotaViolations(node, out, depth) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) { for (const n of node) collectQuotaViolations(n, out, depth + 1); return; }
  if (node.quotaValue !== undefined && (node.quotaId || node.quotaMetric)) out.push(node);
  for (const v of Object.values(node)) collectQuotaViolations(v, out, depth + 1);
}
function parseGoogleQuotaFrom429(bodyText) {
  const found = [];
  try { collectQuotaViolations(JSON.parse(bodyText), found, 0); } catch (_) { return []; }
  const res = [];
  for (const v of found) {
    const field = googleQuotaField(v.quotaId) || (/input_?token/i.test(String(v.quotaMetric || '')) ? 'tpm' : null);
    const value = Math.round(Number(v.quotaValue));
    if (!field || !Number.isFinite(value) || value <= 0) continue;
    const model = v.quotaDimensions && v.quotaDimensions.model ? String(v.quotaDimensions.model) : null;
    res.push({ field, value, model });
  }
  return res;
}
function learnGoogleLimitsFrom429(providerConfig, bodyText) {
  const hopModel = normalizeGoogleModelId(providerConfig.model);
  let changed = false;
  for (const v of parseGoogleQuotaFrom429(bodyText)) {
    if (v.model && normalizeGoogleModelId(v.model) !== hopModel) continue;   // another model's quota — not ours to touch
    const fixedHops = []; let ours;
    for (const [id, entry] of Object.entries(MODEL_MAPPING)) {
      for (let hop = entry; hop; hop = hop.fallback) {
        if (hop.provider !== 'google' || normalizeGoogleModelId(hop.model) !== hopModel || hop[v.field] === v.value) continue;
        if (ours === undefined) ours = hop[v.field] === undefined ? null : hop[v.field];
        hop[v.field] = v.value; fixedHops.push(id);
      }
    }
    if (!fixedHops.length) continue;
    changed = true;
    googleLimitMismatches = googleLimitMismatches.filter(m => !(m.model === hopModel && m.field === v.field));
    googleLimitMismatches.unshift({ model: hopModel, field: v.field, ours, google: v.value, at: new Date().toISOString(), fixedHops: [...new Set(fixedHops)] });
    googleLimitMismatches.length = Math.min(googleLimitMismatches.length, 20);
    log('WARN', `[limits] Google says ${hopModel} ${v.field.toUpperCase()} is ${fmtN(v.value)} (we had ${ours === null ? 'nothing' : fmtN(ours)}) — corrected on ${[...new Set(fixedHops)].join(', ')}. The rest of the saved Google limits may be outdated too: Admin → Refresh limits.`);
  }
  if (changed) {
    markUsageStateDirty();
    saveModels(MODEL_MAPPING, 'Q-Proxy: corrected a Google limit from Google\'s own 429').catch(e => log('WARN', `[limits] could not save the corrected limit: ${e.message}`));
  }
}
setInterval(() => {
  if (!usageStateDirty) return;
  usageStateDirty = false;
  saveUsageState().catch(e => log('WARN', `[usage-state] periodic save failed: ${e.message}`));
}, 30000);

// Best-effort flush on shutdown, THEN actually exit. This bit me: adding
// a signal handler in Node suppresses the default "terminate
// immediately" behavior for that signal — so the original version of
// this (which never called process.exit()) made the process silently
// ignore SIGTERM altogether, hanging until Render's grace period expired
// and it got SIGKILLed instead of shutting down cleanly. That's almost
// certainly what broke normal restarts/redeploys. The flush itself is
// still bounded (3s) so a slow/failed GitHub PUT can't extend the hang
// either — exit happens no matter what the flush does.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (usageStateDirty) {
      try {
        await Promise.race([saveUsageState('Q-Proxy: shutdown flush'), new Promise(r => setTimeout(r, 3000))]);
      } catch (_) { /* exiting regardless */ }
    }
    process.exit(0);
  });
}

// ============================================================
// GOOGLE AI STUDIO: per-model RPM/TPM/RPD tracking
// ============================================================
// Google publishes real RPM/TPM/RPD ceilings per model (unlike the
// pre-request-size-only tpmLimit check above), and its free-tier reset
// is midnight Pacific Time — which is NOT a fixed UTC-hour offset like
// Literouter's, because Pacific Time itself shifts between UTC-8 (PST)
// and UTC-7 (PDT) with US daylight saving. Intl's timezone-aware
// formatting handles that automatically; a naive fixed-hour-offset trick
// would quietly be an hour wrong for roughly half the year.
function pacificDayKey() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }); // en-CA -> YYYY-MM-DD
}

// model -> keyIndex. Same "stays pinned until it specifically runs out"
// behavior as literouterFreeModelCursor above, generalized to whichever
// of rpm/tpm/rpd dimensions a hop actually configures.
const googleModelCursor = {};
// `${model}|${keyIndex}` -> { rpmWindowMinute, rpmCount, tpmWindowMinute, tpmTokens, rpdDay, rpdCount }
const googleUsageWindows = {};
let googleLastResetDay = null;

function maybeResetGoogleCursors() {
  const today = pacificDayKey();
  if (googleLastResetDay === today) return;
  googleLastResetDay = today;
  for (const k of Object.keys(googleModelCursor)) delete googleModelCursor[k];
}

function googleWindowState(model, keyIndex) {
  const k = `${model}|${keyIndex}`;
  if (!googleUsageWindows[k]) googleUsageWindows[k] = {};
  return googleUsageWindows[k];
}

// Checks (and, if it fits, consumes) this key's rpm/tpm/rpd budget for
// this specific model — only the dimensions actually set on the hop are
// checked at all, so a hop with none of these fields behaves exactly
// like today (unlimited, no tracking).
function checkGoogleWindow(model, keyIndex, hop, estimatedTokens) {
  const state = googleWindowState(model, keyIndex);
  const nowMinute = Math.floor(Date.now() / 60000);
  if (hop.rpm) {
    if (state.rpmWindowMinute !== nowMinute) { state.rpmWindowMinute = nowMinute; state.rpmCount = 0; }
    if (state.rpmCount >= hop.rpm) return { ok: false, reason: `rpm:${state.rpmCount}/${hop.rpm}`, note: `rpm limit reached (${state.rpmCount}/${hop.rpm} requests this minute)`, retryAfterS: secsToNextMinute() };
  }
  if (hop.tpm) {
    if (state.tpmWindowMinute !== nowMinute) { state.tpmWindowMinute = nowMinute; state.tpmTokens = 0; }
    if ((state.tpmTokens || 0) + estimatedTokens > hop.tpm) {
      const used = state.tpmTokens || 0;
      // Would it fit in an EMPTY minute? Then waiting helps; if not, no wait ever will.
      const fitsWhenEmpty = estimatedTokens <= hop.tpm;
      return { ok: false, reason: `tpm:${used}+${estimatedTokens}>${hop.tpm}`,
        note: fitsWhenEmpty
          ? `tpm limit: ${fmtN(used)} of ${fmtN(hop.tpm)} input tokens already used this minute and this request needs ≈ ${fmtN(estimatedTokens)}`
          : `request ≈ ${fmtN(estimatedTokens)} input tokens is bigger than this model's whole ${fmtN(hop.tpm)}/min limit, so it can never fit — shorten the prompt`,
        ...(fitsWhenEmpty ? { retryAfterS: secsToNextMinute() } : {}) };
    }
  }
  if (hop.rpd) {
    const today = pacificDayKey();
    if (state.rpdDay !== today) { state.rpdDay = today; state.rpdCount = 0; }
    if (state.rpdCount >= hop.rpd) return { ok: false, reason: `rpd:${state.rpdCount}/${hop.rpd}`, note: `daily limit reached (${state.rpdCount}/${hop.rpd} requests today) — resets at midnight Pacific` };
  }
  if (hop.rpm) state.rpmCount = (state.rpmCount || 0) + 1;
  if (hop.tpm) state.tpmTokens = (state.tpmTokens || 0) + estimatedTokens;
  if (hop.rpd) {
    const today = pacificDayKey();
    if (state.rpdDay !== today) { state.rpdDay = today; state.rpdCount = 0; }
    state.rpdCount = (state.rpdCount || 0) + 1;
  }
  markUsageStateDirty();
  return { ok: true };
}

// Returns { key, keyIndex } for the first Google key with room left for
// THIS model on every dimension the hop configures, or null if every key
// is out of room for it right now. A hop with no rpm/tpm/rpd set at all
// skips tracking entirely and just uses whichever key the model is
// already pinned to (or key 0), same as today's behavior.
function pickGoogleKey(model, hop, estimatedTokens, why) {
  if (!GOOGLE_KEYS.length) return null;
  if (!hop.rpm && !hop.tpm && !hop.rpd) {
    // Modulo guard: the cursor is persisted in usage-state.json and can point
    // past the end if keys were removed since it was saved.
    const idx = (googleModelCursor[model] || 0) % GOOGLE_KEYS.length;
    return { key: GOOGLE_KEYS[idx], keyIndex: idx };
  }
  maybeResetGoogleCursors();
  const startIdx = googleModelCursor[model] || 0;
  for (let i = 0; i < GOOGLE_KEYS.length; i++) {
    const idx = (startIdx + i) % GOOGLE_KEYS.length;
    const chk = checkGoogleWindow(model, idx, hop, estimatedTokens);
    if (chk.ok) {
      googleModelCursor[model] = idx; // pinned here until this key specifically runs out for this model
      return { key: GOOGLE_KEYS[idx], keyIndex: idx };
    }
    if (Array.isArray(why) && chk.reason) why.push(chk);
  }
  return null;
}

function nextUtcHourResetAt(utcHour) {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(utcHour, 0, 0, 0);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}
function nextLiterouterResetAt() { return nextUtcHourResetAt(LITEROUTER_RESET_UTC_HOUR); }
function nextOpenRouterResetAt() { return nextUtcHourResetAt(OPENROUTER_RESET_UTC_HOUR); }

// DST-safe: works off actual elapsed wall-clock time within the current
// Pacific day rather than assuming a fixed UTC offset, so it's correct
// on both sides of the March/November transitions. (The one edge case
// this doesn't special-case is the transition day itself, which is 23
// or 25 hours long in Pacific time — this display could be off by an
// hour specifically on those two days a year; the actual usage-tracking
// reset above uses toLocaleDateString instead and isn't affected.)
function nextGoogleResetAt() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(now);
  const get = (t) => Number(parts.find(p => p.type === t).value);
  const elapsedMs = (get('hour') % 24) * 3600000 + get('minute') * 60000 + get('second') * 1000;
  return new Date(now.getTime() + (24 * 3600000 - elapsedMs));
}

// Used by the admin dashboard's countdown timers — ship one absolute
// timestamp per provider so the client just ticks down to a fixed
// instant instead of re-deriving timezone/DST math itself.
function providerResetInfo() {
  return {
    literouter: { resetsAt: nextLiterouterResetAt().toISOString(), boundary: '00:00 GMT+7', resetUtcHour: LITEROUTER_RESET_UTC_HOUR },
    openrouter: { resetsAt: nextOpenRouterResetAt().toISOString(), boundary: '00:00 UTC', resetUtcHour: OPENROUTER_RESET_UTC_HOUR },
    google: { resetsAt: nextGoogleResetAt().toISOString(), boundary: 'midnight Pacific Time (RPD only; RPM/TPM reset every minute)', timezone: 'America/Los_Angeles' }
  };
}

// Per-model, per-key rpm/tpm/rpd usage for any Google hop that actually
// configures at least one of those — mirrors literouterCapSnapshot's
// shape so the admin dashboard can render both the same way.
function googleUsageSnapshot() {
  const nowMinute = Math.floor(Date.now() / 60000);
  const today = pacificDayKey();
  const byModel = {};
  for (const entry of Object.values(MODEL_MAPPING || {})) {
    let cur = entry;
    let depth = 0;
    while (cur) {
      // Same cycle guard as literouterCapSnapshot — hand-edited models.json
      // with a fallback loop must not hang /admin/api/usage.
      if (++depth > 50) break;
      if (cur.provider === 'google' && (cur.rpm || cur.tpm || cur.rpd) && !byModel[cur.model]) {
        byModel[cur.model] = {
          model: cur.model, rpm: cur.rpm || null, tpm: cur.tpm || null, rpd: cur.rpd || null,
          keys: GOOGLE_KEY_ENTRIES.map((entryK, idx) => {
            const state = googleUsageWindows[`${cur.model}|${idx}`] || {};
            return {
              envName: entryK.envName,
              rpmUsed: state.rpmWindowMinute === nowMinute ? (state.rpmCount || 0) : 0,
              tpmUsed: state.tpmWindowMinute === nowMinute ? (state.tpmTokens || 0) : 0,
              rpdUsed: state.rpdDay === today ? (state.rpdCount || 0) : 0,
            };
          })
        };
      }
      cur = cur.fallback;
    }
  }
  return Object.values(byModel);
}

// ============================================================
// PROVIDER CONFIG
// ============================================================
function getProviderConfig(provider) {
  switch (provider) {
    case 'zai':        return { base: 'https://api.z.ai/api/paas/v4',                key: ZAI_API_KEY };
    // google is normally resolved by makeAPICall via pickGoogleKey()
    // (needs the model + hop's rpm/tpm/rpd to pick the right key). This
    // branch is only a fallback for callers without that context.
    case 'google':     return { base: GOOGLE_RELAY_BASE,                             key: GOOGLE_KEYS[0] };
    case 'deepseek':   return { base: 'https://api.deepseek.com',                    key: DEEPSEEK_API_KEY };
    case 'openrouter': return { base: 'https://openrouter.ai/api/v1',                key: getNextOpenRouterKey() };
    // literouter is normally resolved by makeAPICall via pickLiterouterKey()
    // (needs the model + dailyCap to pick the right key). This branch is
    // only a fallback for callers that don't have that context.
    case 'literouter': return { base: 'https://api.literouter.com/v1',               key: LITEROUTER_KEYS[0] };
    case 'meganova':   return { base: 'https://api.meganova.ai/v1',                  key: MEGANOVA_API_KEY };
    default:           return { base: 'https://integrate.api.nvidia.com/v1',         key: NIM_API_KEY };
  }
}

// Same base-URL resolution as getProviderConfig, but never advances the
// OpenRouter/Literouter rotation counters. Use this anywhere a key is
// needed just to make a housekeeping call (e.g. admin catalog sync) that
// isn't a real chat completion — otherwise every sync check silently
// eats into OpenRouter's real 50/day/key budget for nothing.
function getProviderConfigReadOnly(provider) {
  switch (provider) {
    case 'zai':        return { base: 'https://api.z.ai/api/paas/v4',                key: ZAI_API_KEY };
    case 'google':     return { base: GOOGLE_RELAY_BASE,                             key: GOOGLE_KEYS[0] };
    case 'deepseek':   return { base: 'https://api.deepseek.com',                    key: DEEPSEEK_API_KEY };
    case 'openrouter': return { base: 'https://openrouter.ai/api/v1',                key: OPENROUTER_KEYS[0] };
    case 'literouter': return { base: 'https://api.literouter.com/v1',               key: LITEROUTER_KEYS[0] };
    case 'meganova':   return { base: 'https://api.meganova.ai/v1',                  key: MEGANOVA_API_KEY };
    default:           return { base: 'https://integrate.api.nvidia.com/v1',         key: NIM_API_KEY };
  }
}

// ============================================================
// REASONING PARAMS
// ============================================================
function getReasoningBody(providerConfig) {
  const schemaName = providerConfig.reasoningSchema;
  if (!schemaName) return undefined;

  const schema = REASONING_SCHEMAS[schemaName];
  if (!schema) {
    log('WARN', `Unknown reasoning schema "${schemaName}" for ${providerConfig.provider}/${providerConfig.model}; sending no reasoning override.`);
    return undefined;
  }

  const configured = providerConfig.reasoning && typeof providerConfig.reasoning === 'object'
    ? providerConfig.reasoning
    : {};
  const enabledMap = providerConfig.reasoningFieldEnabled && typeof providerConfig.reasoningFieldEnabled === 'object'
    ? providerConfig.reasoningFieldEnabled
    : {};

  // Fields within ONE schema can each end up on a different wire
  // transport per hop (e.g. this model's thinking toggle rides in
  // chat_template_kwargs, but its effort level is a genuine top-level
  // field) — so results are grouped by transport instead of assuming the
  // whole schema shares one.
  const byTransport = {};

  for (const [fieldName, field] of Object.entries(schema.fields || {})) {
    // A field with an enable switch (the unified thinking+effort schema)
    // is skipped entirely — not sent, not even blank — unless this hop
    // explicitly turned it on. That's what "this model doesn't have a
    // reasoning-effort parameter, don't offer it and don't send anything"
    // actually means at the wire level. Older schemas without an enable
    // switch behave exactly as before: present in the schema == in play.
    const hasEnableSwitch = Object.prototype.hasOwnProperty.call(field, 'enabledByDefault');
    if (hasEnableSwitch && !enabledMap[fieldName]) continue;

    const rawValue = configured[fieldName];

    // An explicitly blank value means "Custom was picked for this field
    // but nothing has been typed yet" — send nothing for it rather than
    // silently falling back to the schema's default. Nothing should
    // override the provider's own behavior until a real value is picked.
    if (rawValue === '') continue;

    let value = rawValue;
    if (value === undefined) value = field.default;
    if (value === undefined) continue;

    if (field.type === 'boolean') {
      if (typeof value === 'string') value = value.toLowerCase() === 'true';
      value = Boolean(value);
    } else if (field.type === 'select') {
      if (field.optionsPerHop) {
        // This field's valid values are curated per model (in the hop's
        // reasoningFieldOptions), not fixed by the schema — e.g. one model
        // supports low/high/max, another supports none/medium/high. Trust
        // whatever value the admin configured or typed in for this
        // specific hop instead of clamping against a schema-wide list.
        value = String(value);
      } else if (Array.isArray(field.options) && !field.options.includes(value)) {
        value = field.default;
      }
    } else if (field.type === 'json') {
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { value = field.default ?? {}; }
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) value = field.default ?? {};
    }

    // Some models share the same semantic field (a thinking on/off toggle,
    // say) but the provider's chat template actually reads a different
    // literal key for it — e.g. "enable_thinking" on one model, "thinking"
    // on another. field.keyPerHop lets a hop remap the schema's field name
    // to whatever key that specific model's template actually expects,
    // without needing a whole separate schema per key name.
    const wireKey = (field.keyPerHop && providerConfig.reasoningFieldKeys && providerConfig.reasoningFieldKeys[fieldName])
      ? providerConfig.reasoningFieldKeys[fieldName]
      : fieldName;

    // Special case: a raw JSON field (the escape-hatch schemas) IS the
    // whole body for its transport, not a key inside it.
    if (fieldName === '__raw') {
      const transport = field.transportPerHop && providerConfig.reasoningFieldTransport && providerConfig.reasoningFieldTransport[fieldName]
        ? providerConfig.reasoningFieldTransport[fieldName]
        : (schema.transport || 'top_level');
      byTransport[transport] = { ...(byTransport[transport] || {}), ...(value && typeof value === 'object' ? value : {}) };
      continue;
    }

    const transport = (field.transportPerHop && providerConfig.reasoningFieldTransport && providerConfig.reasoningFieldTransport[fieldName])
      ? providerConfig.reasoningFieldTransport[fieldName]
      : (schema.transport || 'top_level');
    if (!byTransport[transport]) byTransport[transport] = {};
    byTransport[transport][wireKey] = value;
  }

  const result = {};
  if (byTransport.chat_template_kwargs && Object.keys(byTransport.chat_template_kwargs).length) {
    result.chat_template_kwargs = byTransport.chat_template_kwargs;
  }
  if (byTransport.top_level && Object.keys(byTransport.top_level).length) {
    Object.assign(result, byTransport.top_level);
  }
  for (const [transport, fields] of Object.entries(byTransport)) {
    if (transport === 'chat_template_kwargs' || transport === 'top_level') continue;
    log('WARN', `Unsupported reasoning transport "${transport}" in schema "${schemaName}" — dropping fields: ${Object.keys(fields).join(', ')}`);
  }

  return Object.keys(result).length ? result : undefined;
}

// ============================================================
// PARSE <think> TAGS
// ============================================================
const THINK_OPEN_TAG = '<think>';
function parseThinkTags(rawText) {
  if (!rawText) return { reasoning: null, content: rawText };
  // ^\s* — some models emit a leading newline before the think tag; without
  // this the tags leaked through as visible reply content.
  const match = rawText.match(/^\s*<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
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
  if (!providerUsage[k]) providerUsage[k] = { provider, model, count: 0, errors: 0, lastUsed: null, lastStatus: null, skips: 0, lastSkipReason: null, lastSkipAt: null };
  const u = providerUsage[k];
  if (ok) u.count++; else u.errors++;
  u.lastUsed = new Date().toISOString();
  u.lastStatus = ok ? 'ok' : (status || 'error');
}

// A "skip" is a hop that was passed over in favor of the next one in the
// chain — either proactively (inactive status, over its TPM budget) or
// reactively (it errored and the chain rolled to the next hop). Tracked
// separately from trackUsage's count/errors so /admin/api/usage can show
// "this hop just ran out and we fell through" without conflating it with
// genuine successful calls or hard (non-fallback) failures.
function trackSkip(provider, model, reason) {
  const k = `${provider}|${model}`;
  if (!providerUsage[k]) providerUsage[k] = { provider, model, count: 0, errors: 0, lastUsed: null, lastStatus: null, skips: 0, lastSkipReason: null, lastSkipAt: null };
  const u = providerUsage[k];
  u.skips = (u.skips || 0) + 1;
  u.lastSkipReason = reason;
  u.lastSkipAt = new Date().toISOString();
}

// ============================================================
// MODEL CHAIN (walks the fallback linked list — primary hop, then
// its `.fallback`, then that one's `.fallback`, etc.)
// ============================================================
function resolveModelChain(modelId, mapping = MODEL_MAPPING) {
  const root = mapping[modelId];
  if (!root) return null;
  const hops = [];
  let cur = root;
  let depth = 0;
  while (cur) {
    if (depth++ > 50) throw new Error('Fallback chain is suspiciously deep (50+) — check for a mistake.');
    const { fallback, ...leaf } = cur;
    hops.push(leaf);
    cur = fallback || null;
  }
  return hops;
}

// ============================================================
// RETRY CLASSIFICATION
// ── Some errors are worth hammering the SAME hop for (the service
//    is just flaky/overloaded and will likely come back within
//    seconds — this describes NVIDIA NIM constantly). Others are
//    never worth retrying on that hop no matter how many tries are
//    left, because the exact same request will fail identically
//    every time:
//      - the request itself is too big for this hop's context window
//      - this hop's quota/credits are actually exhausted (even if
//        it's *labeled* unlimited — labels can be wrong or a
//        provider can silently start capping something)
//    Those two ALWAYS skip straight to the next hop, full stop,
//    regardless of limitType. This check runs before the retry
//    loop even looks at limitType.
// ============================================================
const TOKEN_LIMIT_PATTERNS = /context.?length|context_length_exceeded|maximum context|max(?:imum)? tokens?|too many tokens|token limit|reduce the length|input is too long|prompt is too long|exceeds? the (?:model|context)|maximum number of tokens/i;
const QUOTA_EXHAUSTED_PATTERNS = /insufficient_quota|quota exceeded|exceeded your current quota|daily limit|requests per day\b|resource_exhausted|out of credits|no credits remaining|insufficient credits|billing/i;

// Bodies that say "try again later" even though the status is a 4xx. NIM
// is believed to report a degraded / cold endpoint this way, so on hops
// that retry (nvidia, "unlimited") these are treated as transient instead
// of a hard client error.
// A key problem reported with a non-401/403 status (some gateways answer 500 with
// "Invalid API key"): retrying can't fix it, so it is classified AUTH like a real 401.
const AUTH_BODY_PATTERNS = /invalid[_ -]?api[_ -]?key|incorrect api key|api[_ -]?key (is |was )?(invalid|not valid|expired|revoked|missing)|unauthori[sz]ed|authentication (failed|error)|invalid (auth|authorization)|invalid[_ -]?token/i;
// Providers don't agree on how to say "that model is gone": some use 404, some 400/422 with a
// message. Either way retrying can't help, and (unlike a malformed request) the next hop may
// work — so it is NOT_FOUND: stop retrying this hop and fall through.
const MODEL_GONE_PATTERNS = /model(?:[^.\n]|\.(?=\w)){0,100}(does not exist|doesn['’]t exist|not found|no longer (available|exists?)|has been (removed|retired|deprecated|discontinued))|unknown model|model_not_found|no such model|invalid model(?:\s+(?:id|name|identifier)\b|\s*[:'"`]|\s*$)/i;
const TRANSIENT_4XX_PATTERNS = /degraded|overloaded|temporarily|try again|capacity|service unavailable|\bbusy\b|cold.?start|warming|queue/i;
const MODERATION_PATTERNS = /content.?(?:policy|filter)|safety|moderat|flagged/i;

// Providers shape error bodies differently (OpenAI-style {error:{message}},
// {detail}, {message}, sometimes a bare string) — try the common shapes,
// fall back to the raw text so nothing provider-specific is ever silently
// dropped just because it doesn't match a known field name.
function extractProviderMessage(bodyText) {
  if (!bodyText) return '';
  // One line, capped — pretty-printed JSON used to end up verbatim in logs and
  // in the client's error popup.
  const tidy = (x) => String(x).replace(/\s+/g, ' ').trim().slice(0, 300);
  try {
    let j = JSON.parse(bodyText);
    // Google wraps its error object in an array: [{"error":{...}}]
    if (Array.isArray(j)) j = j.find(x => x && typeof x === 'object') || {};
    const first = Array.isArray(j.errors) ? j.errors[0] : null;
    const m = (typeof j.error === 'string' ? j.error : j.error?.message) || j.detail || j.message || j.msg || j.error?.detail || first?.message;
    if (m) return tidy(m);
  } catch (_) { /* not JSON — fall through to raw text below */ }
  return tidy(bodyText);
}

const TAG_HINTS = {
  CLIENT_GONE: 'the client disconnected before the model answered'
};

// One tag per failure, so a log line / client error says WHAT went wrong,
// not just "failed". Order matters (most specific first).
//   detail = the HTTP status or Node error code that produced the tag.
function classifyError(err, bodyText = '') {
  if (err?.tagInfo) return err.tagInfo; // already classified once (makeAPICall) — keep its hint/status
  if (err?.tag) return { tag: err.tag, detail: '', hint: TAG_HINTS[err.tag] || '', httpStatus: err.response?.status || 500, type: 'api_error' };
  const status = err?.response?.status;
  const code = err?.code || '';
  const msg = err?.message || '';
  const text = `${bodyText} ${msg}`;
  const providerMessage = extractProviderMessage(bodyText);
  const mk = (tag, hint, httpStatus, type = 'api_error') => ({ tag, detail: status ? `HTTP ${status}` : code, hint, httpStatus: status || httpStatus, type, providerMessage });

  if (TOKEN_LIMIT_PATTERNS.test(text))    return mk('CONTEXT_TOO_LONG', 'the request is bigger than this model\'s context window — trim the chat history or lower max tokens', 400, 'invalid_request_error');
  if (QUOTA_EXHAUSTED_PATTERNS.test(text)) return mk('QUOTA', 'the provider says the quota/credits are used up', 429, 'rate_limit_error');
  if (status !== 429 && !(status >= 200 && status < 300) && AUTH_BODY_PATTERNS.test(text)) return mk('AUTH', 'the provider rejected the API key (missing, wrong, or revoked)', 401, 'authentication_error');
  if ([400, 410, 422].includes(status) && MODEL_GONE_PATTERNS.test(text)) return mk('NOT_FOUND', 'the provider says this model does not exist (removed, renamed or never available)', 404);
  if (status === 429)                      return mk('RATE_LIMIT', 'too many requests to this provider — retry shortly', 429, 'rate_limit_error');
  if (status === 401 || status === 403)    return mk('AUTH', 'the provider rejected the API key (missing, wrong, or revoked)', status, 'authentication_error');
  if (status === 404)                      return mk('NOT_FOUND', 'the provider does not have this model (renamed, deprecated or pulled)', 404, 'invalid_request_error');
  if (status === 504 || status === 522 || status === 524) return mk('GATEWAY_TIMEOUT', 'the provider\'s gateway gave up waiting for the model', 504);
  if (status === 408 || /timeout|timed out/i.test(msg) || ['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(code)) return mk('TIMEOUT', 'no answer from the provider within the hop\'s timeout', 504);
  if (status >= 500)                       return TRANSIENT_4XX_PATTERNS.test(text) ? mk('UPSTREAM_DEGRADED', 'the provider reports the model as degraded/overloaded', 503) : mk('UPSTREAM_5XX', 'the provider had a server-side error', 502);
  if (status === 400 || status === 422 || status === 409) {
    if (TRANSIENT_4XX_PATTERNS.test(text)) return mk('UPSTREAM_DEGRADED', 'the provider reports the model as degraded/overloaded', 503);
    if (MODERATION_PATTERNS.test(text))    return mk('MODERATED', 'the provider blocked this request/response on content grounds', 400, 'invalid_request_error');
    return mk('BAD_REQUEST', 'the provider rejected the request itself (a parameter or message shape it does not accept)', 400, 'invalid_request_error');
  }
  // Our own config is wrong (bad URL / TLS certificate): no amount of retrying fixes it.
  if (['ERR_INVALID_URL', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) return mk('NET_CONFIG', 'cannot reach the provider because of a URL / TLS-certificate problem on our side', 502);
  if (['ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(code) || /socket hang up|aborted|premature close/i.test(msg)) return mk('NET_RESET', 'the connection to the provider was dropped', 502);
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return mk('NET_DNS', 'could not resolve the provider\'s hostname', 502);
  if (code === 'ECONNREFUSED')             return mk('NET_REFUSED', 'the provider refused the connection', 502);
  if (status)                              return mk(`HTTP_${status}`, '', status);
  return mk('NET_ERROR', 'network-level failure talking to the provider', 502);
}

// ── Why this isn't just `JSON.stringify(err.response?.data)` ──────────
// When a request was made with responseType:'stream' (true for every
// streaming completion), axios does NOT parse a non-2xx body either —
// err.response.data is the raw (already-gunzipped) response STREAM,
// unread. JSON.stringify-ing that stream object doesn't throw (streams
// aren't circular in a way that trips it up), so it happily serializes
// Node's internal buffer/socket state instead of the actual upstream
// error message — which is how you get a multi-KB dump instead of one
// sentence, and, worse, why isTokenLimitError/isQuotaExhaustedError were
// silently blind on every streaming request: they were pattern-matching
// against that same dump instead of real text, so those two error types
// were almost never actually detected for streamed calls. This drains
// the stream (bounded — 64KB / 3s, so a slow/huge body can't hang a
// request or blow up a log line) and caches the result on the error
// object itself, so the three call sites below (two classifiers + the
// outer catch's log line) only ever read the stream once.
async function getErrorBodyText(err) {
  if (err._qproxyBodyText !== undefined) return err._qproxyBodyText;
  const data = err.response?.data;
  let text = '';
  try {
    if (data == null) {
      text = '';
    } else if (Buffer.isBuffer(data)) {
      text = data.toString('utf8');
    } else if (typeof data === 'string') {
      text = data;
    } else if (typeof data.pipe === 'function' || typeof data.on === 'function') {
      text = await drainStreamToText(data);
    } else {
      text = JSON.stringify(data);
    }
  } catch (_) {
    text = '[unreadable error body]';
  }
  err._qproxyBodyText = text;
  return text;
}

function drainStreamToText(stream, maxBytes = 65536, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let bytes = 0;
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => settle(), timeoutMs);
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { stream.destroy(); } catch (_) { /* already closed */ }
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    stream.on('data', (chunk) => {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes >= maxBytes) settle();
    });
    stream.on('end', settle);
    stream.on('error', settle);
  });
}

// Truncated, not full — a legitimately large but real error body still
// shouldn't get logged in full; this caps the LOG LINE, separate from
// the 64KB drain cap above.
function truncateForLog(text, max = 1000) {
  if (!text) return 'unavailable';
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars truncated]` : text;
}

async function isTokenLimitError(err) { return TOKEN_LIMIT_PATTERNS.test(`${await getErrorBodyText(err)} ${err.message || ''}`); }
async function isQuotaExhaustedError(err) { return QUOTA_EXHAUSTED_PATTERNS.test(`${await getErrorBodyText(err)} ${err.message || ''}`); }

// A hop gets the "unlimited" retry treatment (many tries, since there's
// no daily/hourly cap to actually run out of — just flakiness to wait
// out) if EITHER:
//   - its own limitType is explicitly "unlimited", OR
//   - it's an nvidia hop, since NIM has no real quota by default — it's
//     just often slow/overloaded/temporarily down, not rate-limited, OR
//   - it's a literouter hop with no dailyCap set — an unset dailyCap
//     already means "Literouter itself lists this model as unlimited"
//     (see pickLiterouterKey), so the same logic applies: nothing to
//     actually run out of, just flakiness worth waiting out.
// A specific hop that genuinely IS capped in practice (despite the label)
// can opt out with `"retryAsUnlimited": false` on that hop without having
// to touch limitType/dailyCap (which also drive other display/budgeting
// logic).
function isUnlimitedRetryHop(providerConfig) {
  if (typeof providerConfig.retryAsUnlimited === 'boolean') return providerConfig.retryAsUnlimited;
  if (providerConfig.limitType === 'unlimited') return true;
  if (providerConfig.provider === 'nvidia') return true;
  if (providerConfig.provider === 'literouter' && isLiterouterPremium(providerConfig)) return false; // pooled cap, not actually unlimited
  if (providerConfig.provider === 'literouter' && providerConfig.dailyCap == null) return true;
  return false;
}

const UNLIMITED_MAX_RETRIES = 100;
// "Unlimited" hops retry on transient trouble, but some errors can't fix themselves
// by trying the SAME hop again. Those stop retrying at once; unlike a malformed
// request they still fall through to the next hop, if there is one:
//   NOT_FOUND  (404: the provider doesn't have this model)   NET_CONFIG (bad URL / TLS cert)
// Assumption: a 404 is permanent. If NIM ever answers 404 while an endpoint is warming
// up, remove NOT_FOUND from this set.
const NO_RETRY_BUT_FALL_BACK_TAGS = new Set(['NOT_FOUND', 'NET_CONFIG']);
// A DNS failure can be a blip, so it gets a few tries, not 100.
const DNS_FAIL_MAX_ATTEMPTS = 3;
// Retry window = time spent RETRYING after a hop's first failure — the first
// (possibly very slow) attempt is free, otherwise a NIM request that thinks
// for 5 minutes and then dies has already "used up" the window and gets no
// retries at all. Two sizes: a hop that has a fallback behind it only gets a
// short window (so the chain moves on), while the LAST hop in a chain has
// nothing to fall back to, so it keeps retrying much longer (up to
// UNLIMITED_MAX_RETRIES attempts). Override per hop with "retryBudgetMs".
const UNLIMITED_RETRY_BUDGET_MS = 45000;
const UNLIMITED_LAST_HOP_BUDGET_MS = 10 * 60 * 1000;
function backoffDelayMs(attemptNum) { return Math.min(250 * Math.pow(2, attemptNum - 1), 4000); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
// ── "Unlimited" hops (see isUnlimitedRetryHop) get retried on the
//    SAME hop, with backoff, up to 100 times or 45s of wall-clock
//    time — whichever comes first — before moving to the next hop.
//    Rate-limited/credits/paid hops get exactly one try, since a
//    real quota cap won't clear itself in the next few seconds.
//    Token-limit and quota-exhausted errors NEVER get retried on
//    the same hop, no matter its limitType — see isTokenLimitError
//    / isQuotaExhaustedError above.
// ── Every hop tried (used, skipped, or failed) is recorded in
//    `attempts`, returned to the caller so it can be surfaced back
//    to the client (response header) and to the admin dashboard
//    (trackUsage/trackSkip), instead of only living in server logs.
// ============================================================
async function makeAPICall(modelId, nimRequest, stream, opts = {}) {
  const log = logWith(opts.rid);
  let providers;
  try {
    providers = resolveModelChain(modelId);
  } catch (e) {
    const err = new Error(`Could not resolve model "${modelId}": ${e.message}`);
    err.response = { status: 400 };
    throw err;
  }
  if (!providers || !providers.length) {
    const err = new Error(`Model "${modelId}" has no configured hops.`);
    err.response = { status: 404 };
    throw err;
  }

  const attempts = [];
  let lastError;
  for (let hopIdx = 0; hopIdx < providers.length; hopIdx++) {
    const providerConfig = providers[hopIdx];
    const isLastHop = hopIdx === providers.length - 1;
    if (providerConfig.status && providerConfig.status !== 'active') {
      if (providers.length > 1) log('WARN', `Skipping ${hopLabel(providerConfig)} — status is "${providerConfig.status}", not "active"`);
      attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'skipped', reason: `status:${providerConfig.status}`, note: `is marked "${providerConfig.status}" in models.json` });
      trackSkip(providerConfig.provider, providerConfig.model, `status:${providerConfig.status}`);
      continue;
    }
    // Tool/function-calling request but this hop is marked "tools": false
    // in models.json (tiny models, roleplay finetunes, endpoints that ignore
    // tools) — skip it so the chain moves on instead of the agent getting a
    // plain-text answer where it expected a tool call.
    if (Array.isArray(nimRequest.tools) && nimRequest.tools.length && providerConfig.tools === false) {
      attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'skipped', reason: 'no-tool-support', note: 'is marked "tools": false and this request uses tools' });
      trackSkip(providerConfig.provider, providerConfig.model, 'no-tool-support');
      continue;
    }
    if (providerConfig.tpmLimit) {
      const inputTokens = estimateInputTokens(nimRequest);
      const estimated = estimateRequestTokens(nimRequest, providerConfig.provider);
      if (estimated > providerConfig.tpmLimit) {
        const note = estimated === inputTokens
          ? `request ≈ ${fmtN(inputTokens)} input tokens is over the max request size of ${fmtN(providerConfig.tpmLimit)} set for this model`
          : `request ≈ ${fmtN(estimated)} tokens (prompt ${fmtN(inputTokens)} + max_tokens ${fmtN(estimated - inputTokens)}) is over the max request size of ${fmtN(providerConfig.tpmLimit)} set for this model`;
        if (providers.length > 1) log('WARN', `Skipping ${hopLabel(providerConfig)} — ${note}`);
        attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'skipped', reason: `tpm-budget:${estimated}>${providerConfig.tpmLimit}`, note });
        trackSkip(providerConfig.provider, providerConfig.model, `tpm-budget (~${estimated}>${providerConfig.tpmLimit})`);
        continue;
      }
    }
    // Literouter's free tier has a fixed context (5,000 tokens). A longer prompt is NOT rejected: Literouter
    // summarizes it to fit, so the model answers from a condensed history. Say so in the log (once per hop).
    const freeCtxCap = literouterFreeContextCap(providerConfig);
    if (freeCtxCap) {
      const promptTokens = estimateInputTokens(nimRequest);
      if (promptTokens > freeCtxCap) log('WARN', `[context] ${hopLabel(providerConfig)} — prompt ≈ ${fmtN(promptTokens)} tokens is over Literouter's free ${fmtN(freeCtxCap)}-token context, so Literouter will summarize it and the model sees a condensed history, not the full chat (set "tpmLimit" on this hop to skip it for long chats instead)`);
    }

    const extraBody = getReasoningBody(providerConfig);
    const body = { ...nimRequest, model: providerConfig.model, ...(extraBody || {}) };
    // "maxTokens" on a hop is a FLOOR, not just a default: reasoning models
    // spend max_tokens on thinking AND the reply from one pool, so a client
    // asking for a normal reply length (e.g. 4096) starves the reply. The
    // client's number is only honored when it is already >= the floor.
    if (typeof providerConfig.maxTokens === 'number' && (body.max_tokens || 0) < providerConfig.maxTokens) {
      log('INFO', `max_tokens raised ${body.max_tokens || 'unset'} → ${providerConfig.maxTokens} for ${providerConfig.provider}/${providerConfig.model} (hop floor)`);
      body.max_tokens = providerConfig.maxTokens;
    }
    const sentMaxTokens = body.max_tokens;
    const unlimited = isUnlimitedRetryHop(providerConfig);
    const maxAttempts = unlimited ? (providerConfig.maxRetries || UNLIMITED_MAX_RETRIES) : 1;
    const hopStartedAt = Date.now();
    let retryClockStart = null; // set at the hop's FIRST failure
    let hopFinalError = null;
    let skippedThisHop = false;

    for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
      // Re-checked every attempt, not just on failure — the client can hang
      // up while we're sleeping in backoff between retries, and without this
      // the next attempt fires a full upstream call nobody is waiting for.
      if (opts.clientGone && opts.clientGone()) {
        attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'failed', reason: 'CLIENT_GONE' });
        const gone = new Error('Client disconnected before the model answered — stopped retrying');
        gone.tag = 'CLIENT_GONE';
        gone.response = { status: 499 };
        gone.attempts = attempts;
        throw gone;
      }
      // Re-picked every attempt, not just once before the loop — so a
      // retried literouter hop rotates to a different key on failure
      // instead of hammering the one key that just failed for the whole
      // retry budget. Cheap to redo each time (no network call).
      let pickedLiterouterKey = null;
      if (providerConfig.provider === 'literouter') {
        pickedLiterouterKey = pickLiterouterKey(providerConfig.model, providerConfig.dailyCap, isLiterouterPremium(providerConfig));
        if (!pickedLiterouterKey) {
          const premium = isLiterouterPremium(providerConfig);
          const reason = premium ? 'literouter-premium-pool-exhausted' : 'literouter-daily-cap-exhausted';
          log('WARN', premium
            ? `Skipping literouter/${providerConfig.model} — every Literouter key's shared ${LITEROUTER_PREMIUM_DAILY_CAP}/day premium pool is exhausted`
            : `Skipping literouter/${providerConfig.model} — every Literouter key is out of daily quota for this model`);
          attempts.push({ provider: 'literouter', model: providerConfig.model, outcome: 'skipped', reason });
          trackSkip('literouter', providerConfig.model, reason);
          skippedThisHop = true;
          break;
        }
      }
      // Same idea as Literouter above: re-picked every attempt so a
      // retry rotates to a different Google key instead of hammering the
      // one that just hit its rpm/tpm/rpd ceiling. Only actually checks
      // anything if the hop has rpm/tpm/rpd configured at all — a plain
      // Google hop with none of those set behaves exactly as before.
      let pickedGoogleKey = null;
      if (providerConfig.provider === 'google') {
        const estimatedTokens = estimateRequestTokens(nimRequest, 'google');
        const googleWhy = [];
        pickedGoogleKey = pickGoogleKey(providerConfig.model, providerConfig, estimatedTokens, googleWhy);
        if (!pickedGoogleKey) {
          // Say WHICH limit blocked it (rpm / tpm / rpd), with the numbers, and —
          // when waiting would actually help — how long.
          const notes = [...new Set(googleWhy.map(w => w.note))];
          const retryAfterS = googleWhy.map(w => w.retryAfterS).filter(Number.isFinite).reduce((a, b) => Math.min(a, b), Infinity);
          const keysNote = GOOGLE_KEYS.length > 1 ? ` (all ${GOOGLE_KEYS.length} keys)` : '';
          const note = `${notes.join(' / ') || 'out of rpm/tpm/rpd room'}${keysNote}${Number.isFinite(retryAfterS) ? ` — try again in ~${retryAfterS}s` : ''}`;
          const codes = [...new Set(googleWhy.map(w => w.reason))].join(';');
          if (providers.length > 1) log('WARN', `Skipping ${hopLabel(providerConfig)} — ${note}`);
          attempts.push({ provider: 'google', model: providerConfig.model, outcome: 'skipped', reason: 'google-limit:' + codes, note, ...(Number.isFinite(retryAfterS) ? { retryAfterS } : {}) });
          trackSkip('google', providerConfig.model, 'google-limit:' + codes);
          skippedThisHop = true;
          break;
        }
      }
      const { base, key } = pickedLiterouterKey
        ? { base: 'https://api.literouter.com/v1', key: pickedLiterouterKey.key }
        : pickedGoogleKey
          ? { base: GOOGLE_RELAY_BASE, key: pickedGoogleKey.key }
          : getProviderConfig(providerConfig.provider);

      if (opts.onHop) opts.onHop(providerConfig);
      const attemptStartedAt = Date.now();
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
            timeout: providerConfig.timeoutMs || 300000,
            // Aborted when the client hangs up, so a request still waiting in
            // the provider's queue is cancelled instead of running to the end
            // for nobody.
            ...(opts.signal ? { signal: opts.signal } : {})
          }
        );
        trackUsage(providerConfig.provider, providerConfig.model, true);
        clearRequestWarning(providerConfig);   // it answered: whatever the provider said before is out of date
        attempts.push({
          provider: providerConfig.provider, model: providerConfig.model, outcome: 'used',
          ...(attemptNum > 1 ? { retries: attemptNum - 1 } : {})
        });
        return { response, usedProvider: providerConfig.provider, usedModel: providerConfig.model, sentMaxTokens, attempts };

      } catch (err) {
        const status = err.response?.status;
        trackUsage(providerConfig.provider, providerConfig.model, false, status);
        hopFinalError = err;
        const bodyText = await getErrorBodyText(err);
        const cls = classifyError(err, bodyText);
        err.tag = err.tag || cls.tag;
        err.tagInfo = cls;
        const reasonStr = cls.detail ? `${cls.tag} · ${cls.detail}` : cls.tag;
        const reasonWithMsg = cls.providerMessage ? `${reasonStr} — "${cls.providerMessage}"` : reasonStr;
        const who = hopLabel(providerConfig);
        // Google says exactly which quota it hit and its value; if that differs from
        // what we have saved, fix it and flag the whole table as possibly outdated.
        if (providerConfig.provider === 'google' && status === 429) learnGoogleLimitsFrom429(providerConfig, bodyText);

        // The client already left (closed the tab / hit stop / its own
        // timeout fired) — retrying would just burn provider calls nobody
        // is waiting for.
        if (opts.clientGone && opts.clientGone()) {
          log('WARN', `[CLIENT_GONE] ${who} failed [${reasonStr}] but the client already disconnected — not retrying`);
          attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'failed', reason: 'CLIENT_GONE' });
          const gone = new Error('Client disconnected before the model answered — stopped retrying');
          gone.tag = 'CLIENT_GONE';
          gone.response = { status: 499 };
          gone.attempts = attempts;
          throw gone;
        }

        // Token-limit and quota-exhausted errors are NEVER worth retrying
        // on THIS hop — but a DIFFERENT hop might still handle it fine
        // (bigger context window, or actual quota left), so these fall
        // through to the next hop even when the status is a 4xx.
        if (cls.tag === 'CONTEXT_TOO_LONG') {
          if (!isLastHop) log('WARN', `[CONTEXT_TOO_LONG] ${who} — request exceeds this hop's context window, not retrying it: ${err.message}`);
          attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'failed', reason: 'CONTEXT_TOO_LONG' });
          trackSkip(providerConfig.provider, providerConfig.model, 'CONTEXT_TOO_LONG');
          break;
        }
        if (cls.tag === 'QUOTA') {
          if (!isLastHop) log('WARN', `[QUOTA] ${who} — quota/credits actually exhausted (even though limitType is "${providerConfig.limitType}"), not retrying: ${err.message}`);
          attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'failed', reason: 'QUOTA' });
          trackSkip(providerConfig.provider, providerConfig.model, 'QUOTA');
          break;
        }

        if (NO_RETRY_BUT_FALL_BACK_TAGS.has(cls.tag)) {
          if (cls.tag === 'NOT_FOUND') noteHopGone(providerConfig, extractProviderMessage(bodyText) || `HTTP ${status}`);
          if (!isLastHop) log('WARN', `[${cls.tag}] ${who} — ${reasonWithMsg}; retrying this hop can't help, moving on`);
          attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'failed', reason: reasonStr });
          trackSkip(providerConfig.provider, providerConfig.model, cls.tag);
          break;
        }

        // Genuine hard client errors (malformed request, bad key, ...) —
        // never retry, never fall back: the same broken request would just
        // fail on the next hop too. Exception: a 4xx whose body says the
        // endpoint is degraded/busy, on a hop that retries anyway.
        const hardClientError = cls.tag === 'AUTH'
          || (status && status >= 400 && status < 500 && status !== 429 && status !== 408 && status !== 404
            && !(unlimited && cls.tag === 'UPSTREAM_DEGRADED'));
        if (hardClientError) {
          // Only worth a line when there WAS a fallback that is being skipped;
          // otherwise the request-level ERROR line already says everything.
          if (providers.length > 1) log('WARN', `[${cls.tag}] ${who} returned ${status} (client error) — not falling back`);
          attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'failed', reason: reasonStr });
          err.attempts = attempts;
          err.chainLength = providers.length;
          throw err;
        }

        if (retryClockStart === null) retryClockStart = Date.now();
        const retryElapsed = Date.now() - retryClockStart;
        const budgetMs = providerConfig.retryBudgetMs || (isLastHop ? UNLIMITED_LAST_HOP_BUDGET_MS : UNLIMITED_RETRY_BUDGET_MS);
        const budgetLeft = retryElapsed < budgetMs;
        const attemptsLeft = attemptNum < maxAttempts && !(cls.tag === 'NET_DNS' && attemptNum >= DNS_FAIL_MAX_ATTEMPTS);

        if (unlimited && budgetLeft && attemptsLeft) {
          const delay = backoffDelayMs(attemptNum);
          log('WARN', `[${cls.tag}] ${who} attempt ${attemptNum}/${maxAttempts} failed (${reasonWithMsg}) — retrying in ${delay}ms (retry window ${retryElapsed}/${budgetMs}ms${isLastHop && providers.length > 1 ? ', last hop: nothing to fall back to' : ''})...`);
          await sleep(delay);
          continue;
        }

        const elapsed = Date.now() - hopStartedAt;
        // Two different clocks end up in this message, which read as a contradiction
        // ("over 15m 7s" vs "10m window"): the total runs from the hop's start, the
        // window from its FIRST failure, and the window is only checked between attempts —
        // an attempt already running is never cut short. Say so when the last attempt was long.
        const lastAttemptMs = Date.now() - attemptStartedAt;
        const tidy = (ms) => ms < 1000 ? `${ms}ms` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000) ? ` ${Math.round((ms % 60000) / 1000)}s` : ''}`;
        const whyStopped = !unlimited ? '' : (!attemptsLeft ? ' — attempt cap reached'
          : ` — the ${tidy(budgetMs)} retry window (counted from the first failure) ran out`
            + (lastAttemptMs >= budgetMs / 10 ? `; attempt ${attemptNum} began inside it and was allowed to finish, taking ${tidy(lastAttemptMs)}` : ''));
        const plainTried = attemptNum > 1 ? `after ${attemptNum} attempts over ${shortDuration(elapsed)}${whyStopped}` : '';
        const triedNote = plainTried ? ` ${plainTried}` : '';
        err.tryNote = plainTried;
        // A failure on the LAST hop is reported once, by the request-level ERROR
        // line (which carries this note). A line here too was the same event twice.
        if (!isLastHop) log('WARN', `[${cls.tag}] ${who} failed (${reasonWithMsg})${triedNote} — trying fallback...`);
        attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'failed', reason: `${reasonStr}${triedNote}` });
        trackSkip(providerConfig.provider, providerConfig.model, reasonStr);
        break;
      }
    }
    lastError = hopFinalError;
  }
  if (!lastError) {
    // Every hop was skipped. Say which, and why, with the real numbers.
    const why = (a) => `${hopLabel(a)}: ${a.note || a.reason}`;
    const msg = providers.length === 1
      ? `${hopLabel(providers[0])} was skipped — ${attempts[0]?.note || attempts[0]?.reason || 'it could not be used'}`
      : `No hop could be used — ${attempts.map(why).join('; ')}`;
    lastError = new Error(msg);
    lastError.response = { status: 503 };
    lastError.tag = 'NO_HOP';
    // Waiting helps only if some skipped hop said it would.
    const waits = attempts.map(a => a.retryAfterS).filter(Number.isFinite);
    if (waits.length) lastError.retryAfterS = Math.min(...waits);
  }
  lastError.attempts = attempts;
  lastError.chainLength = providers.length;
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
  const today = new Date().toISOString().slice(0, 10);
  const orStatus = OPENROUTER_KEYS.map((_, i) => ({
    key: OPENROUTER_KEY_ENTRIES[i].envName,
    usedToday: openrouterKeyState[i].day === today ? openrouterKeyState[i].count : 0,
    cap: OPENROUTER_DAILY_CAP
  }));
  res.json({
    status: 'ok',
    mode: MODE,
    users: status,
    provider_quotas: Object.keys(PROVIDER_QUOTAS).map(getProviderQuotaSnapshot),
    openrouter_keys: orStatus,
    literouter_keys: LITEROUTER_KEYS.length,
    // Per-(key, model) breakdown, only for Literouter models that actually
    // have a dailyCap configured — e.g. "12/30 (LITEROUTER_KEY_1), 0/30
    // (LITEROUTER_KEY_2)" for claude-haiku-4.5-cheap. Uncapped ("∞") models
    // aren't tracked per-key and won't appear here.
    literouter_capped_models: literouterCapSnapshot(),
    literouter_premium_pool: literouterPremiumSnapshot(),
    google_usage: googleUsageSnapshot(),
    provider_resets: providerResetInfo()
  });
});

// ============================================================
// BUDGET CHECK ENDPOINT
// ============================================================
app.get('/budget', (req, res) => {
  res.json({
    providerQuotas: Object.keys(PROVIDER_QUOTAS).map(getProviderQuotaSnapshot),
    note: 'No provider balance is invented. Providers with no configured quota are intentionally omitted from this list.'
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
  const rid = newRequestId();
  const log = logWith(rid);   // every line this request writes carries #rid
  let waitTimer = null;
  const clearWait = () => { if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; } };
  const authHeader = req.headers['authorization'] || '';
  const userKey = authHeader.replace('Bearer ', '').trim();
  const keyMap = buildKeyMap();
  const userName = keyMap[userKey]?.name || 'unknown';

  const rateCheck = checkRateLimit(userKey);
  if (!rateCheck.allowed) {
    // An unknown key is an auth problem (401), not a rate limit — a 429 here
    // made clients back off and retry a key that would never work.
    if (rateCheck.invalidKey) {
      log('WARN', `[${userName}] Rejected — invalid API key`);
      return res.status(401).json({
        error: { message: 'Invalid API key.', type: 'invalid_request_error', code: 401 }
      });
    }
    log('WARN', `[${userName}] Rate limit hit`);
    return res.status(429).json({
      error: { message: rateCheck.reason, type: 'rate_limit_error', code: 429 }
    });
  }

  try {
    const { model, messages, temperature, max_tokens, stream,
            tools, tool_choice, parallel_tool_calls, response_format, stop } = req.body;

    // Shape-check before touching the body — a missing messages array used to
    // fall through to messages.forEach and die as a 500 TypeError.
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({
        error: { message: 'Request body must include a non-empty "messages" array.', type: 'invalid_request_error', code: 400 }
      });
    }
    if (typeof model !== 'string' || !model.trim()) {
      return res.status(400).json({
        error: { message: 'Request body must include a "model" string. GET /v1/models for the full list.', type: 'invalid_request_error', code: 400 }
      });
    }

    const toolNote = Array.isArray(tools) && tools.length ? ` | tools: ${tools.length}` : '';
    log('INFO', `[${userName}] REQUEST → model: ${model} | stream: ${stream || false} | ${messages.length} msgs${toolNote}`);
    // Per-message previews go to Render's console only — an agent loop
    // can send dozens of (huge) messages per request and would bury the
    // Admin log.
    messages.forEach((m, i) => {
      const extra = Array.isArray(m.tool_calls) && m.tool_calls.length ? ` [+${m.tool_calls.length} tool_calls]` : '';
      log('DEBUG', `  [msg ${i}] ${m.role}: ${messageText(m).slice(0, 300)}${extra}`, 'console');
    });
    // The same previews as ONE Admin entry (not one line per message), so the
    // Admin log shows what was actually sent. Capped so an agent loop with
    // dozens of huge messages can't bury everything else.
    {
      const PROMPT_LOG_MAX_MSGS = 100;
      const lines = messages.slice(0, PROMPT_LOG_MAX_MSGS).map((m, i) => {
        const extra = Array.isArray(m.tool_calls) && m.tool_calls.length ? ` [+${m.tool_calls.length} tool_calls]` : '';
        return `[msg ${i}] ${m.role}: ${messageText(m).slice(0, 300).replace(/\s*\n\s*/g, ' ⏎ ')}${extra}`;
      });
      if (messages.length > PROMPT_LOG_MAX_MSGS) lines.push(`… +${messages.length - PROMPT_LOG_MAX_MSGS} more messages`);
      log('PROMPT', `[${userName}] prompt — ${messages.length} msgs ≈ ${estimateTokens(messages)} tokens\n${lines.join('\n')}`, 'admin');
    }

    const mapping = MODEL_MAPPING[model];
    if (!mapping) {
      return res.status(404).json({
        error: { message: `Model "${model}" not found. GET /v1/models for full list.`, type: 'invalid_request_error', code: 404 }
      });
    }

    // Clients like Janitor/Marinara send max_tokens: 0 to mean "let the
    // model choose the length" — but 0 is falsy in JS, so `max_tokens || X`
    // would silently treat that as "not specified" and fall back anyway,
    // which is actually fine EXCEPT the fallback used to be a flat 9024
    // for every model regardless of how much a specific model's reasoning
    // tends to need. Distinguish "client asked for a real positive number
    // on purpose" (respect it) from "client said 0 / sent nothing" (use
    // this hop's own configured floor, falling back to 9024 generically).
    const clientRequestedTokens = (typeof max_tokens === 'number' && max_tokens > 0) ? max_tokens : null;
    const hopDefaultTokens = (mapping && typeof mapping.maxTokens === 'number') ? mapping.maxTokens : 9024;

    const nimRequest = {
      model: mapping.model,
      messages,
      // typeof check, not `||`: a coding agent sending temperature: 0 must
      // get 0, not the 0.6 fallback (0 is falsy in JS).
      temperature: typeof temperature === 'number' ? temperature : 0.6,
      max_tokens: clientRequestedTokens || hopDefaultTokens,
      stream: stream || false
    };
    // Tool calling / structured output / stop sequences: passed through
    // only when the client actually sent them, so existing roleplay
    // traffic (which sends none of these) is byte-for-byte unchanged.
    if (Array.isArray(tools) && tools.length) nimRequest.tools = tools;
    if (tool_choice !== undefined && nimRequest.tools) nimRequest.tool_choice = tool_choice;
    if (parallel_tool_calls !== undefined && nimRequest.tools) nimRequest.parallel_tool_calls = parallel_tool_calls;
    if (response_format) nimRequest.response_format = response_format;
    if (stop) nimRequest.stop = stop;

    let clientGone = false;
    const abortCtl = new AbortController();
    const reqStartedAt = Date.now();
    res.on('close', () => {
      clearWait();
      if (!res.writableEnded && !clientGone) {
        clientGone = true;
        // Also cancels a call that is still waiting for the provider to answer
        // (a queued NIM request), not just one that is already streaming.
        abortCtl.abort();
        log('INFO', `[${userName}] client disconnected after ${shortDuration(Date.now() - reqStartedAt)} — cancelling the upstream request`);
      }
    });

    // "Waiting…" notices: from the moment the request starts until the model
    // produces its FIRST output (thinking counts as output — this is only the
    // queue / connect wait before anything comes back). Silent for models that
    // answer quickly: the first notice only appears once 10s have gone by, then
    // again at 30s, 60s and every minute after.
    let firstOutputAt = null;
    let currentHop = model;
    const WAIT_FIRST_MS = Number(process.env.QP_WAIT_NOTICE_MS) || 10000;  // env only so tests needn't wait 10s
    const waitAt = (n) => n === 0 ? WAIT_FIRST_MS : n === 1 ? WAIT_FIRST_MS * 3 : WAIT_FIRST_MS * 6 + (n - 2) * 60000;
    let waitN = 0;
    const scheduleWait = () => {
      waitTimer = setTimeout(() => {
        waitTimer = null;
        if (firstOutputAt || clientGone) return;
        log('INFO', `[${userName}] ⏳ still waiting for ${currentHop} to start answering — ${shortDuration(Date.now() - reqStartedAt)} and no output yet (queue/connect time, not thinking)`);
        waitN++; scheduleWait();
      }, Math.max(0, waitAt(waitN) - (Date.now() - reqStartedAt)));
    };
    scheduleWait();
    const markFirstOutput = () => {
      if (firstOutputAt) return;
      firstOutputAt = Date.now();
      clearWait();
      if (firstOutputAt - reqStartedAt >= WAIT_FIRST_MS) log('INFO', `[${userName}] ✓ first output arrived after ${shortDuration(firstOutputAt - reqStartedAt)}`);
    };

    const { response, usedProvider, usedModel, sentMaxTokens, attempts } = await makeAPICall(model, nimRequest, stream || false, {
      clientGone: () => clientGone, signal: abortCtl.signal, rid,
      onHop: (pc) => { currentHop = hopLabel(pc); }
    });
    // The client left while we were waiting and the answer arrived anyway
    // (raced the cancel): drop it instead of streaming to nobody.
    if (clientGone) {
      try { response.data && typeof response.data.destroy === 'function' && response.data.destroy(); } catch (_) { /* already gone */ }
      return;
    }
    if (!stream) markFirstOutput();
    const usedAttempt = (attempts || []).find(a => a.outcome === 'used');
    log('INFO', `[${userName}] → provider: ${usedProvider} | model: ${usedModel} | max_tokens: client sent ${max_tokens === undefined ? 'nothing' : max_tokens} → upstream got ${sentMaxTokens}${usedAttempt && usedAttempt.retries ? ` | after ${usedAttempt.retries} retr${usedAttempt.retries === 1 ? 'y' : 'ies'}` : ''}`);

    // Surface the fallback path back to the client, not just server logs —
    // every hop that was tried, in order, with what happened to it.
    // X-QProxy-Used is always present; X-QProxy-Fallback-Path only appears
    // when at least one earlier hop was skipped or failed first.
    res.setHeader('X-QProxy-Used', `${usedProvider}/${usedModel}`);
    const priorHops = (attempts || []).filter(a => a.outcome !== 'used');
    if (priorHops.length) {
      const pathStr = (attempts || [])
        .map(a => `${a.provider}/${a.model}:${a.outcome}${a.reason ? `(${a.reason})` : ''}`)
        .join(' -> ');
      res.setHeader('X-QProxy-Fallback-Path', pathStr);
      log('INFO', `[${userName}] fallback path: ${pathStr}`);
    }

    if (!stream) {
      const tokens = response.data?.usage?.total_tokens || 0;
      recordProviderTokens(usedProvider, tokens);
      if (tokens) log('INFO', `[provider quota] ${usedProvider} used ${tokens} tokens`);
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let thinkBuffer = '';
      let inThink = false;
      let thinkSent = false;
      // Undecided-phase text: held while a '<think>' opener could still be
      // forming (leading whitespace + a prefix of the tag). Writing this
      // straight through used to leak the first fragment of a split tag
      // (e.g. "<thi") to the client as visible reply text.
      let pending = '';
      const streamStartedAt = Date.now();
      let chunkCount = 0;
      let contentChars = 0;      // every content delta seen (incl. text later re-labelled as reasoning)
      let contentDelivered = 0;  // content actually written to the client as reply text
      let sawToolCalls = false;
      let noticeSent = false;
      let reasoningChars = 0;
      let parseErrorCount = 0;
      let lastParseError = null;

      // Per-chunk lines go to Render's console ONLY (never the Admin panel),
      // so Render keeps the full clutter you can dig back through while the
      // Admin log shows the stitched, readable text instead. Set
      // DEBUG_STREAM_CHUNKS=false to silence them.
      const DEBUG_STREAM_CHUNKS = process.env.DEBUG_STREAM_CHUNKS !== 'false';

      // Shown as the reply when the upstream connection dies before the
      // model wrote ANY reply text (i.e. it died mid-thinking), so the
      // client gets a visible message instead of an empty/"no response"
      // turn. Set STREAM_TRUNCATION_NOTICE to an empty string to disable.
      const TRUNCATION_NOTICE = process.env.STREAM_TRUNCATION_NOTICE !== undefined
        ? process.env.STREAM_TRUNCATION_NOTICE
        : '*[Connection to the model closed before it finished replying — regenerate to retry.]*';

      // How the upstream stream ended, tracked so a stream that dies
      // mid-thought can still be closed out properly for the client.
      let sawDone = false;
      let upstreamFinishReason = null;
      let finishForwarded = false;
      let lastMeta = null;
      let finalized = false;

      // Admin-panel-only stitched text (see openLiveLog).
      let reasoningLog = null;
      let contentLog = null;
      let thinkLogged = 0;
      const logReasoning = (t) => {
        if (!t) return;
        if (!reasoningLog) reasoningLog = openLiveLog('THINK', `[${userName}] reasoning`, rid);
        reasoningLog.append(t);
      };
      const logContent = (t) => {
        if (!t) return;
        if (!contentLog) contentLog = openLiveLog('REPLY', `[${userName}] reply`, rid);
        contentLog.append(t);
      };
      // Think-tag models: mirror the buffered thinking text into the Admin
      // log as it arrives, holding back the last few chars in case a
      // "</think>" tag is split across two chunks.
      const flushThinkLog = (final) => {
        const closeIdx = thinkBuffer.indexOf('</think>');
        const upto = closeIdx !== -1
          ? closeIdx
          : (final ? thinkBuffer.length : Math.max(thinkLogged, thinkBuffer.length - 8));
        if (upto > thinkLogged) {
          logReasoning(thinkBuffer.slice(thinkLogged, upto));
          thinkLogged = upto;
        }
      };

      const LENGTH_NOTICE = process.env.STREAM_LENGTH_NOTICE !== undefined
        ? process.env.STREAM_LENGTH_NOTICE
        : '*[The model used its entire token budget on thinking and never wrote a reply — regenerate, or raise the max tokens.]*';
      const writeChunk = (obj) => {
        const fr = obj?.choices?.[0]?.finish_reason;
        // Upstream ended with finish_reason "length" and not one character
        // of reply: to the client that is an empty message ("no response").
        // Give it something visible, ahead of the finish chunk.
        if (fr === 'length' && LENGTH_NOTICE && !noticeSent && contentDelivered === 0 && !sawToolCalls) {
          noticeSent = true;
          res.write(`data: ${JSON.stringify({ ...chunkMeta(), choices: [{ index: 0, delta: { role: 'assistant', content: LENGTH_NOTICE }, finish_reason: null }] })}\n\n`);
        }
        if (fr) finishForwarded = true;
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      const chunkMeta = () => ({
        id: lastMeta?.id || `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: lastMeta?.created || Math.floor(Date.now() / 1000),
        model: lastMeta?.model || usedModel
      });

      // Close the stream out properly: flush any think-tag text that was
      // still buffered (it would otherwise be lost), make sure the client
      // sees a finish_reason, then a real [DONE]. Without this, a stream
      // that dies mid-thought just goes quiet and the client treats it
      // as a dead connection and throws away what it had.
      const emitTail = (defaultReason, allowNotice) => {
        // Flush text still held in the undecided phase (a possible partial
        // '<think>' opener that turned out to be plain content) so a stream
        // cut at just the wrong moment doesn't swallow it.
        if (!inThink && !thinkSent && pending) {
          const text = pending;
          pending = '';
          contentDelivered += text.length;
          logContent(text);
          writeChunk({ ...chunkMeta(), choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
        }
        if (inThink && thinkBuffer.trim()) {
          flushThinkLog(true);
          const text = thinkBuffer.replace('</think>', '').trim();
          reasoningChars += text.length;
          writeChunk({ ...chunkMeta(), choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning_content: text }, finish_reason: null }] });
        }
        inThink = false;
        thinkBuffer = '';
        if (allowNotice && TRUNCATION_NOTICE && contentDelivered === 0 && !sawToolCalls && !noticeSent) {
          noticeSent = true;
          writeChunk({ ...chunkMeta(), choices: [{ index: 0, delta: { role: 'assistant', content: TRUNCATION_NOTICE }, finish_reason: null }] });
        }
        if (!finishForwarded) {
          writeChunk({ ...chunkMeta(), choices: [{ index: 0, delta: {}, finish_reason: upstreamFinishReason || defaultReason }] });
        }
        if (!sawDone) {
          res.write('data: [DONE]\n\n');
          sawDone = true;
        }
      };

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(line => {
          if (!line.startsWith('data: ')) return;
          markFirstOutput();
          if (line.includes('[DONE]')) { emitTail('stop', false); return; }

          try {
            const data = JSON.parse(line.slice(6));
            lastMeta = { id: data.id, created: data.created, model: data.model };
            const fr = data.choices?.[0]?.finish_reason;
            if (fr) upstreamFinishReason = fr;

            const delta = data.choices?.[0]?.delta;
            if (!delta) { writeChunk(data); return; }
            if (delta.tool_calls) sawToolCalls = true;

            // reasoning_content is the NIM/Z.AI convention; OpenRouter's
            // documented field is "reasoning" (a string when present). Only a
            // string counts — OpenRouter can also send object-shaped
            // reasoning_details, which are not text and must not be injected.
            const nativeReasoning = delta.reasoning_content
              || (typeof delta.reasoning === 'string' ? delta.reasoning : null);
            const rawContent = delta.content || '';
            chunkCount++;
            contentChars += rawContent.length;
            if (nativeReasoning) reasoningChars += nativeReasoning.length;

            if (DEBUG_STREAM_CHUNKS) {
              log('DEBUG', `[CHUNK] native_reasoning: ${JSON.stringify(nativeReasoning?.slice(0, 80))} | content: ${JSON.stringify(rawContent?.slice(0, 80))}`, 'console');
            }

            if (nativeReasoning) {
              logReasoning(nativeReasoning);
              if (rawContent) { logContent(rawContent); contentDelivered += rawContent.length; }
              // Re-label OpenRouter's "reasoning" string to reasoning_content,
              // so both wire conventions reach the client in the same shape
              // (reasoning_content passthrough needs no rewrite).
              if (!delta.reasoning_content && typeof delta.reasoning === 'string') {
                delta.reasoning_content = nativeReasoning;
                delete delta.reasoning;
              }
              writeChunk(data);
              return;
            }

            // Think-tag detection only runs while a <think> opener is still
            // possible — before any plain reply text has been positively
            // identified. Once decided, `pending` is no longer touched.
            let plainText = rawContent;
            // Chunks with no text (tool_calls, role-only, finish_reason) can't
            // be part of a think opener — pass them straight through.
            if (!inThink && !rawContent) { writeChunk(data); return; }
            if (!inThink && !thinkSent) {
              pending += rawContent;
              const openIdx = pending.indexOf(THINK_OPEN_TAG);
              if (openIdx !== -1) {
                inThink = true;
                const start = openIdx + THINK_OPEN_TAG.length;
                thinkBuffer += pending.slice(start);
                pending = '';
                flushThinkLog(false);
                return;
              }
              // Hold back only what could still become the opener: an
              // optional run of leading whitespace followed by a prefix of
              // '<think>'. Anything else proves this is a plain reply, and
              // everything held so far is delivered as content. (Bounded:
              // at most whitespace + 7 chars are ever withheld.)
              let ws = 0;
              while (ws < pending.length && /\s/.test(pending[ws])) ws++;
              if (THINK_OPEN_TAG.startsWith(pending.slice(ws))) return;
              thinkSent = true;
              plainText = pending;
              pending = '';
            }

            if (inThink) {
              thinkBuffer += rawContent;
              flushThinkLog(false);
              if (thinkBuffer.includes('</think>')) {
                const end = thinkBuffer.indexOf('</think>');
                const reasoningText = thinkBuffer.slice(0, end).trim();
                const afterThink = thinkBuffer.slice(end + 8).trim();
                inThink = false;
                thinkSent = true;
                reasoningChars += reasoningText.length;

                const reasoningChunk = {
                  ...data,
                  choices: [{
                    ...data.choices[0],
                    delta: { role: 'assistant', content: '', reasoning_content: reasoningText }
                  }]
                };
                writeChunk(reasoningChunk);

                if (afterThink) {
                  delta.content = afterThink;
                  delete delta.reasoning_content;
                  logContent(afterThink);
                  contentDelivered += afterThink.length;
                  writeChunk(data);
                }
              }
              return;
            }

            delta.content = plainText;
            delete delta.reasoning_content;
            if (plainText) { logContent(plainText); contentDelivered += plainText.length; }
            writeChunk(data);

          } catch (e) {
            // A single malformed/split chunk boundary is counted and
            // reported once in the summary line, with just the last
            // error's message kept as a sample. The raw line is passed
            // through with a proper SSE terminator — a lone \n would glue
            // it to the next event's data line and corrupt the stream.
            parseErrorCount++;
            lastParseError = e.message;
            res.write(line + '\n\n');
          }
        });
      });

      const finalizeStream = (how, err) => {
        if (finalized) return;
        finalized = true;
        const ms = Date.now() - streamStartedAt;
        const endedPrematurely = !sawDone;
        const truncated = endedPrematurely && !upstreamFinishReason;

        if (endedPrematurely) emitTail('length', truncated);

        const note = truncated ? ' — CUT OFF: upstream closed before the model finished' : '';
        if (reasoningLog) reasoningLog.close(`${reasoningChars} chars ≈ ${Math.round(reasoningChars / 4)} tokens${note}`);
        if (contentLog) contentLog.close(`${contentDelivered} chars ≈ ${Math.round(contentDelivered / 4)} tokens${note}`);

        const totalChars = reasoningChars + contentDelivered;
        // Two clocks: streaming time (from when the provider started sending)
        // and time since the request arrived (which also includes any wait).
        const waitPart = firstOutputAt ? ` | first output after ${shortDuration(firstOutputAt - reqStartedAt)} | ${humanDuration(Date.now() - reqStartedAt)} since request` : '';
        const statsStr = `${chunkCount} chunks | reply ${sizeStr(contentDelivered)} | reasoning ${sizeStr(reasoningChars)} | total ${sizeStr(totalChars)} | ${ms}ms (${humanDuration(ms)}) streaming${waitPart}`;
        // Copy the stitched think / reply into the Render console too — they
        // were Admin-only, leaving Render with thousands of per-chunk lines.
        if (reasoningLog) consoleBlock('THINK', `[${userName}] reasoning — ${sizeStr(reasoningChars)}`, reasoningLog.text(), rid, ADMIN_STREAM_LOG_MAX_CHARS);
        if (contentLog) consoleBlock('REPLY', `[${userName}] reply — ${sizeStr(contentDelivered)}`, contentLog.text(), rid, ADMIN_STREAM_LOG_MAX_CHARS);
        const errSuffix = parseErrorCount ? ` | ${parseErrorCount} chunk parse error(s), last: ${lastParseError}` : '';
        if (how === 'error') {
          log('ERROR', `[${userName}] [${classifyError(err).tag}] stream error after ${chunkCount} chunks: ${err?.message}`);
        }
        if (truncated) {
          log('WARN', `[${userName}] [STREAM_CUT] stream ended without a finish_reason (${how}) — ${statsStr}. Closed it out with finish_reason + [DONE] so the client keeps what streamed.${errSuffix}`);
        } else if (upstreamFinishReason === 'length') {
          log('WARN', `[${userName}] [TOKEN_CAP] hit the token cap (finish_reason=length) — upstream was given max_tokens=${sentMaxTokens}${contentDelivered === 0 ? ' — all thinking, no reply written' : ' — reply cut off mid-way'} — ${statsStr}${errSuffix}`);
        } else {
          log('INFO', `[${userName}] ✓ stream complete (finish_reason=${upstreamFinishReason || 'none'}) — ${statsStr}${errSuffix}`);
        }
        res.end();
      };

      response.data.on('end', () => finalizeStream('end'));
      response.data.on('error', (err) => finalizeStream('error', err));
      // Safety net. With real axios a dropped socket normally arrives as an
      // 'error' (ECONNRESET) and a connection that goes silent is cut by axios's
      // idle timeout (timeoutMs: 300s default, 30 min on glm-5.3-nv) — both are
      // already handled above. This only matters if a stream closes with neither
      // 'end' nor 'error' (reproduced with the mock; not seen from real axios on
      // Node 22). It fires only once the upstream connection is actually closed,
      // so it can never cut a reply that is still coming in. finalizeStream is
      // idempotent, so this is a no-op when 'end'/'error' already ran.
      response.data.on('close', () => finalizeStream('close'));
      // Client hung up mid-stream: stop reading the upstream instead of
      // paying for tokens nobody will ever see. The 'close' handler above
      // closes the client side out afterwards (writes to a closed res are
      // harmless no-ops). On a normal completion 'finalized' is already
      // true, so the post-end 'close' event doesn't destroy anything.
      res.on('close', () => {
        if (!finalized) {
          try { response.data.destroy(); } catch (_) { /* already gone */ }
        }
      });


    } else {
      const message0 = response.data.choices[0]?.message || {};
      const rawText = message0.content || '';
      // reasoning_content is the NIM/Z.AI convention; OpenRouter's documented
      // field is "reasoning" (a string when present). Only a string counts —
      // object-shaped reasoning payloads are not text.
      const nativeReasoning = message0.reasoning_content
        || (typeof message0.reasoning === 'string' ? message0.reasoning : null);

      log('DEBUG', `[${userName}] RESPONSE: native_reasoning: ${!!nativeReasoning} | content length: ${rawText.length}`);

      const { reasoning, content } = parseThinkTags(rawText);
      const finalReasoning = nativeReasoning || reasoning;
      if (response.data.choices[0]?.finish_reason === 'length') {
        log('WARN', `[${userName}] [TOKEN_CAP] hit the token cap (finish_reason=length) — upstream was given max_tokens=${sentMaxTokens}${content ? ' — reply cut off mid-way' : ' — all thinking, no reply written'}`);
      }
      const toolCalls = response.data.choices[0]?.message?.tool_calls;
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
      if (hasToolCalls) log('INFO', `[${userName}] tool_calls: ${toolCalls.map(t => t.function?.name).join(', ')}`);
      logStitchedText('THINK', `[${userName}] reasoning`, finalReasoning);
      logStitchedText('REPLY', `[${userName}] reply`, content);

      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: {
            role: response.data.choices[0].message.role,
            content: hasToolCalls && !content ? null : content,
            ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
            ...(finalReasoning ? { reasoning_content: finalReasoning } : {})
          },
          finish_reason: response.data.choices[0].finish_reason || 'stop'
        }],
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };

      res.json(openaiResponse);
    }

  } catch (error) {
    const rawBody = await getErrorBodyText(error);
    const errorBody = truncateForLog(rawBody);
    const cls = classifyError(error, rawBody);
    const clientGoneFlag = () => res.destroyed || (res.req && res.req.aborted) || !!error.clientWasGone;
    clearWait();
    const lastAttempt = Array.isArray(error.attempts) && error.attempts.length ? error.attempts[error.attempts.length - 1] : null;
    const where = lastAttempt ? `${lastAttempt.provider}/${displayModel(lastAttempt.provider, lastAttempt.model)}` : 'proxy';
    // The client hung up (our own cancel surfaces here): nothing to send back,
    // and it is not an error worth an ERROR line.
    if (cls.tag === 'CLIENT_GONE' || clientGoneFlag()) {
      log('INFO', `[${userName}] request ended — client disconnected, upstream cancelled${error.tryNote ? ` (${error.tryNote})` : ''}`);
      return;
    }
    const multiHop = (error.chainLength || 0) > 1;
    const shownMsg = cls.providerMessage || error.message || 'Internal server error';
    const statusNum = error.response?.status;
    const detailBits = [statusNum ? `HTTP ${statusNum}` : null, error.tryNote || null].filter(Boolean).join(', ');
    // One line: what failed, the provider's own one-line message, status and
    // retry info. The raw body is only added when nothing readable came out of it.
    log('ERROR', `[${userName}] [${cls.tag}] ${cls.tag === 'NO_HOP' ? shownMsg : `${where} — ${shownMsg}`}${detailBits && cls.tag !== 'NO_HOP' ? ` (${detailBits})` : ''}${cls.providerMessage || !rawBody ? '' : ` | body: ${errorBody}`}`);
    if (res.headersSent) { try { res.end(); } catch (_) { /* already closed */ } return; }
    if (multiHop && Array.isArray(error.attempts) && error.attempts.length) {
      const pathStr = error.attempts.map(a => `${a.provider}/${a.model}:${a.outcome}${a.reason ? `(${a.reason})` : ''}`).join(' -> ');
      res.setHeader('X-QProxy-Fallback-Path', pathStr);
    }
    res.setHeader('X-QProxy-Error-Tag', cls.tag);
    if (error.retryAfterS) res.setHeader('Retry-After', String(error.retryAfterS));
    const httpStatus = error.response?.status || cls.httpStatus || 500;
    res.status(httpStatus).json({
      error: {
        // Shows up as-is in Janitor/Marinara error popups: what failed, the
        // provider's one-line reason, and (only when it helps) how long to wait.
        message: cls.tag === 'NO_HOP'
          ? `[Q-Proxy · NO_HOP] ${shownMsg}`
          : `[Q-Proxy · ${cls.tag}] ${where}: ${shownMsg}${detailBits ? ` (${detailBits})` : ''}${cls.hint ? ` — ${cls.hint}` : ''}`,
        type: cls.type,
        tag: cls.tag,
        code: httpStatus,
        provider_message: cls.providerMessage || null,
        provider: where.split('/')[0] || null,
        ...(error.retryAfterS ? { retry_after_s: error.retryAfterS } : {})
      },
      // The hop-by-hop trail only means something when there WAS more than one hop.
      ...(multiHop && Array.isArray(error.attempts) && error.attempts.length ? { attempts: error.attempts } : {})
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

// Without ADMIN_KEY the admin panel is disabled (every /admin request answers
// 503). Say so once at boot, so a missing env var shows up in Render's logs
// instead of looking like a broken panel.
if (!ADMIN_KEY) log('WARN', '[admin] ADMIN_KEY is not set — the admin panel is disabled (every /admin request returns 503). Set ADMIN_KEY in the environment (Render → Environment) to enable it.');
// Keyed by client IP, not one shared counter — a single global
// {count, lockedUntil} means ANY stranger (or bot scanning for open
// admin panels) sending 5 wrong keys locks out the real admin for up
// to an hour too. Per-IP means a stranger can only lock out themselves.
// Unbounded growth in theory (an attacker cycling source IPs), but for
// a single-operator proxy the realistic footprint is tiny; add an
// eviction pass here if this ever gets exposed to real hostile traffic.
const adminAuthFails = new Map(); // ip -> { count, lockedUntil }

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
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const state = adminAuthFails.get(ip) || { count: 0, lockedUntil: 0 };
  const now = Date.now();
  if (now < state.lockedUntil) {
    const waitSec = Math.ceil((state.lockedUntil - now) / 1000);
    return res.status(429).json({ error: { message: `Too many failed admin key attempts. Try again in ${waitSec}s.`, type: 'rate_limit_error', code: 429 } });
  }
  // Header only — deliberately NOT falling back to req.query.key here.
  // admin.html's own api() helper already sends X-Admin-Key as a header;
  // a query-string fallback only exists for curl convenience, and query
  // strings end up in Render's access logs, proxies, and browser
  // history far more readily than headers do. The page's own "?key="
  // bookmark convenience is a client-side-only convenience (see
  // admin.html) and doesn't need this fallback to keep working.
  const provided = req.headers['x-admin-key'] || '';
  if (provided !== ADMIN_KEY) {
    state.count++;
    if (state.count >= 5) {
      const lockSec = Math.min(3600, 30 * Math.pow(2, state.count - 5));
      state.lockedUntil = now + lockSec * 1000;
      log('WARN', `[admin] locking out ${ip} for ${lockSec}s after ${state.count} failed attempts`);
    }
    adminAuthFails.set(ip, state);
    return res.status(401).json({ error: { message: 'Invalid or missing admin key.', type: 'unauthorized', code: 401 } });
  }
  adminAuthFails.delete(ip);
  next();
}

// ============================================================
// ADMIN: MODELS CRUD
// ── Mutations write straight through to models.json via
//    saveModels(). See the GitHub sync notes above for what survives
//    a restart on Render Free and what doesn't.
// ============================================================
app.get('/admin/api/models', requireAdmin, (req, res) => {
  res.json({ models: MODEL_MAPPING });
});

// Every hop, at any depth of the `.fallback` chain, needs a model + provider.
// (Bundle/container entries are just regular entries built from copied
// hops in the admin UI, not a distinct shape — same validation applies.)
function validateHopShape(entry) {
  let cur = entry;
  let i = 0;
  while (cur) {
    if (!cur.model || !cur.provider) {
      return `Hop #${i + 1} needs both "model" and "provider".`;
    }
    cur = cur.fallback || null;
    i++;
  }
  return null;
}

app.post('/admin/api/models', requireAdmin, async (req, res) => {
  const { id, entry, previousId } = req.body || {};
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: { message: 'Body must include a string "id".', type: 'invalid_request_error', code: 400 } });
  }
  if (!entry || typeof entry !== 'object') {
    return res.status(400).json({ error: { message: 'Body must include an "entry" object.', type: 'invalid_request_error', code: 400 } });
  }
  const shapeError = validateHopShape(entry);
  if (shapeError) {
    return res.status(400).json({ error: { message: shapeError, type: 'invalid_request_error', code: 400 } });
  }
  const isRename = previousId && typeof previousId === 'string' && previousId !== id;
  if (isRename) {
    if (!MODEL_MAPPING[previousId]) {
      return res.status(404).json({ error: { message: `Can't rename — no existing model "${previousId}".`, type: 'invalid_request_error', code: 404 } });
    }
    if (MODEL_MAPPING[id]) {
      return res.status(409).json({ error: { message: `Can't rename to "${id}" — that id already exists as a different model.`, type: 'conflict_error', code: 409 } });
    }
  }

  // Validate the whole reference graph (existence + no cycles) BEFORE
  // committing anything, using the same resolver the live traffic path
  // uses — so if it would blow up at request time, it's rejected here
  // instead. Tried against a scratch copy of MODEL_MAPPING so a bad save
  // never corrupts the live mapping even transiently.
  const scratch = { ...MODEL_MAPPING };
  if (isRename) delete scratch[previousId];
  scratch[id] = entry;
  try {
    resolveModelChain(id, scratch);
  } catch (e) {
    return res.status(400).json({ error: { message: `Invalid reference chain: ${e.message}`, type: 'invalid_request_error', code: 400 } });
  }

  if (isRename) delete MODEL_MAPPING[previousId];
  MODEL_MAPPING[id] = entry;
  let sync;
  try {
    sync = await saveModels(MODEL_MAPPING, isRename
      ? `Q-Proxy admin: rename model "${previousId}" -> "${id}"`
      : `Q-Proxy admin: upsert model "${id}"`);
  } catch (e) {
    return res.status(500).json({ error: { message: `Saved in memory but failed to write models.json: ${e.message}`, type: 'server_error', code: 500 } });
  }
  log('INFO', `[admin] ${isRename ? `renamed "${previousId}" to "${id}"` : `upserted model "${id}"`}${sync.ok ? ' (synced to GitHub)' : ''}`);
  res.json({ ok: true, id, entry, renamedFrom: isRename ? previousId : null, githubSync: sync });
});

app.delete('/admin/api/models/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!MODEL_MAPPING[id]) {
    return res.status(404).json({ error: { message: `No model "${id}"`, type: 'invalid_request_error', code: 404 } });
  }
  delete MODEL_MAPPING[id];
  let sync;
  try {
    sync = await saveModels(MODEL_MAPPING, `Q-Proxy admin: delete model "${id}"`);
  } catch (e) {
    return res.status(500).json({ error: { message: `Deleted in memory but failed to write models.json: ${e.message}`, type: 'server_error', code: 500 } });
  }
  log('INFO', `[admin] deleted model "${id}"${sync.ok ? ' (synced to GitHub)' : ''}`);
  res.json({ ok: true, id, githubSync: sync });
});

// Re-read models.json from disk without restarting the process —
// handy if you edited the file directly (e.g. via git).
app.post('/admin/api/models/reload', requireAdmin, (req, res) => {
  try {
    MODEL_MAPPING = loadModelsFromDisk();
  } catch (e) {
    return res.status(500).json({ error: { message: e.message, type: 'server_error', code: 500 } });
  }
  res.json({ ok: true, count: Object.keys(MODEL_MAPPING).length });
});

// Reports whether GitHub sync is configured at all, so the admin UI can
// show a clear "changes will NOT survive a restart" banner instead of
// people finding out the hard way after Render recycles the instance.
app.get('/admin/api/github-status', requireAdmin, (req, res) => {
  res.json({
    enabled: GITHUB_SYNC_ENABLED,
    repo: GITHUB_SYNC_ENABLED ? GITHUB_REPO : null,
    branch: GITHUB_SYNC_ENABLED ? GITHUB_BRANCH : null,
  });
});

// ============================================================
// ADMIN: USAGE / CREDITS
// ── Shows only facts the proxy can actually know:
//    - self-tracked user-key limits
//    - OpenRouter's own proxy-side 50/day/key rotation counters
//    - optional generic provider quota policies, when configured
// ── It deliberately does NOT ask OpenRouter for another quota and does
//    not pretend that an unavailable provider balance exists.
// ============================================================
app.get('/admin/api/usage', requireAdmin, async (req, res) => {
  const keyMap = buildKeyMap();
  const now = Date.now();
  const perKeyLimits = Object.entries(keyMap).map(([key, info]) => ({
    name: info.name,
    limit: info.limit,
    usedThisMinute: usageTracker[key]?.count || 0,
    resetsInSec: info.limit == null ? null : (usageTracker[key] ? Math.max(0, Math.ceil((usageTracker[key].resetAt - now) / 1000)) : null)
  }));

  const today = dayKeyAtUtcHourOffset(0);
  const openrouterSelfTracked = OPENROUTER_KEYS.map((_, i) => ({
    key: OPENROUTER_KEY_ENTRIES[i].envName,
    usedToday: openrouterKeyState[i].day === today ? openrouterKeyState[i].count : 0,
    cap: OPENROUTER_DAILY_CAP
  }));

  res.json({
    perKeyLimits,
    providerUsage: Object.values(providerUsage),
    openrouter: { selfTracked: openrouterSelfTracked },
    providerQuotas: Object.keys(PROVIDER_QUOTAS).map(getProviderQuotaSnapshot),
    literouterKeysLoaded: LITEROUTER_KEYS.length,
    // Per-model, per-key breakdown for Literouter models that have a
    // dailyCap set — this is what the Admin dashboard renders as
    // "12/30 (LITEROUTER_KEY_1)  0/30 (LITEROUTER_KEY_2)" rows.
    literouterCappedModels: literouterCapSnapshot(),
    // One shared 50/day-per-key pool across every "premium" hop, separate
    // from the per-model buckets above.
    literouterPremiumPool: literouterPremiumSnapshot(),
    googleUsage: googleUsageSnapshot(),
    providerResets: providerResetInfo()
  });
});

// ============================================================
// ADMIN: LOGS
// ============================================================
app.get('/admin/api/logs', requireAdmin, (req, res) => {
  const level = (req.query.level || '').toUpperCase();
  const ridQ = String(req.query.rid || '').replace(/^#/, '').trim();
  const limit = Math.min(Number(req.query.limit) || RECENT_LOGS_MAX, RECENT_LOGS_MAX);
  const filtered = recentLogs.filter(l => (!level || l.level === level) && (!ridQ || l.rid === ridQ));
  // recentLogs is newest-first internally (that's what makes capping via
  // recentLogs.length = MAX correctly drop the OLDEST entries) — but
  // that's an implementation detail. Take the most recent `limit`
  // entries, then flip to oldest-first before sending, so the client can
  // just render top-to-bottom like every other log viewer/terminal,
  // instead of newest-on-top which reads backwards.
  const mostRecent = filtered.slice(0, limit);
  res.json({ logs: mostRecent.reverse(), total: recentLogs.length, capacity: RECENT_LOGS_MAX });
});

// ── Hop warnings: what is still configured but gone / turned paid / changed ──
app.get('/admin/api/warnings', requireAdmin, (req, res) => {
  const hops = allHopWarnings();
  const counts = hops.reduce((a, w) => (a[w.kind] = (a[w.kind] || 0) + 1, a), {});
  res.json({ hops, counts, catalogCheckedAt });
});
app.post('/admin/api/warnings/check', requireAdmin, async (req, res) => {
  const results = await runCatalogCheck(req.body && req.body.provider);
  const hops = allHopWarnings();
  res.json({ ok: true, results, hops, counts: hops.reduce((a, w) => (a[w.kind] = (a[w.kind] || 0) + 1, a), {}), catalogCheckedAt });
});

// ── Google limits: status (for the "may be outdated" warning), preview/apply of a pasted
// AI Studio table, and dismissing the mismatch warning ──────────────────────────────
app.get('/admin/api/limits/status', requireAdmin, (req, res) => {
  const meta = limitsMeta('google');
  res.json({ google: meta, mismatches: googleLimitMismatches, outdated: !!(meta && meta.stale) || googleLimitMismatches.length > 0 });
});
app.post('/admin/api/limits/dismiss', requireAdmin, (req, res) => {
  googleLimitMismatches = [];
  markUsageStateDirty();
  res.json({ ok: true });
});
function planFromPaste(text) {
  const rows = parseAiStudioLimitsPaste(text);
  if (rows.length < 3 || !rows.some(r => /^gemini|^gemma/i.test(r.label))) return { error: `Couldn't find the AI Studio rate-limit table in what you pasted (found ${rows.length} model row${rows.length === 1 ? '' : 's'}). Select the whole table on the AI Studio "Rate limit" page — model name, category, RPM, TPM and RPD columns — and paste it as is.` };
  const merged = mergeGoogleSnapshot(PROVIDER_LIMITS.google && PROVIDER_LIMITS.google.models, rows);
  return { rows, merged, hopChanges: planGoogleHopUpdates(merged.models) };
}
function planSummary(plan) {
  return { rows: plan.rows.length, changes: plan.merged.changes, added: plan.merged.added, keptNotInPaste: plan.merged.kept,
    hopChanges: plan.hopChanges.map(({ hop, ...rest }) => rest), previousCapturedAt: PROVIDER_LIMITS.google && PROVIDER_LIMITS.google.capturedAt };
}
app.post('/admin/api/limits/google/preview', requireAdmin, (req, res) => {
  const plan = planFromPaste(req.body && req.body.text);
  if (plan.error) return res.status(400).json({ error: { message: plan.error } });
  res.json({ ok: true, ...planSummary(plan) });
});
app.post('/admin/api/limits/google/apply', requireAdmin, async (req, res) => {
  const plan = planFromPaste(req.body && req.body.text);
  if (plan.error) return res.status(400).json({ error: { message: plan.error } });
  const summary = planSummary(plan);
  for (const c of plan.hopChanges) c.hop[c.field] = c.to;
  PROVIDER_LIMITS.google = { ...(PROVIDER_LIMITS.google || {}), capturedAt: new Date().toISOString().slice(0, 10), models: plan.merged.models };
  fs.writeFileSync(PROVIDER_LIMITS_PATH, JSON.stringify(PROVIDER_LIMITS, null, 2) + '\n');
  googleLimitMismatches = [];
  markUsageStateDirty();
  const msg = `Q-Proxy admin: refresh Google limits from an AI Studio paste (${plan.merged.changes.length} row change(s), ${plan.hopChanges.length} hop value(s))`;
  const syncLimits = await githubSyncFile(GITHUB_LIMITS_PATH, fs.readFileSync(PROVIDER_LIMITS_PATH, 'utf8'), msg);
  const syncModels = plan.hopChanges.length ? await saveModels(MODEL_MAPPING, msg) : { ok: true, skipped: true };
  log('INFO', `[admin] ${msg}${syncLimits.ok ? ' (synced to GitHub)' : ''}`);
  res.json({ ok: true, ...summary, capturedAt: PROVIDER_LIMITS.google.capturedAt, githubSync: { limits: syncLimits, models: syncModels } });
});

app.post('/admin/api/logs/clear', requireAdmin, (req, res) => {
  recentLogs.length = 0;
  res.json({ ok: true });
});

// ============================================================
// ADMIN: REASONING SCHEMAS
// ============================================================
app.get('/admin/api/reasoning-schemas', requireAdmin, (req, res) => {
  res.json({ schemas: REASONING_SCHEMAS });
});

app.post('/admin/api/reasoning-schemas', requireAdmin, async (req, res) => {
  const { id, schema } = req.body || {};
  if (!id || !/^[a-z0-9][a-z0-9._-]*$/.test(String(id))) {
    return res.status(400).json({ error: { message: 'Schema id must contain only lowercase letters, numbers, dots, underscores, or hyphens.', type: 'invalid_request_error', code: 400 } });
  }
  if (!schema || typeof schema !== 'object' || !schema.transport || !schema.fields || typeof schema.fields !== 'object') {
    return res.status(400).json({ error: { message: 'Schema must include transport and fields.', type: 'invalid_request_error', code: 400 } });
  }
  if (!['chat_template_kwargs', 'top_level'].includes(schema.transport)) {
    return res.status(400).json({ error: { message: 'Schema transport must be chat_template_kwargs or top_level.', type: 'invalid_request_error', code: 400 } });
  }
  REASONING_SCHEMAS[id] = { ...schema };
  let sync;
  try {
    sync = await saveReasoningSchemas(`Q-Proxy admin: save reasoning schema "${id}"`);
  } catch (e) {
    return res.status(500).json({ error: { message: `Schema updated in memory but failed to write reasoning-schemas.json: ${e.message}`, type: 'server_error', code: 500 } });
  }
  log('INFO', `[admin] saved reasoning schema "${id}"${sync.ok ? ' (synced to GitHub)' : ''}`);
  res.json({ ok: true, id, schema: REASONING_SCHEMAS[id], githubSync: sync });
});

app.delete('/admin/api/reasoning-schemas/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (!REASONING_SCHEMAS[id]) return res.status(404).json({ error: { message: `Unknown reasoning schema "${id}".`, type: 'invalid_request_error', code: 404 } });
  // Do not delete a schema while any configured hop still references it.
  for (const entry of Object.values(MODEL_MAPPING)) {
    let hop = entry;
    while (hop) {
      if (hop.reasoningSchema === id) {
        return res.status(409).json({ error: { message: `Schema "${id}" is still used by a configured model.`, type: 'conflict_error', code: 409 } });
      }
      hop = hop.fallback;
    }
  }
  delete REASONING_SCHEMAS[id];
  let sync;
  try { sync = await saveReasoningSchemas(`Q-Proxy admin: delete reasoning schema "${id}"`); }
  catch (e) { return res.status(500).json({ error: { message: `Deleted in memory but failed to write reasoning-schemas.json: ${e.message}`, type: 'server_error', code: 500 } }); }
  res.json({ ok: true, id, githubSync: sync });
});

// ============================================================
// MODEL PRESETS — confirmed-good reasoning configs for exact models,
// keyed "provider/model". Applied automatically at sync-import time (see
// /admin/api/sync/:provider/add above) so a model you've already tested
// doesn't reset to blank switches if you re-import it later.
// ============================================================
app.get('/admin/api/presets', requireAdmin, (req, res) => {
  res.json({ presets: MODEL_PRESETS });
});

app.post('/admin/api/presets', requireAdmin, async (req, res) => {
  const { provider, model, config } = req.body || {};
  if (!provider || !model || typeof provider !== 'string' || typeof model !== 'string') {
    return res.status(400).json({ error: { message: 'Body must include string "provider" and "model".', type: 'invalid_request_error', code: 400 } });
  }
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: { message: 'Body must include "config" (the reasoning setup to remember for this exact model).', type: 'invalid_request_error', code: 400 } });
  }
  const key = presetKeyFor(provider, model);
  MODEL_PRESETS[key] = { ...config };
  let sync;
  try {
    sync = await saveModelPresets(`Q-Proxy admin: save preset for "${key}"`);
  } catch (e) {
    return res.status(500).json({ error: { message: `Saved in memory but failed to write model-presets.json: ${e.message}`, type: 'server_error', code: 500 } });
  }
  log('INFO', `[admin] saved preset for "${key}"${sync.ok ? ' (synced to GitHub)' : ''}`);
  res.json({ ok: true, key, preset: MODEL_PRESETS[key], githubSync: sync });
});

app.delete('/admin/api/presets/:key', requireAdmin, async (req, res) => {
  const key = decodeURIComponent(req.params.key);
  if (!MODEL_PRESETS[key]) return res.status(404).json({ error: { message: `No preset for "${key}".`, type: 'invalid_request_error', code: 404 } });
  delete MODEL_PRESETS[key];
  let sync;
  try { sync = await saveModelPresets(`Q-Proxy admin: delete preset for "${key}"`); }
  catch (e) { return res.status(500).json({ error: { message: `Deleted in memory but failed to write model-presets.json: ${e.message}`, type: 'server_error', code: 500 } }); }
  res.json({ ok: true, key, githubSync: sync });
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
const SYNCABLE_PROVIDERS = new Set(['nvidia', 'zai', 'google', 'openrouter', 'literouter']);

// Snapshot of Literouter's account dashboard (Sep 2026) — the free-tier
// list's own daily caps, and the Premium Basic list: specifically the
// models reachable through the shared premium pool on a free/Basic plan
// WITHOUT paying (higher tiers — Standard/Plus/Pro/Elite/Ultimate — need
// an actual subscription and aren't in this table at all, so a hop for
// a model that ISN'T in here might just be inaccessible on this plan
// rather than "premium and poolable"). Keyed by the base model name (no
// ":free" suffix). None of this is exposed by /v1/models, so it's
// pasted data, not something a sync can re-derive — expect it to drift
// and need refreshing by hand periodically. Not wired into actual cost
// accounting (see the Credits research: real cost also depends on
// token-weighted "optimization cost" and account-specific settings this
// table can't capture) — this only powers the info shown in the
// sync-result UI before you add a model.
// Keyed by base model name (no ":free"): { hasFree, freeDailyCap (null =
// unlimited), premiumBasic, premiumCost, uncensored }.
const LITEROUTER_KNOWN_MODELS = (PROVIDER_LIMITS.literouter && PROVIDER_LIMITS.literouter.models) || {};

// Google's /models returns ids as "models/gemini-2.5-flash"; the OpenAI-compat
// endpoint and the rest of models.json use the bare slug. Strip the prefix
// everywhere so ids/models never come out as "models-gemini-...-g".
function normalizeGoogleModelId(id) {
  return String(id || '').trim().replace(/^models\//i, '');
}
function googleLimitsFor(model) {
  return googleRowFor(PROVIDER_LIMITS.google && PROVIDER_LIMITS.google.models, model);
}
function googleRowFor(rows, model) {
  if (!rows) return null;
  const slug = normalizeGoogleModelId(model).toLowerCase();
  const candidates = [slug, slug.replace(/-preview(-\d{2}-\d{2,4})?$/, ''), slug.replace(/-latest$/, '')];
  for (const c of candidates) {
    for (const row of Object.values(rows)) if ((row.slugs || []).includes(c)) return row;
  }
  return null;
}
// ── Refresh the Google limits snapshot from a pasted AI Studio rate-limit table ──
// No API returns these numbers, so the table is pasted into the Admin panel. Rows are
// MERGED into the snapshot (rows missing from the paste are kept, never dropped); the
// slugs a row matches stay as they are, new rows get slugs derived by naming convention.
function parseLimitCell(t) {
  const v = String(t).split('/').pop().trim();
  if (!v || v === '-' || /^unlimited$/i.test(v)) return null;
  const m = v.replace(/,/g, '').match(/^([\d.]+)\s*([KM]?)$/i);
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * ({ '': 1, K: 1e3, M: 1e6 })[m[2].toUpperCase()]);
}
function parseAiStudioLimitsPaste(text) {
  const tokens = String(text || '').split(/\r?\n/).flatMap(l => l.split(/\t+/)).map(t => t.trim()).filter(Boolean);
  const isCell = (t) => t === '-' || /^[\d.,]+\s*[KM]?\s*\/\s*(unlimited|-|[\d.,]+\s*[KM]?)$/i.test(t);
  const rows = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'Tools' && rows.length) break;           // the grounding/tools tables after the models table
    if (!isCell(tokens[i]) || i < 2 || isCell(tokens[i - 1]) || isCell(tokens[i - 2])) continue;
    if (!isCell(tokens[i + 1] || '') || !isCell(tokens[i + 2] || '')) continue;
    rows.push({ label: tokens[i - 2], category: tokens[i - 1], rpm: parseLimitCell(tokens[i]), tpm: parseLimitCell(tokens[i + 1]), rpd: parseLimitCell(tokens[i + 2]) });
    i += 2;
  }
  return rows;
}
function deriveGoogleSlugs(label, category) {
  const base = label.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
  if (/^gemma/i.test(label)) return [base + '-it', base];
  if (category === 'Text-out models' && /^gemini/i.test(label)) return [base, base + '-preview'];
  return [];
}
// Merge parsed rows into a copy of the current table; returns { models, changes, added, kept }.
function mergeGoogleSnapshot(existing, rows) {
  const models = JSON.parse(JSON.stringify(existing || {}));
  const changes = [], added = [], seen = new Set();
  for (const r of rows) {
    const key = r.label.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
    seen.add(key);
    const prev = models[key];
    const next = { label: r.label, category: r.category, slugs: prev ? prev.slugs : deriveGoogleSlugs(r.label, r.category), rpm: r.rpm, tpm: r.tpm, rpd: r.rpd };
    if (r.rpm === 0 && r.tpm === 0 && r.rpd === 0) next.noFreeAccess = true;
    if (!prev) added.push(r.label);
    else for (const f of ['rpm', 'tpm', 'rpd']) if (prev[f] !== next[f]) changes.push({ label: r.label, field: f, from: prev[f], to: next[f] });
    models[key] = next;
  }
  const kept = Object.keys(models).filter(k => !seen.has(k)).length;
  return { models, changes, added, kept };
}
// Which EXISTING Google hops would change if these rows were applied.
function planGoogleHopUpdates(models) {
  const out = [];
  for (const [id, entry] of Object.entries(MODEL_MAPPING)) {
    for (let hop = entry; hop; hop = hop.fallback) {
      if (hop.provider !== 'google') continue;
      const row = googleRowFor(models, hop.model);
      if (!row || row.noFreeAccess) continue;
      for (const f of ['rpm', 'tpm', 'rpd']) if (row[f] != null && hop[f] !== row[f]) out.push({ id, model: displayModel('google', hop.model), field: f, from: hop[f] === undefined ? null : hop[f], to: row[f], hop });
    }
  }
  return out;
}
// How old a snapshot is, so the Admin panel can warn when it's stale.
function limitsMeta(provider) {
  const sec = ['google', 'literouter'].includes(provider) ? PROVIDER_LIMITS[provider] : null;   // only these two pre-fill limits on add
  if (!sec || !sec.capturedAt) return null;
  const ageDays = Math.floor((Date.now() - new Date(sec.capturedAt).getTime()) / 86400000);
  const staleAfterDays = sec.staleAfterDays || 30;
  return { capturedAt: sec.capturedAt, ageDays, staleAfterDays, stale: ageDays > staleAfterDays, source: sec.source || null };
}

// Literouter model ids can carry stacked variant suffixes (:free, :metered,
// :full-context, :metered:full-context). Peel them off to find the base model
// the Premium Basic table is keyed on.
function literouterBaseAndVariants(id) {
  let base = String(id || '');
  const variants = [];
  for (;;) {
    const m = base.match(/:(free|metered|full-context)$/);
    if (!m) break;
    variants.unshift(m[1]);
    base = base.slice(0, -m[0].length);
  }
  return { base, variants };
}

// The fixed context of Literouter's FREE tier (provider-limits.json "freeContextTokens"), or null when this
// hop isn't a Literouter :free model / the table has no number.
function literouterFreeContextCap(pc) {
  if (!pc || pc.provider !== 'literouter') return null;
  if (!literouterBaseAndVariants(pc.model).variants.includes('free')) return null;
  const cap = PROVIDER_LIMITS.literouter && PROVIDER_LIMITS.literouter.freeContextTokens;
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

// Sync tiers:
//   free         — :free ids (own per-model daily budget)
//   premium      — reachable through the free plan's shared premium pool
//                  (base model is on the Premium Basic list; a :metered /
//                  :full-context variant is assumed to draw from the same
//                  pool, per Literouter's credits docs — shown as a tag)
//   inaccessible — base model is known NOT to be on Premium Basic
//                  (a higher paid plan is needed) — hidden from the sync
//   unknown      — base model isn't in the hand-transcribed table at all
function classifyLiterouterModel(id) {
  const { base, variants } = literouterBaseAndVariants(id);
  const known = LITEROUTER_KNOWN_MODELS[base] || null;
  const extra = variants.filter(v => v !== 'free').join(':') || null;
  if (variants.includes('free')) return { tier: 'free', cost: null, uncensored: known ? known.uncensored : null, variant: extra };
  if (known) return { tier: known.premiumBasic ? 'premium' : 'inaccessible', cost: known.premiumCost, uncensored: known.uncensored, variant: extra };
  return { tier: 'unknown', cost: null, uncensored: null, variant: extra };
}

function literouterKnownInfo(model) {
  const base = String(model || '').replace(/:free$/, '');
  return LITEROUTER_KNOWN_MODELS[base] || null;
}

// Per-provider caveats about what a "check for updates" sync CAN'T tell
// you, surfaced in the sync result UI rather than left implicit. This is
// about known structural gaps in what a provider's /models list exposes
// (not an error case — the request succeeds fine), so add an entry here
// whenever a new provider turns out to have the same kind of gap, rather
// than treating it as a one-off Literouter thing.
const PARTIAL_SYNC_NOTES = {
  literouter: 'Literouter\'s /models list is confirmed complete for what your key can reach (their docs: "every model available to your key") — but it never exposes any of the three credit balances (free, premium pool, permanent premium beta), so dailyCap/premium-pool tracking here is still Q-Proxy\'s own estimate, not Literouter\'s real number.'
};
const PROVIDER_SUFFIX = {
  nvidia: 'nv',
  zai: 'z',
  google: 'g',
  openrouter: 'or',
  literouter: 'lr',
  meganova: 'mn',
  deepseek: 'ds'
};

function inferReasoningSchema(provider, model) {
  const candidates = Object.entries(REASONING_SCHEMAS);
  for (const [id, schema] of candidates) {
    for (const rule of schema.match || []) {
      if (rule.provider && rule.provider !== provider) continue;
      if (rule.modelRegex) {
        try { if (new RegExp(rule.modelRegex, 'i').test(String(model || ''))) return id; }
        catch (e) { log('WARN', `Invalid modelRegex in reasoning schema "${id}": ${e.message}`); }
      }
      if (rule.modelPrefix && String(model || '').toLowerCase().startsWith(String(rule.modelPrefix).toLowerCase())) return id;
      if (rule.modelEquals && String(model || '') === String(rule.modelEquals)) return id;
    }
  }
  return null;
}

// ============================================================
// ADMIN: AUTO-DETECT REASONING CONFIG FROM A PROVIDER'S OWN DOCS
// ============================================================
// This is the server-side twin of the "paste an example" scanner in
// Admin (admin.html's detectReasoningFromExample) — same classification
// logic, duplicated here because admin.html runs in the browser and
// server.js runs in Node with no shared module between them today.
// Keep the two in sync if the heuristics change.
//
// For providers whose per-model documentation page is (a) public, (b)
// server-rendered enough that a plain GET returns the sample code as
// text, and (c) at a URL directly derivable from the model id, this
// closes the loop without asking a human to paste anything: fetch the
// page, pull out the code sample, run it through the same classifier.
// NVIDIA's build.nvidia.com is the only provider confirmed to fit all
// three right now — its model id ("org/model") IS the URL path
// (build.nvidia.com/org/model), and every model page ships a Python/
// curl sample with the exact chat_template_kwargs/reasoning_effort/
// reasoning_budget it actually needs. This is inherently best-effort:
// it depends on NVIDIA's page structure staying the same, so the result
// is always shown for review before anything is written to config —
// never applied silently.
const DETECT_BOOL_KEY_RE = /^(enable[_-]?thinking|thinking|reasoning|enable[_-]?reasoning|thinking[_-]?mode|show[_-]?thinking|show[_-]?reasoning|reasoning[_-]?enabled|thinking[_-]?enabled|include[_-]?reasoning)$/i;
const DETECT_EFFORT_KEY_RE = /^(reasoning[_-]?effort|thinking[_-]?effort|effort|reasoning[_-]?level|thinking[_-]?level|reasoning[_-]?budget|thinking[_-]?budget)$/i;
const DETECT_REASONING_HINT_RE = /think|reason/i;

function extractBalancedJsonFrom(text, fromIdx) {
  const start = text.indexOf('{', Math.max(0, fromIdx));
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Finds the outermost ({depth 0}) brace-balanced object that CONTAINS a
// given text position — not just the nearest preceding "{", which would
// often grab an inner nested object (e.g. a message's {"role":...}
// instead of the enclosing "payload = {...}"). Scans left-to-right once.
function findEnclosingObjectSpan(text, idx) {
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        if (idx >= start && idx <= i) return text.slice(start, i + 1);
        start = -1;
      }
    }
  }
  return null;
}

function normalizePySnippet(text) {
  // The samples on provider doc pages are often Python (True/False/None)
  // rather than strict JSON — close enough to parse once normalized.
  return text.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
}

function decodeHtmlFragment(s) {
  return s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, '');
}

// Pulls the first reasoning-looking JSON-ish object out of a raw HTML
// page: tries <pre>/<code> blocks first (the normal home for a rendered
// code sample), then falls back to scanning the flattened page text in
// case the sample lives inside embedded script/JSON data instead.
function extractReasoningSnippetFromHtml(html) {
  const blocks = [];
  const blockRe = /<(?:pre|code)[^>]*>([\s\S]*?)<\/(?:pre|code)>/gi;
  let m;
  while ((m = blockRe.exec(html))) blocks.push(m[1]);
  for (const raw of blocks) {
    const text = decodeHtmlFragment(raw);
    if (DETECT_REASONING_HINT_RE.test(text) && /\{/.test(text)) {
      const idx = text.search(/chat_template_kwargs|reasoning_budget|reasoning_effort|enable_thinking|thinking_budget|thinking_mode/i);
      const jsonText = idx === -1 ? extractBalancedJsonFrom(text, 0) : findEnclosingObjectSpan(text, idx);
      if (jsonText) return normalizePySnippet(jsonText);
    }
  }
  const flat = decodeHtmlFragment(html);
  const idx2 = flat.search(/chat_template_kwargs|reasoning_budget|reasoning_effort|enable_thinking|thinking_budget|thinking_mode/i);
  if (idx2 !== -1) {
    const jsonText = findEnclosingObjectSpan(flat, idx2);
    if (jsonText) return normalizePySnippet(jsonText);
  }
  return null;
}

function extractJsonObjectServer(text) {
  if (!text || !text.trim()) return null;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch (_) {}
  const jsonText = extractBalancedJsonFrom(trimmed, 0);
  if (!jsonText) return null;
  try { return JSON.parse(jsonText); } catch (_) { return null; }
}

// Same classification rules as admin.html's detectReasoningFromExample:
// a clean boolean toggle and/or effort enum go into the structured
// thinking-and-effort shape; anything nested or non-boolean/non-enum is
// flagged as a special case for the raw escape hatch instead of being
// forced into a bad fit.
function detectReasoningFromExampleServer(exampleText, valuesText) {
  const parsed = extractJsonObjectServer(exampleText);
  const result = { ok: false, error: null, toggle: null, effort: null, extraKeys: [], special: false };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.error = 'Could not find a valid JSON object in that text.';
    return result;
  }
  const containers = [
    { obj: parsed, transport: 'top_level' },
    { obj: (parsed.chat_template_kwargs && typeof parsed.chat_template_kwargs === 'object' && !Array.isArray(parsed.chat_template_kwargs)) ? parsed.chat_template_kwargs : null, transport: 'chat_template_kwargs' }
  ].filter(c => c.obj);

  for (const { obj, transport } of containers) {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'chat_template_kwargs') continue;
      if (v !== null && typeof v === 'object' && DETECT_REASONING_HINT_RE.test(k)) {
        result.extraKeys.push({ key: k, value: v, transport });
        continue;
      }
      if (DETECT_BOOL_KEY_RE.test(k) && (typeof v === 'boolean' || v === 'true' || v === 'false') && !result.toggle) {
        result.toggle = { key: k, value: (v === 'true' ? true : v === 'false' ? false : v), transport };
      } else if (DETECT_EFFORT_KEY_RE.test(k) && (typeof v === 'string' || typeof v === 'number') && !result.effort) {
        result.effort = { key: k, value: String(v), transport };
      } else if (DETECT_REASONING_HINT_RE.test(k)) {
        result.extraKeys.push({ key: k, value: v, transport });
      }
    }
  }

  const acceptedValues = (valuesText || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  if (result.effort) {
    const seen = new Set();
    result.effort.options = [result.effort.value, ...acceptedValues].filter(v => {
      if (seen.has(v)) return false;
      seen.add(v);
      return true;
    });
  } else if (acceptedValues.length) {
    result.effort = { key: 'reasoning_effort', value: acceptedValues[0], transport: 'top_level', options: acceptedValues, guessedKey: true };
  }

  result.special = result.extraKeys.length > 0;
  result.ok = Boolean(result.toggle || result.effort || result.special);
  if (!result.ok) result.error = 'No reasoning-looking fields found in that JSON — nothing to apply.';
  return result;
}

// Only NVIDIA is wired up right now — its model id doubles as the docs
// URL path and its sample code is fetchable with a plain GET. Other
// providers don't have a confirmed public per-model page at a
// predictable URL with a real code sample, so they fall through to a
// clear "not available" response rather than silently guessing a URL
// that might 404 or scrape the wrong thing.
const AUTO_DETECT_PAGE_URL = {
  nvidia: (model) => `https://build.nvidia.com/${model}`
};

app.get('/admin/api/detect/:provider', requireAdmin, async (req, res) => {
  const provider = req.params.provider;
  const model = req.query.model;
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: { message: 'Query must include ?model=<provider model id>', type: 'invalid_request_error', code: 400 } });
  }
  const urlBuilder = AUTO_DETECT_PAGE_URL[provider];
  if (!urlBuilder) {
    return res.status(400).json({ error: { message: `Automatic page-based detection isn't available for "${provider}" yet — no confirmed public per-model doc page at a predictable URL. Use the paste-an-example scanner instead.`, type: 'invalid_request_error', code: 400 } });
  }
  const pageUrl = urlBuilder(model);
  try {
    const r = await axios.get(pageUrl, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Q-Proxy-reasoning-detector/1.0)' } });
    const html = String(r.data || '');
    const snippet = extractReasoningSnippetFromHtml(html);
    if (!snippet) {
      return res.json({ ok: false, error: `No reasoning-looking code sample found on ${pageUrl}. This model may not support reasoning, or the page layout didn't match what we scan for — try pasting an example manually instead.`, pageUrl, snippet: null });
    }
    const detection = detectReasoningFromExampleServer(snippet, '');
    res.json({ ...detection, pageUrl, snippet });
  } catch (e) {
    res.status(502).json({ error: { message: `Couldn't fetch ${pageUrl}: ${e.response?.status || ''} ${e.message}`, type: 'upstream_error', code: 502 } });
  }
});

// Deliberately preserves EVERY hop field (spread, not a whitelist): this
// feeds /admin/api/sync/:provider/remove, which round-trips entries through
// flatten+nest to filter out one provider's hops. A whitelist here silently
// destroyed anything it didn't know about — maxTokens floors, tools:false,
// retryBudgetMs, maxRetries, all the reasoningField* maps, even the
// "custom": true bundle flag — the first time a synced model was removed.
function flattenEntry(entry) {
  const hops = [];
  let cur = entry;
  let depth = 0;
  while (cur) {
    // Same cycle guard as resolveModelChain — hand-edited models.json with
    // a fallback loop must not hang the sync endpoint.
    if (++depth > 50) throw new Error('Fallback chain is suspiciously deep (50+) — check for a mistake.');
    const { fallback, ...hop } = cur;
    hops.push(hop);
    cur = fallback || null;
  }
  return hops;
}

function nestHops(hops) {
  let result = null;
  for (let i = hops.length - 1; i >= 0; i--) {
    const item = { ...hops[i] };
    // Only fill in the two defaults flattenEntry used to guarantee; every
    // other field passes through exactly as it was.
    if (!item.status) item.status = 'active';
    if (!item.limitType) item.limitType = 'rate-limited';
    if (result) item.fallback = result;
    result = item;
  }
  return result;
}

function buildSuggestedModelId(provider, model) {
  const base = String(model || '')
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/[:/]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'new-model';
  const suffix = PROVIDER_SUFFIX[provider] || provider;
  const seed = `${base}-${suffix}`;
  let candidate = seed;
  let i = 2;
  while (MODEL_MAPPING[candidate]) {
    candidate = `${seed}-${i}`;
    i++;
  }
  return candidate;
}

// OpenRouter's /models response carries each model's price (USD per token, as strings),
// context length and supported parameters — no table to hand-type, unlike Literouter.
//   free : pricing 0/0 (or a ":free" id)
//   paid : everything else — it spends credits. Includes routers whose price varies (-1)
//          and models with no price listed; the Admin panel keeps this group collapsed.
function classifyOpenRouterModel(m) {
  const perM = (v) => { const n = Number(v); return (v === undefined || v === null || v === '' || !Number.isFinite(n)) ? NaN : Math.round(n * 1e6 * 1e6) / 1e6; };
  const input = perM(m.pricing && m.pricing.prompt), output = perM(m.pricing && m.pricing.completion);
  const free = String(m.id).endsWith(':free') || (input === 0 && output === 0);
  const sp = Array.isArray(m.supported_parameters) ? m.supported_parameters : null;
  return { tier: free ? 'free' : 'paid', cost: null, uncensored: null,
    price: free ? null : { in: input >= 0 ? input : null, out: output >= 0 ? output : null },
    context: Number(m.context_length) > 0 ? Number(m.context_length) : null,
    tools: sp ? sp.includes('tools') : null, reasoning: sp ? sp.includes('reasoning') : null };
}
app.get('/admin/api/sync/:provider', requireAdmin, async (req, res) => {
  const provider = req.params.provider;
  if (!SYNCABLE_PROVIDERS.has(provider)) {
    return res.status(400).json({
      error: { message: `No live catalog check available for "${provider}" — either it doesn't publish a /models list, or it isn't wired into SYNCABLE_PROVIDERS yet. Track it manually for now.`, type: 'invalid_request_error', code: 400 }
    });
  }

  const { base, key } = getProviderConfigReadOnly(provider);
  try {
    const r = await axios.get(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 15000
    });
    // Google lists ids as "models/xyz" but hops are stored bare (or, in older
    // entries, with the prefix) — compare on the bare slug so a configured
    // model isn't offered again as "new" under the other spelling.
    const canon = provider === 'google' ? normalizeGoogleModelId : (x) => x;
    const liveIds = [...new Set((r.data?.data || []).map(m => canon(m.id)))];
    const liveSet = new Set(liveIds);
    const rawById = new Map((r.data?.data || []).map(m => [canon(m.id), m]));

    const configuredIds = new Set();
    for (const entry of Object.values(MODEL_MAPPING)) {
      let hop = entry;
      while (hop) {
        if (hop.provider === provider) configuredIds.add(hop.model);
        hop = hop.fallback;
      }
    }
    const configuredCanon = new Set([...configuredIds].map(canon));

    let newlyAvailable = liveIds.filter(id => !configuredCanon.has(id));
    const noLongerListed = [...configuredIds].filter(id => !liveSet.has(canon(id)));
    // Three-way split, shown before you add a model: 'free' (no cost),
    // 'premium' (usable, but from a tighter/shared pool than free),
    // 'inaccessible' (listed by the provider but this plan/key can't
    // actually reach it), or 'unknown' when there's no verified,
    // provider-native signal to classify from. Only Literouter is
    // actually populated right now — its /v1/models is bare OpenAI shape
    // (id/object/created/owned_by only, confirmed via their own docs),
    // so this still comes from the hand-maintained LITEROUTER_KNOWN_MODELS
    // table, not a live provider signal; everything else is 'unknown'
    // rather than a hardcoded guess about a provider's own model tiers.
    const modelInfo = {};
    if (provider === 'literouter') {
      // Nothing is dropped any more: models this plan can't reach ('inaccessible')
      // and ones missing from the table ('unknown') are both returned, and the
      // Admin panel tucks everything that isn't Free / Premium Basic into one
      // collapsed "other" group instead of hiding a count.
      for (const id of newlyAvailable) modelInfo[id] = classifyLiterouterModel(id);
      newlyAvailable = [...newlyAvailable].sort((a, b) => a.localeCompare(b));
    } else if (provider === 'google') {
      for (const id of newlyAvailable) {
        const row = googleLimitsFor(id);
        const tier = !row ? 'unknown' : row.noFreeAccess ? 'paidonly' : (row.rpd == null || row.rpd >= GOOGLE_GENEROUS_RPD) ? 'generous' : 'thin';
        modelInfo[id] = { tier, cost: null, uncensored: null,
          limits: row ? { rpm: row.rpm, tpm: row.tpm, rpd: row.rpd, noFreeAccess: !!row.noFreeAccess, label: row.label } : null };
      }
    } else if (provider === 'openrouter') {
      for (const id of newlyAvailable) modelInfo[id] = classifyOpenRouterModel(rawById.get(id) || { id });
      newlyAvailable = [...newlyAvailable].sort((a, b) => a.localeCompare(b));
    } else if (provider === 'zai') {
      // Z.ai's /models has no prices; the free list is baked into provider-limits.json (from Z.ai's official pricing page).
      const freeIds = new Set(((PROVIDER_LIMITS.zai && PROVIDER_LIMITS.zai.freeModels) || []).map(x => x.toLowerCase()));
      for (const id of newlyAvailable) modelInfo[id] = { tier: freeIds.has(id.toLowerCase()) ? 'free' : 'paid', cost: null, uncensored: null };
      newlyAvailable = [...newlyAvailable].sort((a, b) => a.localeCompare(b));
    } else {
      for (const id of newlyAvailable) modelInfo[id] = { tier: 'unknown', cost: null, uncensored: null };
    }

    // Opening the panel is also a fresh catalog check: flag configured hops the provider dropped.
    applyCatalogWarnings(provider, catalogDriftFor(provider, liveSet));
    const noLongerListedKinds = Object.fromEntries(noLongerListed.map(id => { const w = hopWarnings[hopWarnKey(provider, id)]; return [id, { kind: w ? w.kind : 'gone', instead: w && w.instead || null }]; }));
    res.json({ provider, liveCount: liveIds.length, newlyAvailable, noLongerListed, modelInfo, limitsMeta: limitsMeta(provider), partialNote: PARTIAL_SYNC_NOTES[provider] || null,
      tierNotes: tierNotesFor(provider), noLongerListedKinds });
  } catch (e) {
    res.status(502).json({
      error: { message: `Couldn't reach ${provider}'s /models: ${e.response?.status || ''} ${e.message}`, type: 'upstream_error', code: 502 }
    });
  }
});

app.post('/admin/api/sync/:provider/add', requireAdmin, async (req, res) => {
  const provider = req.params.provider;
  if (!SYNCABLE_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: { message: `Provider "${provider}" is not syncable.`, type: 'invalid_request_error', code: 400 } });
  }
  const { model, id, status, limitType, reasoningOverride } = req.body || {};
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: { message: 'Body must include a string "model".', type: 'invalid_request_error', code: 400 } });
  }

  // Google hands out "models/xyz"; store and name everything by the bare slug.
  const cleanModel = provider === 'google' ? normalizeGoogleModelId(model) : model.trim();
  const safeId = (id && String(id).trim()) || buildSuggestedModelId(provider, cleanModel);
  if (MODEL_MAPPING[safeId]) {
    return res.status(409).json({ error: { message: `Model id "${safeId}" already exists.`, type: 'conflict_error', code: 409 } });
  }

  // If this exact model has a confirmed-good reasoning config saved from a
  // previous import (see MODEL_PRESETS / "Save as preset" in Admin), apply
  // it now instead of leaving every switch off and making you reconfigure
  // it from scratch. Falls back to the old family-level schema guess (still
  // starts with every switch off) when no preset exists for this exact
  // model.
  //
  // `reasoningOverride` takes priority over both: it's what the Admin UI
  // sends when you scanned a pasted example for this specific model on the
  // sync screen (via 🧪) before hitting "Add to config" — an actually-
  // inspected config, not a guess or a config carried over from a
  // differently-versioned model that happened to share a name prefix.
  const preset = MODEL_PRESETS[presetKeyFor(provider, cleanModel)] || MODEL_PRESETS[presetKeyFor(provider, model.trim())];
  const usedPreset = Boolean(preset) && !reasoningOverride;
  const usedDetection = Boolean(reasoningOverride && typeof reasoningOverride === 'object' && reasoningOverride.reasoningSchema);
  const src = usedDetection ? reasoningOverride : preset;
  // Pre-fill provider limits from the saved snapshot (provider-limits.json) —
  // no API returns these, so this is the "populate as if it were an API call" step.
  const limitFields = {};
  const limitNotes = [];
  let limitsApplied = null;
  if (provider === 'google') {
    const row = googleLimitsFor(cleanModel);
    if (row && row.noFreeAccess) {
      limitNotes.push(`AI Studio lists 0 RPM / 0 TPM / 0 RPD for "${row.label}" on the free tier — likely not usable without billing. Limits left blank on purpose (0 would be read as "not tracked").`);
    } else if (row) {
      if (row.rpm != null) limitFields.rpm = row.rpm;
      if (row.tpm != null) limitFields.tpm = row.tpm;
      if (row.rpd != null) limitFields.rpd = row.rpd;
      limitsApplied = { provider, matched: row.label, ...limitFields, capturedAt: PROVIDER_LIMITS.google.capturedAt };
    } else {
      limitNotes.push('No row for this model in the saved AI Studio limits snapshot — RPM/TPM/RPD left blank. Add its limits by hand (Edit) or add its slug to provider-limits.json.');
    }
  } else if (provider === 'literouter') {
    const { base, variants } = literouterBaseAndVariants(cleanModel);
    const known = LITEROUTER_KNOWN_MODELS[base] || null;
    if (known && variants.includes('free') && known.hasFree) {
      if (known.freeDailyCap != null) limitFields.dailyCap = known.freeDailyCap;
      const ctx = PROVIDER_LIMITS.literouter.freeContextTokens;
      limitNotes.push(`Free tier: ${known.freeDailyCap != null ? known.freeDailyCap + '/day per key' : 'no daily cap listed'}${ctx ? `; ${ctx.toLocaleString('en-US')}-token context (longer requests are summarized by Literouter)` : ''}.`);
      limitsApplied = { provider, matched: base, ...limitFields, capturedAt: PROVIDER_LIMITS.literouter.capturedAt };
    } else if (known && !variants.includes('free') && known.premiumBasic) {
      limitNotes.push(`Premium Basic · ${known.premiumCost}x credit cost (shared daily premium pool, not a per-model cap).`);
      limitsApplied = { provider, matched: base, premiumCost: known.premiumCost, capturedAt: PROVIDER_LIMITS.literouter.capturedAt };
    }
  }
  MODEL_MAPPING[safeId] = {
    model: cleanModel,
    provider,
    reasoningSchema: src?.reasoningSchema ?? inferReasoningSchema(provider, cleanModel),
    reasoning: src?.reasoning ? JSON.parse(JSON.stringify(src.reasoning)) : {},
    ...(src?.reasoningFieldEnabled ? { reasoningFieldEnabled: JSON.parse(JSON.stringify(src.reasoningFieldEnabled)) } : {}),
    ...(src?.reasoningFieldKeys ? { reasoningFieldKeys: JSON.parse(JSON.stringify(src.reasoningFieldKeys)) } : {}),
    ...(src?.reasoningFieldTransport ? { reasoningFieldTransport: JSON.parse(JSON.stringify(src.reasoningFieldTransport)) } : {}),
    ...(src?.reasoningFieldOptions ? { reasoningFieldOptions: JSON.parse(JSON.stringify(src.reasoningFieldOptions)) } : {}),
    ...((preset?.notes && !usedDetection) || limitNotes.length ? { notes: [(preset?.notes && !usedDetection) ? preset.notes : null, ...limitNotes].filter(Boolean).join(' ') } : {}),
    status: (status || 'active'),
    limitType: (limitType || 'rate-limited'),
    ...limitFields
  };
  let sync;
  try {
    sync = await saveModels(MODEL_MAPPING, `Q-Proxy admin: sync-add "${safeId}"${usedDetection ? ' (from detected example)' : usedPreset ? ' (from preset)' : ''}`);
  } catch (e) {
    delete MODEL_MAPPING[safeId];
    return res.status(500).json({ error: { message: `Added in memory but failed to write models.json: ${e.message}`, type: 'server_error', code: 500 } });
  }
  log('INFO', `[admin] sync-add "${safeId}" (${provider} / ${cleanModel})${limitsApplied ? ' — pre-filled limits from snapshot' : ''}${usedDetection ? ' — applied detected example config' : usedPreset ? ' — applied saved preset' : ''}${sync.ok ? ' (synced to GitHub)' : ''}`);
  res.json({ ok: true, id: safeId, entry: MODEL_MAPPING[safeId], usedPreset, usedDetection, limitsApplied, githubSync: sync });
});

app.post('/admin/api/sync/:provider/remove', requireAdmin, async (req, res) => {
  const provider = req.params.provider;
  if (!SYNCABLE_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: { message: `Provider "${provider}" is not syncable.`, type: 'invalid_request_error', code: 400 } });
  }
  const { model } = req.body || {};
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: { message: 'Body must include a string "model".', type: 'invalid_request_error', code: 400 } });
  }

  const touchedIds = [];
  const removedIds = [];
  let changed = false;

  for (const id of Object.keys(MODEL_MAPPING)) {
    const hops = flattenEntry(MODEL_MAPPING[id]);
    const filtered = hops.filter(h => !(h.provider === provider && h.model === model));
    if (filtered.length === hops.length) continue;
    changed = true;
    touchedIds.push(id);
    if (!filtered.length) {
      delete MODEL_MAPPING[id];
      removedIds.push(id);
    } else {
      MODEL_MAPPING[id] = nestHops(filtered);
    }
  }

  if (!changed) {
    return res.status(404).json({ error: { message: `No configured hops found for ${provider} / ${model}.`, type: 'invalid_request_error', code: 404 } });
  }

  let sync;
  try {
    sync = await saveModels(MODEL_MAPPING, `Q-Proxy admin: sync-remove ${provider}/${model}`);
  } catch (e) {
    return res.status(500).json({ error: { message: `Removed in memory but failed to write models.json: ${e.message}`, type: 'server_error', code: 500 } });
  }
  log('INFO', `[admin] sync-remove ${provider} / ${model} from ${touchedIds.length} model id(s)${sync.ok ? ' (synced to GitHub)' : ''}`);
  res.json({ ok: true, provider, model, touchedIds, removedIds, githubSync: sync });
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

async function bootstrapConfigAndStart() {
  await syncConfigFromGitHubOnBoot();

  Object.assign(REASONING_SCHEMAS, loadReasoningSchemasFromDisk());
  Object.assign(MODEL_PRESETS, loadModelPresetsFromDisk());
  MODEL_MAPPING = loadModelsFromDisk();
  hydrateUsageStateFromDisk();

  app.listen(PORT, () => {
    log('INFO', `Proxy running on port ${PORT} — mode: ${MODE}`);
    startCatalogWatch();
    // Logged once so the time zone is never a mystery when debugging: every
    // stamp in Render's console is UTC; the Admin panel shows your local time.
    log('INFO', `Server clock: ${new Date().toISOString()} | TZ env: ${process.env.TZ || '(unset → UTC)'} | zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone} — all log stamps are UTC`);
    log('INFO', `OpenRouter keys loaded: ${OPENROUTER_KEYS.length}`);
    log('INFO', `Literouter keys loaded: ${LITEROUTER_KEYS.length}`);
    log('INFO', `Model presets loaded: ${Object.keys(MODEL_PRESETS).length}`);
    log('INFO', `GitHub sync: ${GITHUB_SYNC_ENABLED ? `enabled (${GITHUB_REPO}@${GITHUB_BRANCH})` : 'disabled — admin edits will NOT survive a restart'}`);
  });
}

bootstrapConfigAndStart().catch(e => {
  log('ERROR', `Fatal error during startup: ${e.message}`);
  process.exit(1);
});


