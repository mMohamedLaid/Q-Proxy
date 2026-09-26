# Q-Proxy

OpenAI-compatible fallback router across the configured providers.

## Reasoning configuration

Reasoning is configured through reusable **reasoning schemas**, not vendor/model names. A model hop can select a `reasoningSchema` and store the current values under `reasoning`.

A schema describes the actual request interface, for example:

- `chat_template_kwargs` fields such as `enable_thinking`
- top-level fields such as `reasoning_effort`
- arbitrary JSON through the raw chat-template/top-level schemas

The Admin editor reads these schemas and generates only the controls that the selected schema exposes. If no schema is selected, Q-Proxy sends no reasoning override and leaves the provider/model default alone.

Schemas can also contain optional model-match rules. Those are data in `reasoning-schemas.json`, not hard-coded vendor checks in `server.js`. This lets a new model automatically inherit a schema when its model identifier matches a rule, while an explicit model assignment can still override it.

## Adding a new reasoning interface

Add a new entry to `reasoning-schemas.json` with a unique ID, a request transport (`chat_template_kwargs` or `top_level`), and the fields you want exposed in the Admin editor. Use the raw schemas when a new model has parameters you do not want to turn into structured controls yet.

## Provider credits / quotas

Credit tracking is provider-agnostic. `PROVIDER_QUOTAS_JSON` can optionally define soft daily/monthly token limits for any provider when you actually know such a quota exists. The proxy never invents a provider balance. OpenRouter's request rotation remains a separate Q-Proxy-side 50/day/key counter.

## OpenRouter and Literouter keys

Both are configured as `OPENROUTER_KEY_1`, `OPENROUTER_KEY_2`, ... and `LITEROUTER_KEY_1`, `LITEROUTER_KEY_2`, ... — add as many as you have; there's no fixed cap, and the numbers don't need to be contiguous. Each list is scanned from the environment at boot and rotated independently.

The two providers' quotas work differently, so they're tracked differently:

- **OpenRouter** gives one blanket 50-requests/day budget per key, covering every model. Q-Proxy drains key 1 fully before moving to key 2, resetting daily. This counter now survives a restart via GitHub sync (see Persistence, below) — it isn't synced with OpenRouter's own dashboard, so it can still drift if you burn quota some other way (testing a key directly, say), but a Render restart alone no longer resets it to 0.
- **Literouter** gives each free model its *own* separate daily budget per key (e.g. `claude-haiku-4.5-cheap:free` might cap at 5/day while `qwen3.5:free` caps at 30/day on the exact same key). So Q-Proxy tracks usage per **(key, model)** pair, not per key alone — draining a key's `claude-haiku-4.5-cheap` allowance has no effect on that same key's `qwen3.5` allowance. Set `dailyCap` on a Literouter hop in `models.json` to the number Literouter's dashboard shows for that model; leave it unset if Literouter lists it as unlimited (then the hop just round-robins across keys with no cap tracking). When every configured key is out of quota for a given model today, that hop is skipped (not errored) and the chain falls through to its next hop, same as a TPM-budget skip. Usage shows up in `/health` (`literouter_capped_models`) and the Admin dashboard's Usage tab (per model, per key, e.g. "LITEROUTER_KEY_1: 3/5  LITEROUTER_KEY_2: 0/5"). This counter is also now persisted across restarts, same as OpenRouter's.
  - Literouter's own docs (docs.literouter.com/credits, checked Sep 2026) confirm the real reset time: premium credits reset at 00:00 GMT+7, which is **17:00 UTC** — set `LITEROUTER_RESET_UTC_HOUR=17` in your environment (it defaults to `0`, plain UTC midnight, until you set it; the default stays generic rather than hardcoded to 17 since this knob is meant to work for any provider's boundary once confirmed, not just this one).
  - Literouter also has a **premium credits** pool: per their docs, literally anything that isn't a `:free`-suffixed model — plain names, `:metered`, `:full-context`, `:metered:full-context` — draws from one shared pool per key instead of a per-model cap, sized by your plan (their docs: "higher plans getting more" — it's not a universal number). Q-Proxy detects this automatically from the model slug (no `:free` suffix → premium pool) rather than needing every hop tagged by hand, so it applies to models you add later too. Set `LITEROUTER_PREMIUM_DAILY_CAP` (defaults to `50`, this account's observed allowance) if a key on a different plan gets added. The actual per-request *cost* of a premium request isn't modeled yet — every request counts as 1 against the pool for now, same as the free tier's counting; real weighting (Literouter's cost calculator implies it varies by model and length) is a follow-up once there's a reliable way to pull those numbers.
  - `GET /admin/api/sync/literouter` now works the same way it does for nvidia/zai/google/openrouter — it diffs Literouter's live `/v1/models` list against what's in `models.json` and reports what's new or gone. Literouter's docs confirm this endpoint returns everything the key can reach, so the model list itself is reliable — what it still can't tell you is any of the three credit balances (free, premium, or the permanent-premium beta), so those stay Q-Proxy-side estimates.

