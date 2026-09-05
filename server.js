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

// Bound but populated after the GitHub boot sync below (see
// bootstrapConfigAndStart) — REASONING_SCHEMAS stays a stable object
// reference (mutated in place) so every existing `REASONING_SCHEMAS[x]`
// read/write elsewhere in this file keeps working untouched; MODEL_MAPPING
// is reassigned wholesale on load/reload, same as before.
const REASONING_SCHEMAS = {};
let MODEL_MAPPING = {};

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
  const res = await axios.get(url, { headers: githubHeaders(), validateStatus: () => true });
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
  }, { headers: githubHeaders(), validateStatus: () => true });
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
  for (const [repoPath, localPath] of [[GITHUB_MODELS_PATH, MODELS_PATH], [GITHUB_SCHEMAS_PATH, REASONING_SCHEMAS_PATH]]) {
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

// Same base-URL resolution as getProviderConfig, but never advances the
// OpenRouter/Literouter rotation counters. Use this anywhere a key is
// needed just to make a housekeeping call (e.g. admin catalog sync) that
// isn't a real chat completion — otherwise every sync check silently
// eats into OpenRouter's real 50/day/key budget for nothing.
function getProviderConfigReadOnly(provider) {
  switch (provider) {
    case 'zai':        return { base: 'https://api.z.ai/api/paas/v4',                key: ZAI_API_KEY };
    case 'google':     return { base: GOOGLE_RELAY_BASE,                             key: GOOGLE_API_KEY };
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

  const values = {};
  for (const [fieldName, field] of Object.entries(schema.fields || {})) {
    const rawValue = configured[fieldName];

    // An explicitly blank value means "Custom was picked for this field but
    // nothing has been typed yet" — send nothing for it rather than
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

    values[fieldName] = value;
  }

  let bodyFields = values;
  if (Object.prototype.hasOwnProperty.call(values, '__raw')) {
    bodyFields = values.__raw && typeof values.__raw === 'object' ? values.__raw : {};
  }

  if (!Object.keys(bodyFields).length) return undefined;

  if (schema.transport === 'chat_template_kwargs') {
    return { chat_template_kwargs: bodyFields };
  }

  if (schema.transport === 'top_level') {
    return bodyFields;
  }

  log('WARN', `Unsupported reasoning transport "${schema.transport}" in schema "${schemaName}".`);
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
    if (providerConfig.status && providerConfig.status !== 'active') {
      log('WARN', `Skipping ${providerConfig.provider}/${providerConfig.model} — status is "${providerConfig.status}", not "active"`);
      continue;
    }
    if (providerConfig.tpmLimit) {
      const estimated = estimateTokens(nimRequest.messages) + (nimRequest.max_tokens || 0);
      if (estimated > providerConfig.tpmLimit) {
        log('WARN', `Skipping ${providerConfig.provider} — estimated ${estimated} tokens exceeds its ${providerConfig.tpmLimit} TPM budget`);
        continue;
      }
    }

    const { base, key } = getProviderConfig(providerConfig.provider);
    const extraBody = getReasoningBody(providerConfig);
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
  if (!lastError) {
    lastError = new Error('No active hop available for this model (all hops are inactive, skipped, or over their TPM budget).');
    lastError.response = { status: 503 };
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
    provider_quotas: Object.keys(PROVIDER_QUOTAS).map(getProviderQuotaSnapshot),
    openrouter_keys: orStatus,
    literouter_keys: LITEROUTER_KEYS.length
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

    const nimRequest = {
      model: mapping.model,
      messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      stream: stream || false
    };

    const { response, usedProvider, usedModel } = await makeAPICall(mapping, nimRequest, stream || false);
    log('INFO', `[${userName}] → provider: ${usedProvider} | model: ${usedModel}`);

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
//    saveModels(). See the GitHub sync notes above for what survives
//    a restart on Render Free and what doesn't.
// ============================================================
app.get('/admin/api/models', requireAdmin, (req, res) => {
  res.json({ models: MODEL_MAPPING });
});

app.post('/admin/api/models', requireAdmin, async (req, res) => {
  const { id, entry } = req.body || {};
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: { message: 'Body must include a string "id".', type: 'invalid_request_error', code: 400 } });
  }
  if (!entry || !entry.model || !entry.provider) {
    return res.status(400).json({ error: { message: 'Body must include "entry" with at least "model" and "provider".', type: 'invalid_request_error', code: 400 } });
  }
  MODEL_MAPPING[id] = entry;
  let sync;
  try {
    sync = await saveModels(MODEL_MAPPING, `Q-Proxy admin: upsert model "${id}"`);
  } catch (e) {
    return res.status(500).json({ error: { message: `Saved in memory but failed to write models.json: ${e.message}`, type: 'server_error', code: 500 } });
  }
  log('INFO', `[admin] upserted model "${id}"${sync.ok ? ' (synced to GitHub)' : ''}`);
  res.json({ ok: true, id, entry, githubSync: sync });
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

  const today = new Date().toISOString().slice(0, 10);
  const openrouterSelfTracked = OPENROUTER_KEYS.map((_, i) => ({
    key: `OPENROUTER_KEY_${i + 1}`,
    usedToday: openrouterKeyState[i].day === today ? openrouterKeyState[i].count : 0,
    cap: OPENROUTER_DAILY_CAP
  }));

  res.json({
    perKeyLimits,
    providerUsage: Object.values(providerUsage),
    openrouter: { selfTracked: openrouterSelfTracked },
    providerQuotas: Object.keys(PROVIDER_QUOTAS).map(getProviderQuotaSnapshot),
    literouterKeysLoaded: LITEROUTER_KEYS.length
  });
});;

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
// ADMIN: SYNC — ask a provider what models it actually has live
// right now and diff against what's configured. Deliberately
// does NOT auto-add or auto-remove anything: a newly-listed model
// might not actually be free, might behave differently, or might
// just be noise, so a human approves changes. This is the check
// that would have caught the glm-5.2 deprecation, and the way to
// confirm whether kimi-k3 is actually live, days ahead of time.
// ============================================================
const SYNCABLE_PROVIDERS = new Set(['nvidia', 'zai', 'google', 'openrouter']);
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
      timeoutMs: cur.timeoutMs,
      freeUntil: cur.freeUntil,
      deprecatedOn: cur.deprecatedOn
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
    if (h.timeoutMs !== undefined) item.timeoutMs = h.timeoutMs;
    if (h.freeUntil) item.freeUntil = h.freeUntil;
    if (h.deprecatedOn) item.deprecatedOn = h.deprecatedOn;
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

app.post('/admin/api/sync/:provider/add', requireAdmin, async (req, res) => {
  const provider = req.params.provider;
  if (!SYNCABLE_PROVIDERS.has(provider)) {
    return res.status(400).json({ error: { message: `Provider "${provider}" is not syncable.`, type: 'invalid_request_error', code: 400 } });
  }
  const { model, id, status, limitType } = req.body || {};
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: { message: 'Body must include a string "model".', type: 'invalid_request_error', code: 400 } });
  }

  const safeId = (id && String(id).trim()) || buildSuggestedModelId(provider, model);
  if (MODEL_MAPPING[safeId]) {
    return res.status(409).json({ error: { message: `Model id "${safeId}" already exists.`, type: 'conflict_error', code: 409 } });
  }

  MODEL_MAPPING[safeId] = {
    model: model.trim(),
    provider,
    reasoningSchema: inferReasoningSchema(provider, model.trim()),
    reasoning: {},
    status: (status || 'active'),
    limitType: (limitType || 'rate-limited')
  };
  let sync;
  try {
    sync = await saveModels(MODEL_MAPPING, `Q-Proxy admin: sync-add "${safeId}"`);
  } catch (e) {
    delete MODEL_MAPPING[safeId];
    return res.status(500).json({ error: { message: `Added in memory but failed to write models.json: ${e.message}`, type: 'server_error', code: 500 } });
  }
  log('INFO', `[admin] sync-add "${safeId}" (${provider} / ${model})${sync.ok ? ' (synced to GitHub)' : ''}`);
  res.json({ ok: true, id: safeId, entry: MODEL_MAPPING[safeId], githubSync: sync });
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
  MODEL_MAPPING = loadModelsFromDisk();

  app.listen(PORT, () => {
    log('INFO', `Proxy running on port ${PORT} — mode: ${MODE}`);
    log('INFO', `OpenRouter keys loaded: ${OPENROUTER_KEYS.length}`);
    log('INFO', `Literouter keys loaded: ${LITEROUTER_KEYS.length}`);
    log('INFO', `GitHub sync: ${GITHUB_SYNC_ENABLED ? `enabled (${GITHUB_REPO}@${GITHUB_BRANCH})` : 'disabled — admin edits will NOT survive a restart'}`);
  });
}

bootstrapConfigAndStart().catch(e => {
  log('ERROR', `Fatal error during startup: ${e.message}`);
  process.exit(1);
});
