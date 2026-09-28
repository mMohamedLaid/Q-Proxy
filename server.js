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
const RECENT_LOGS_MAX = 500;
const recentLogs = [];
function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
  recentLogs.unshift({ ts, level, msg });
  if (recentLogs.length > RECENT_LOGS_MAX) recentLogs.length = RECENT_LOGS_MAX;
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

// Both OpenRouter's and Literouter's free-tier daily caps reset on some
// wall-clock boundary. Confirmed for Literouter (docs.literouter.com/
// credits, checked Sep 2026): premium credits reset at 00:00 GMT+7,
// which is 17:00 UTC — so LITEROUTER_RESET_UTC_HOUR should be set to 17
// in the environment, not left at the default. The default here stays 0
// (plain UTC midnight) rather than being hardcoded to 17, since this is
// meant to work for any provider's boundary, confirmed or not — set the
// env var for the value that's actually been confirmed. OpenRouter's own
// boundary isn't confirmed either way, so it stays hardcoded at offset 0
// below until it is.
const LITEROUTER_RESET_UTC_HOUR = Number(process.env.LITEROUTER_RESET_UTC_HOUR ?? 0);

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
  const today = dayKeyAtUtcHourOffset(0);
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
  // all keys drained for today — hand back the last one, it'll 429 and bubble up
  return OPENROUTER_KEYS[openrouterKeyIndex];
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
    while (cur) {
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
  if (!keyInfo) return { allowed: false, reason: 'Invalid API key' };
  const now = Date.now();
  if (!usageTracker[apiKey] || now > usageTracker[apiKey].resetAt) {
    usageTracker[apiKey] = { count: 0, resetAt: now + 60000 };
  }
  if (keyInfo.limit === null || keyInfo.limit === undefined) {
    return { allowed: true, unlimited: true };
  }
  if (usageTracker[apiKey].count >= keyInfo.limit) {
    const waitSec = Math.ceil((usageTracker[apiKey].resetAt - now) / 1000);
    return { allowed: false, reason: `Rate limit hit. Try again in ${waitSec}s` };
  }
  usageTracker[apiKey].count++;
  return { allowed: true };
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
  for (const [repoPath, localPath] of [[GITHUB_MODELS_PATH, MODELS_PATH], [GITHUB_SCHEMAS_PATH, REASONING_SCHEMAS_PATH], [GITHUB_PRESETS_PATH, MODEL_PRESETS_PATH], [GITHUB_USAGE_PATH, USAGE_STATE_PATH]]) {
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

async function saveUsageState(commitMessage) {
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
    if (state.rpmCount >= hop.rpm) return { ok: false, reason: `rpm:${state.rpmCount}/${hop.rpm}` };
  }
  if (hop.tpm) {
    if (state.tpmWindowMinute !== nowMinute) { state.tpmWindowMinute = nowMinute; state.tpmTokens = 0; }
    if ((state.tpmTokens || 0) + estimatedTokens > hop.tpm) return { ok: false, reason: `tpm:${state.tpmTokens || 0}+${estimatedTokens}>${hop.tpm}` };
  }
  if (hop.rpd) {
    const today = pacificDayKey();
    if (state.rpdDay !== today) { state.rpdDay = today; state.rpdCount = 0; }
    if (state.rpdCount >= hop.rpd) return { ok: false, reason: `rpd:${state.rpdCount}/${hop.rpd}` };
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
function pickGoogleKey(model, hop, estimatedTokens) {
  if (!GOOGLE_KEYS.length) return null;
  if (!hop.rpm && !hop.tpm && !hop.rpd) {
    const idx = googleModelCursor[model] || 0;
    return { key: GOOGLE_KEYS[idx], keyIndex: idx };
  }
  maybeResetGoogleCursors();
  const startIdx = googleModelCursor[model] || 0;
  for (let i = 0; i < GOOGLE_KEYS.length; i++) {
    const idx = (startIdx + i) % GOOGLE_KEYS.length;
    if (checkGoogleWindow(model, idx, hop, estimatedTokens).ok) {
      googleModelCursor[model] = idx; // pinned here until this key specifically runs out for this model
      return { key: GOOGLE_KEYS[idx], keyIndex: idx };
    }
  }
  return null;
}

function nextLiterouterResetAt() {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(LITEROUTER_RESET_UTC_HOUR, 0, 0, 0);
  if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
  return target;
}

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
    literouter: { resetsAt: nextLiterouterResetAt().toISOString(), timezone: 'UTC', resetHour: LITEROUTER_RESET_UTC_HOUR },
    google: { resetsAt: nextGoogleResetAt().toISOString(), timezone: 'America/Los_Angeles', resetHour: 0 }
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
    while (cur) {
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
const UNLIMITED_RETRY_BUDGET_MS = 45000; // don't let one flaky hop eat more than ~45s before falling back
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
async function makeAPICall(modelId, nimRequest, stream) {
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
  for (const providerConfig of providers) {
    if (providerConfig.status && providerConfig.status !== 'active') {
      log('WARN', `Skipping ${providerConfig.provider}/${providerConfig.model} — status is "${providerConfig.status}", not "active"`);
      attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'skipped', reason: `status:${providerConfig.status}` });
      trackSkip(providerConfig.provider, providerConfig.model, `status:${providerConfig.status}`);
      continue;
    }
    if (providerConfig.tpmLimit) {
      const estimated = estimateTokens(nimRequest.messages) + (nimRequest.max_tokens || 0);
      if (estimated > providerConfig.tpmLimit) {
        log('WARN', `Skipping ${providerConfig.provider} — estimated ${estimated} tokens exceeds its ${providerConfig.tpmLimit} TPM budget`);
        attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'skipped', reason: `tpm-budget:${estimated}>${providerConfig.tpmLimit}` });
        trackSkip(providerConfig.provider, providerConfig.model, `tpm-budget (~${estimated}>${providerConfig.tpmLimit})`);
        continue;
      }
    }

    const extraBody = getReasoningBody(providerConfig);
    const body = { ...nimRequest, model: providerConfig.model, ...(extraBody || {}) };
    const unlimited = isUnlimitedRetryHop(providerConfig);
    const maxAttempts = unlimited ? (providerConfig.maxRetries || UNLIMITED_MAX_RETRIES) : 1;
    const retryBudgetMs = providerConfig.retryBudgetMs || UNLIMITED_RETRY_BUDGET_MS;
    const hopStartedAt = Date.now();
    let hopFinalError = null;
    let skippedThisHop = false;

    for (let attemptNum = 1; attemptNum <= maxAttempts; attemptNum++) {
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
        const estimatedTokens = estimateTokens(nimRequest.messages) + (nimRequest.max_tokens || 0);
        pickedGoogleKey = pickGoogleKey(providerConfig.model, providerConfig, estimatedTokens);
        if (!pickedGoogleKey) {
          log('WARN', `Skipping google/${providerConfig.model} — every Google key is out of rpm/tpm/rpd room for this model`);
          attempts.push({ provider: 'google', model: providerConfig.model, outcome: 'skipped', reason: 'google-rpm-tpm-rpd-exhausted' });
          trackSkip('google', providerConfig.model, 'google-rpm-tpm-rpd-exhausted');
          skippedThisHop = true;
          break;
        }
      }
      const { base, key } = pickedLiterouterKey
        ? { base: 'https://api.literouter.com/v1', key: pickedLiterouterKey.key }
        : pickedGoogleKey
          ? { base: GOOGLE_RELAY_BASE, key: pickedGoogleKey.key }
          : getProviderConfig(providerConfig.provider);

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
        attempts.push({
          provider: providerConfig.provider, model: providerConfig.model, outcome: 'used',
          ...(attemptNum > 1 ? { retries: attemptNum - 1 } : {})
        });
        return { response, usedProvider: providerConfig.provider, usedModel: providerConfig.model, attempts };

      } catch (err) {
        const status = err.response?.status;
        trackUsage(providerConfig.provider, providerConfig.model, false, status);
        hopFinalError = err;

        // Token-limit and quota-exhausted errors are NEVER worth retrying
        // on THIS hop — but unlike a truly malformed request, a DIFFERENT
        // hop might still handle it fine (bigger context window, or
        // actual quota left). So these always fall through to the next
        // hop instead of hard-stopping, even when the status is a 4xx
        // that would otherwise block fallback below. Checked first, on
        // purpose, before the generic hard-4xx check.
        if (await isTokenLimitError(err)) {
          log('WARN', `${providerConfig.provider}/${providerConfig.model} — request exceeds this hop's context window, not retrying it: ${err.message}`);
          attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'failed', reason: 'token-limit-exceeded' });
          trackSkip(providerConfig.provider, providerConfig.model, 'token-limit-exceeded');
          hopFinalError = err;
          break;
        }
        if (await isQuotaExhaustedError(err)) {
          log('WARN', `${providerConfig.provider}/${providerConfig.model} — quota/credits actually exhausted (even though limitType is "${providerConfig.limitType}"), not retrying: ${err.message}`);
          attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'failed', reason: 'quota-exhausted' });
          trackSkip(providerConfig.provider, providerConfig.model, 'quota-exhausted');
          hopFinalError = err;
          break;
        }

        // Genuine hard client errors (malformed request, auth failure,
        // etc.) — never retry this hop, never fall back to the next one
        // either, since the exact same broken request would just fail
        // there too.
        if (status && status >= 400 && status < 500 && status !== 429 && status !== 408 && status !== 404) {
          log('WARN', `Provider ${providerConfig.provider} returned ${status} (client error) — not falling back`);
          attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'failed', reason: `http-${status}` });
          err.attempts = attempts;
          throw err;
        }

        const elapsed = Date.now() - hopStartedAt;
        const reason = status === 429 ? 'rate-limited (429)' : status ? `http-${status}` : (err.code || 'network/timeout');
        const budgetLeft = elapsed < retryBudgetMs;
        const attemptsLeft = attemptNum < maxAttempts;

        if (unlimited && budgetLeft && attemptsLeft) {
          const delay = backoffDelayMs(attemptNum);
          log('WARN', `${providerConfig.provider}/${providerConfig.model} attempt ${attemptNum}/${maxAttempts} failed [${reason}] — "unlimited" hop, retrying in ${delay}ms (${elapsed}ms into a ${retryBudgetMs}ms budget)...`);
          await sleep(delay);
          continue;
        }

        const triedNote = attemptNum > 1 ? ` after ${attemptNum} attempts over ${elapsed}ms` : '';
        log('WARN', `${providerConfig.provider}/${providerConfig.model} failed [${reason}]${triedNote} — trying fallback...`);
        attempts.push({ provider: providerConfig.provider, model: providerConfig.model, outcome: 'failed', reason: `${reason}${triedNote}` });
        trackSkip(providerConfig.provider, providerConfig.model, reason);
        break;
      }
    }
    lastError = hopFinalError;
  }
  if (!lastError) {
    lastError = new Error('No active hop available for this model (all hops are inactive, skipped, or over their TPM budget).');
    lastError.response = { status: 503 };
  }
  lastError.attempts = attempts;
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
});;

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
      temperature: temperature || 0.6,
      max_tokens: clientRequestedTokens || hopDefaultTokens,
      stream: stream || false
    };

    const { response, usedProvider, usedModel, attempts } = await makeAPICall(model, nimRequest, stream || false);
    log('INFO', `[${userName}] → provider: ${usedProvider} | model: ${usedModel}`);

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
      let accumRaw = '';
      // Aggregated instead of logged per-chunk (see below) — a normal
      // stream is hundreds of chunks, and logging every single one was
      // flooding the log view badly enough to bury everything else.
      const streamStartedAt = Date.now();
      let chunkCount = 0;
      let contentChars = 0;
      let reasoningChars = 0;
      let parseErrorCount = 0;
      let lastParseError = null;
      const DEBUG_STREAM_CHUNKS = process.env.DEBUG_STREAM_CHUNKS === 'true';

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
            chunkCount++;
            contentChars += rawContent.length;
            if (nativeReasoning) reasoningChars += nativeReasoning.length;

            // Opt-in only (DEBUG_STREAM_CHUNKS=true) — full per-chunk
            // detail for when you're actually debugging the think-tag
            // splitting logic below, not something that runs by default.
            if (DEBUG_STREAM_CHUNKS) {
              log('DEBUG', `[CHUNK] native_reasoning: ${JSON.stringify(nativeReasoning?.slice(0, 80))} | content: ${JSON.stringify(rawContent?.slice(0, 80))}`);
            }

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
                reasoningChars += reasoningText.length;

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
            // Same aggregation logic — a single malformed/split chunk
            // boundary used to log its own ERROR line; now it's counted
            // and reported once in the summary line at 'end', with just
            // the last error's message kept as a sample.
            parseErrorCount++;
            lastParseError = e.message;
            res.write(line + '\n');
          }
        });
      });

      response.data.on('end', () => {
        const ms = Date.now() - streamStartedAt;
        const errSuffix = parseErrorCount ? ` | ${parseErrorCount} chunk parse error(s), last: ${lastParseError}` : '';
        log('INFO', `[${userName}] ✓ stream complete — ${chunkCount} chunks, ${contentChars} content chars${reasoningChars ? `, ${reasoningChars} reasoning chars` : ''}, ${ms}ms${errSuffix}`);
        res.end();
      });
      response.data.on('error', (err) => {
        log('ERROR', `[${userName}] stream error after ${chunkCount} chunks: ${err.message}`);
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
    const errorBody = truncateForLog(await getErrorBodyText(error));
    log('ERROR', `[${userName}] ${error.message} | status: ${error.response?.status} | body: ${errorBody}`);
    if (Array.isArray(error.attempts) && error.attempts.length) {
      const pathStr = error.attempts.map(a => `${a.provider}/${a.model}:${a.outcome}${a.reason ? `(${a.reason})` : ''}`).join(' -> ');
      res.setHeader('X-QProxy-Fallback-Path', pathStr);
    }
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      },
      ...(Array.isArray(error.attempts) && error.attempts.length ? { attempts: error.attempts } : {})
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
  const limit = Math.min(Number(req.query.limit) || RECENT_LOGS_MAX, RECENT_LOGS_MAX);
  const filtered = level ? recentLogs.filter(l => l.level === level) : recentLogs;
  // recentLogs is newest-first internally (that's what makes capping via
  // recentLogs.length = MAX correctly drop the OLDEST entries) — but
  // that's an implementation detail. Take the most recent `limit`
  // entries, then flip to oldest-first before sending, so the client can
  // just render top-to-bottom like every other log viewer/terminal,
  // instead of newest-on-top which reads backwards.
  const mostRecent = filtered.slice(0, limit);
  res.json({ logs: mostRecent.reverse(), total: recentLogs.length, capacity: RECENT_LOGS_MAX });
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
const LITEROUTER_KNOWN_MODELS = {
  'deepseek-r1-0528': { freeDailyCap: null, premiumBasic: true, premiumCost: 1.4, uncensored: true },
  'deepseek-r1': { freeDailyCap: null, premiumBasic: true, premiumCost: 1.4, uncensored: true },
  'deepseek-reasoner': { freeDailyCap: null, premiumBasic: true, premiumCost: 1.4, uncensored: true },
  'deepseek-v3-0324': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'deepseek-v3.1-terminus': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'deepseek-v3.1': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'deepseek-v3.2': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'deepseek-v3': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'deepseek-v4-flash-0731': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'deepseek-v4-flash': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'deepseek-v4.1-flash': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'gemini-2.5-flash-lite': { freeDailyCap: 100, premiumBasic: true, premiumCost: 1.1, uncensored: false },
  'gemini-2.5-flash': { freeDailyCap: 100, premiumBasic: true, premiumCost: 1.4, uncensored: false },
  'gemini-2.5-flash-thinking': { freeDailyCap: null, premiumBasic: true, premiumCost: 1.4, uncensored: false },
  'gemini-3-flash-preview': { freeDailyCap: null, premiumBasic: true, premiumCost: 1.8, uncensored: false },
  'gemini-3-flash-preview-thinking': { freeDailyCap: null, premiumBasic: true, premiumCost: 1.8, uncensored: false },
  'gemini-3.1-flash-lite': { freeDailyCap: null, premiumBasic: true, premiumCost: 1.8, uncensored: false },
  'gemini-3.1-flash-lite-thinking': { freeDailyCap: null, premiumBasic: true, premiumCost: 1.8, uncensored: false },
  'gemma-3-27b-it': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'gemma-4-26b-a4b-it': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'gemma-4-31b-it': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'gemma-4-31b': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'glm-4.6': { freeDailyCap: 100, premiumBasic: false, premiumCost: null, uncensored: null },
  'glm-4.7-flash': { freeDailyCap: 100, premiumBasic: true, premiumCost: 1, uncensored: true },
  'glm-4.7': { freeDailyCap: 100, premiumBasic: false, premiumCost: null, uncensored: null },
  'glm-5.1-cheap': { freeDailyCap: 100, premiumBasic: false, premiumCost: null, uncensored: null },
  'glm-5.1': { freeDailyCap: 100, premiumBasic: false, premiumCost: null, uncensored: null },
  'glm-5.2-cheap': { freeDailyCap: 100, premiumBasic: false, premiumCost: null, uncensored: null },
  'glm-5.2': { freeDailyCap: 100, premiumBasic: false, premiumCost: null, uncensored: null },
  'glm-5.3-cheap': { freeDailyCap: 100, premiumBasic: false, premiumCost: null, uncensored: null },
  'glm-5.3-flash': { freeDailyCap: null, premiumBasic: true, premiumCost: 2, uncensored: true },
  'glm-5.3-flash-cheap': { freeDailyCap: null, premiumBasic: true, premiumCost: 1.8, uncensored: true },
  'glm-5': { freeDailyCap: 100, premiumBasic: false, premiumCost: null, uncensored: null },
  'gpt-oss-120b': { freeDailyCap: 100, premiumBasic: true, premiumCost: 1, uncensored: false },
  'gpt-oss-20b': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: false },
  'kimi-k2.6-cheap': { freeDailyCap: 30, premiumBasic: false, premiumCost: null, uncensored: null },
  'kimi-k2.7-code-cheap': { freeDailyCap: 30, premiumBasic: false, premiumCost: null, uncensored: null },
  'l3-8b-lunaris': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'llama-3-8b-instruct': { freeDailyCap: null, premiumBasic: false, premiumCost: null, uncensored: true },
  'llama-3.3-70b-instruct-turbo': { freeDailyCap: null, premiumBasic: false, premiumCost: null, uncensored: true },
  'minimax-m2.7': { freeDailyCap: 100, premiumBasic: false, premiumCost: null, uncensored: null },
  'ministral-3b-2512': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'ministral-8b-2512': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'mistral-large-2512': { freeDailyCap: 100, premiumBasic: true, premiumCost: 1.8, uncensored: true },
  'mistral-large-3': { freeDailyCap: 100, premiumBasic: true, premiumCost: 1.8, uncensored: true },
  'mistral-medium-2508': { freeDailyCap: 100, premiumBasic: true, premiumCost: 1, uncensored: true },
  'mistral-small-2603': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'mythomax-l2-13b': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'qwen3.6-27b': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'qwen3.8-27b': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: true },
  'command-a': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: false },
  'command-a-reasoning': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: false },
  'command-a-vision': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: false },
  'command-r': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: false },
  'command-r-7b': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: false },
  'command-r-plus': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: false },
  'phi-4-mini-instruct': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: false },
  'step-3.5-flash': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: false },
  'step-3.5-flash-non-reasoning': { freeDailyCap: null, premiumBasic: true, premiumCost: 1, uncensored: false },
};

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