Literouter has no request-time reasoning parameters at all (no `chat_template_kwargs`, no `extra_body`) — thinking on/off is picked via the model slug itself (e.g. a `-thinking` or `-non-reasoning` suffix on the model name), so Literouter hops should always leave `reasoningSchema` unset.

## Per-model key rotation (Literouter, Google AI Studio)

When a hop has more than one key configured and an actual limit to track, each **model** — not each provider — keeps its own key until that key specifically runs out for that model, then moves only that model to the next key. Other models on the same provider are unaffected and keep whatever key they're each individually on. All models revert to key 1 at the provider's own daily reset. Concretely:

- **Literouter free tier**: per-(key, model) `dailyCap`, as described above — this now has its own per-model cursor (`model -> keyIndex`) instead of one shared rotation counter, so one model draining a key no longer shifts which key a completely different model starts trying next.
- **Google AI Studio**: new — set `GOOGLE_KEY_1`, `GOOGLE_KEY_2`, ... (same numbered convention as OpenRouter/Literouter; the old singular `GOOGLE_API_KEY` still works untouched as key 1 if you don't add numbered keys) and set `rpm`, `tpm`, and/or `rpd` on a hop to whatever Google's docs list for that specific model. Only the dimensions you actually set get checked — a hop with none of the three behaves exactly as before (unlimited, no tracking). Google's free-tier reset is midnight **Pacific Time**, which shifts between UTC-7 and UTC-8 with daylight saving — this is computed with real timezone-aware logic, not a fixed offset, so it doesn't drift across the March/November DST changes the way a naive UTC-hour trick would.
- The Admin dashboard's model list shows a live countdown to the next reset when you're on the Literouter or Google tab specifically (server sends one absolute timestamp; the page just ticks down to it — no per-provider timezone math happens in the browser).

## Literouter: Premium Basic reference table, and what the credits actually cost

Confirmed from Literouter's own docs (docs.literouter.com/credits, checked Sep 2026):

- A `:free`-suffixed model spends **free credits** — the per-(key,model) `dailyCap` tracking above.
- Everything else — plain names, `:metered`, `:full-context`, `:metered:full-context` — spends one shared **premium credits** pool per key (`LITEROUTER_PREMIUM_DAILY_CAP`, defaults to 50 — their docs say the real allowance depends on your plan, so this isn't a universal constant). Q-Proxy detects this automatically from the model's slug — no manual tagging needed, current or future models both work.
- There's a third, **permanent premium credits** balance (private beta) that kicks in once the daily premium pool is empty — not modeled here yet.
- Premium credits reset at 00:00 GMT+7, i.e. **17:00 UTC** — set `LITEROUTER_RESET_UTC_HOUR=17` (defaults to `0` until you set it).
- What a request actually costs is **not** just the displayed per-model multiplier: it's `model_cost × optimization_cost`, where `optimization_cost` depends on the conversation's token count (weighted by message role — system messages count 3x, conversation 2x, by default, adjustable in your Literouter account) — except for `:full-context` models, where `optimization_cost` is pinned to exactly 1 regardless of length. This isn't modeled here yet either (every premium request just counts as 1 against the pool, same as OpenRouter's flat counting) — real weighting would need to either mirror Literouter's undisclosed token-counting formula or get the real number from somewhere else, which is why it's deferred rather than approximated.
- Literouter's "Premium Basic" list — the specific models reachable through the free-plan premium pool without paying, plus their cost multiplier and whether each is content-moderated — is hand-transcribed into `LITEROUTER_KNOWN_MODELS` in `server.js` (their API doesn't expose any of this). It's used only to show info in the sync-result UI before you add a model; it isn't re-derived automatically and will drift out of date, so refresh it by hand against your account's dashboard periodically. A model *outside* this table that also isn't `:free` might be a higher paid tier (Standard/Plus/Pro/Elite/Ultimate) that a free-plan key can't actually reach at all, rather than a poolable premium model — Q-Proxy can't currently tell those two cases apart.



