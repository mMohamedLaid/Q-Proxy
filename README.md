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
