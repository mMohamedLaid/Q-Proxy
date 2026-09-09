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

- **OpenRouter** gives one blanket 50-requests/day budget per key, covering every model. Q-Proxy drains key 1 fully before moving to key 2, resetting daily. This is a Q-Proxy-side counter, not synced with OpenRouter's own dashboard — a process restart resets it to 0 even if real usage wasn't.
- **Literouter** gives each free model its *own* separate daily budget per key (e.g. `claude-haiku-4.5-cheap:free` might cap at 5/day while `qwen3.5:free` caps at 30/day on the exact same key). So Q-Proxy tracks usage per **(key, model)** pair, not per key alone — draining a key's `claude-haiku-4.5-cheap` allowance has no effect on that same key's `qwen3.5` allowance. Set `dailyCap` on a Literouter hop in `models.json` to the number Literouter's dashboard shows for that model; leave it unset if Literouter lists it as unlimited (then the hop just round-robins across keys with no cap tracking). When every configured key is out of quota for a given model today, that hop is skipped (not errored) and the chain falls through to its next hop, same as a TPM-budget skip. Usage shows up in `/health` (`literouter_capped_models`) and the Admin dashboard's Usage tab (per model, per key, e.g. "LITEROUTER_KEY_1: 3/5  LITEROUTER_KEY_2: 0/5").

Literouter has no request-time reasoning parameters at all (no `chat_template_kwargs`, no `extra_body`) — thinking on/off is picked via the model slug itself (e.g. a `-thinking` or `-non-reasoning` suffix on the model name), so Literouter hops should always leave `reasoningSchema` unset.

## Model Presets

Save a hop's current reasoning config (schema + values) as a named preset keyed to its provider/model, then reapply it to any other hop using the same provider/model without retyping it. Presets are stored in `model-presets.json`, GitHub-synced the same way `models.json` is (see below) when `GITHUB_TOKEN`/`GITHUB_REPO` are set. Missing the file entirely is fine — Q-Proxy logs a warning and starts with none.

## Auto-detect reasoning schema

In the Admin hop editor, paste a provider's example request (curl, Python SDK snippet, raw JSON) into the detect panel and Q-Proxy will try to infer the right reasoning transport and field names from it, rather than you hand-building a schema from scratch. Useful for a newly-added model whose docs use unfamiliar parameter names.

## Custom bundles

A hop chain can be flagged `"custom": true` to group it under its own "Custom bundles" tab in the Admin dashboard, separate from its provider's tab — for hand-assembled multi-provider fallback chains you want to find quickly rather than hunting through whichever provider its first hop happens to use.

## Persistence

Render's Free web services have **no persistent disk** — every restart (a crash, a `git push` redeploy, or Render just cycling an idle instance) boots a fresh container from the last *deployed* image. Anything the Admin panel wrote with `fs.writeFileSync` is gone at that point; the container never had it to begin with.

**Free fix: GitHub sync.** Set these two environment variables in Render and every Admin-panel save (models, reasoning schemas) is committed straight to your GitHub repo, in addition to being written locally. On boot, the server pulls the latest committed copy from GitHub *before* loading local files, so a fresh container starts from your last saved state instead of whatever was baked into the last code deploy.

| Env var | Required | Notes |
|---|---|---|
| `GITHUB_TOKEN` | yes | A GitHub [fine-grained personal access token](https://github.com/settings/tokens?type=beta) scoped to just this repo, with **Contents: Read and write** permission. Free to create. |
| `GITHUB_REPO` | yes | `your-username/your-repo-name` |
| `GITHUB_BRANCH` | no | Defaults to `main` |
| `GITHUB_MODELS_PATH` | no | Defaults to `models.json` |
| `GITHUB_SCHEMAS_PATH` | no | Defaults to `reasoning-schemas.json` |

If these aren't set, Q-Proxy runs exactly as before — local-disk-only, edits lost on restart — and logs a warning on boot so that's obvious rather than something you find out the hard way. The Admin panel also shows a banner at the top of the dashboard reflecting whether sync is on.

A GitHub push failure (bad token, rate limit, network blip) never blocks the local save or breaks the request — the Admin panel just tells you the edit is local-only and will not survive a restart, so you know to retry or check the token before you rely on it.

Costs nothing: GitHub API access is free for personal repos, and the write happens from the already-running Render Free service — no new infrastructure.