function flattenEntry(entry) {
  const hops = [];
  let cur = entry;
  while (cur) {
    hops.push({
      model: cur.model || '',
      provider: cur.provider || 'nvidia',
      reasoningSchema: cur.reasoningSchema || null,
      reasoning: cur.reasoning || null,
      status: cur.status || 'active',
      limitType: cur.limitType || 'rate-limited',
      notes: cur.notes,
      tpmLimit: cur.tpmLimit,
      dailyCap: cur.dailyCap,
      literouterTier: cur.literouterTier || null,
      rpm: cur.rpm,
      tpm: cur.tpm,
      rpd: cur.rpd,
      timeoutMs: cur.timeoutMs,
      freeUntil: cur.freeUntil,
      deprecatedOn: cur.deprecatedOn,
      retryAsUnlimited: cur.retryAsUnlimited
    });
    cur = cur.fallback || null;
  }
  return hops;
}

function nestHops(hops) {
  let result = null;
  for (let i = hops.length - 1; i >= 0; i--) {
    const h = hops[i];
    const item = {
      model: h.model,
      provider: h.provider,
      reasoningSchema: h.reasoningSchema || null,
      reasoning: h.reasoning || null,
      status: h.status || 'active',
      limitType: h.limitType || 'rate-limited'
    };
    if (h.notes) item.notes = h.notes;
    if (h.tpmLimit !== undefined) item.tpmLimit = h.tpmLimit;
    if (h.dailyCap !== undefined && h.dailyCap !== null) item.dailyCap = h.dailyCap;
    if (h.literouterTier) item.literouterTier = h.literouterTier;
    if (h.rpm !== undefined && h.rpm !== null) item.rpm = h.rpm;
    if (h.tpm !== undefined && h.tpm !== null) item.tpm = h.tpm;
    if (h.rpd !== undefined && h.rpd !== null) item.rpd = h.rpd;
    if (h.timeoutMs !== undefined) item.timeoutMs = h.timeoutMs;
    if (h.freeUntil) item.freeUntil = h.freeUntil;
    if (h.deprecatedOn) item.deprecatedOn = h.deprecatedOn;
    if (typeof h.retryAsUnlimited === 'boolean') item.retryAsUnlimited = h.retryAsUnlimited;
    if (result) item.fallback = result;
    result = item;
  }
  return result;
}