Save a hop's current reasoning config (schema + values) as a named preset keyed to its provider/model, then reapply it to any other hop using the same provider/model without retyping it. Presets are stored in `model-presets.json`, GitHub-synced the same way `models.json` is (see below) when `GITHUB_TOKEN`/`GITHUB_REPO` are set. Missing the file entirely is fine — Q-Proxy logs a warning and starts with none.

## Auto-detect reasoning schema

In the Admin hop editor, paste a provider's example request (curl, Python SDK snippet, raw JSON) into the detect panel and Q-Proxy will try to infer the right reasoning transport and field names from it, rather than you hand-building a schema from scratch. Useful for a newly-added model whose docs use unfamiliar parameter names.

## Custom bundles

A hop chain can be flagged `"custom": true` to group it under its own "Custom bundles" tab in the Admin dashboard, separate from its provider's tab — for hand-assembled multi-provider fallback chains you want to find quickly rather than hunting through whichever provider its first hop happens to use.

## Persistence

Render's Free web services have **no persistent disk** — every restart (a crash, a `git push` redeploy, or Render just cycling an idle instance) boots a fresh container from the last *deployed* image. Anything the Admin panel wrote with `fs.writeFileSync` is gone at that point; the container never had it to begin with.

**Free fix: GitHub sync.** Set these two environment variables in Render and every Admin-panel save (models, reasoning schemas, presets) — plus the OpenRouter/Literouter usage counters, saved automatically every ~30s when they've changed — is committed straight to your GitHub repo, in addition to being written locally. On boot, the server pulls the latest committed copy from GitHub *before* loading local files, so a fresh container starts from your last saved state instead of whatever was baked into the last code deploy.

| Env var | Required | Notes |
|---|---|---|
| `GITHUB_TOKEN` | yes | A GitHub [fine-grained personal access token](https://github.com/settings/tokens?type=beta) scoped to just this repo, with **Contents: Read and write** permission. Free to create. |
| `GITHUB_REPO` | yes | `your-username/your-repo-name` |
| `GITHUB_BRANCH` | no | Defaults to `main` |
| `GITHUB_MODELS_PATH` | no | Defaults to `models.json` |
| `GITHUB_SCHEMAS_PATH` | no | Defaults to `reasoning-schemas.json` |
| `GITHUB_USAGE_PATH` | no | Defaults to `usage-state.json`. OpenRouter/Literouter usage counters — see "OpenRouter and Literouter keys," above. |
| `LITEROUTER_RESET_UTC_HOUR` | no | Defaults to `0` (UTC midnight). Confirmed real value is `17` — see "OpenRouter and Literouter keys," above. |
| `LITEROUTER_PREMIUM_DAILY_CAP` | no | Defaults to `50`. The shared daily premium-credits pool size per Literouter key; depends on your plan. |

If these aren't set, Q-Proxy runs exactly as before — local-disk-only, edits lost on restart — and logs a warning on boot so that's obvious rather than something you find out the hard way. The Admin panel also shows a banner at the top of the dashboard reflecting whether sync is on.

A GitHub push failure (bad token, rate limit, network blip) never blocks the local save or breaks the request — the Admin panel just tells you the edit is local-only and will not survive a restart, so you know to retry or check the token before you rely on it.

Costs nothing: GitHub API access is free for personal repos, and the write happens from the already-running Render Free service — no new infrastructure.