function buildSuggestedModelId(provider, model) {
  const base = String(model || '')
    .toLowerCase()
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
      for (const id of newlyAvailable) {
        const isFree = id.endsWith(':free');
        const known = literouterKnownInfo(id);
        modelInfo[id] = isFree
          ? { tier: 'free', cost: null, uncensored: known ? known.uncensored : null }
          : known
            ? { tier: known.premiumBasic ? 'premium' : 'inaccessible', cost: known.premiumCost, uncensored: known.uncensored }
            : { tier: 'unknown', cost: null, uncensored: null };
      }
    } else {
      for (const id of newlyAvailable) modelInfo[id] = { tier: 'unknown', cost: null, uncensored: null };
    }

    res.json({ provider, liveCount: liveIds.length, newlyAvailable, noLongerListed, modelInfo, partialNote: PARTIAL_SYNC_NOTES[provider] || null });
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

  const safeId = (id && String(id).trim()) || buildSuggestedModelId(provider, model);
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
  const preset = MODEL_PRESETS[presetKeyFor(provider, model.trim())];
  const usedPreset = Boolean(preset) && !reasoningOverride;
  const usedDetection = Boolean(reasoningOverride && typeof reasoningOverride === 'object' && reasoningOverride.reasoningSchema);
  const src = usedDetection ? reasoningOverride : preset;
  MODEL_MAPPING[safeId] = {
    model: model.trim(),
    provider,
    reasoningSchema: src?.reasoningSchema ?? inferReasoningSchema(provider, model.trim()),
    reasoning: src?.reasoning ? JSON.parse(JSON.stringify(src.reasoning)) : {},
    ...(src?.reasoningFieldEnabled ? { reasoningFieldEnabled: JSON.parse(JSON.stringify(src.reasoningFieldEnabled)) } : {}),
    ...(src?.reasoningFieldKeys ? { reasoningFieldKeys: JSON.parse(JSON.stringify(src.reasoningFieldKeys)) } : {}),
    ...(src?.reasoningFieldTransport ? { reasoningFieldTransport: JSON.parse(JSON.stringify(src.reasoningFieldTransport)) } : {}),
    ...(src?.reasoningFieldOptions ? { reasoningFieldOptions: JSON.parse(JSON.stringify(src.reasoningFieldOptions)) } : {}),
    ...(preset?.notes && !usedDetection ? { notes: preset.notes } : {}),
    status: (status || 'active'),
    limitType: (limitType || 'rate-limited')
  };
  let sync;
  try {
    sync = await saveModels(MODEL_MAPPING, `Q-Proxy admin: sync-add "${safeId}"${usedDetection ? ' (from detected example)' : usedPreset ? ' (from preset)' : ''}`);
  } catch (e) {
    delete MODEL_MAPPING[safeId];
    return res.status(500).json({ error: { message: `Added in memory but failed to write models.json: ${e.message}`, type: 'server_error', code: 500 } });
  }
  log('INFO', `[admin] sync-add "${safeId}" (${provider} / ${model})${usedDetection ? ' — applied detected example config' : usedPreset ? ' — applied saved preset' : ''}${sync.ok ? ' (synced to GitHub)' : ''}`);
  res.json({ ok: true, id: safeId, entry: MODEL_MAPPING[safeId], usedPreset, usedDetection, githubSync: sync });
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

