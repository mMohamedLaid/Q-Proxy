You're taking over work on Q-Proxy, my personal OpenAI-compatible LLM router. Read this, then read the repo (GitHub connector, or I'll attach files) before changing anything. If what I attach differs from what this says, my files win. Tell me what differs.

WHAT IT IS
Node 20 + Express + axios. Files: server.js (~3000 lines), public/admin.html (single-file admin panel), models.json (hop chains with fallbacks), reasoning-schemas.json, usage-state.json, README.md. It runs on Render Free with no disk, so the Admin panel commits models.json, schemas, presets and usage-state.json to GitHub. It routes to NVIDIA NIM, Z.AI, Google AI Studio, OpenRouter and Literouter. Clients: Janitor AI, Marinara Engine, and possibly coding agents. I'm on a free Claude plan, so keep chats short and tasks small.

DONE (27-29 Sep 2026, all committed)
- max_tokens: a client sending 0 used to become 9024. Each hop can now have "maxTokens", used as a FLOOR (glm-5.3-nv = 32000). GLM-5.3 spends max_tokens on thinking AND the reply. The log shows "client sent X -> upstream got Y".
- Streaming: if the upstream stream dies without a finish_reason, the proxy sends finish_reason "length" and [DONE], and adds a visible notice when there is no reply text (STREAM_TRUNCATION_NOTICE / STREAM_LENGTH_NOTICE env vars). Admin log shows stitched THINK/REPLY blocks. Per-chunk DEBUG lines go only to the Render console. End-of-stream line shows chars, ~tokens (chars/4) and duration.
- Tool calling passthrough: tools, tool_choice, parallel_tool_calls, response_format, stop. tool_calls kept in non-stream replies. temperature 0 is respected. A hop with "tools": false is skipped for tool requests. GLM-5.3 on NIM was verified with curl.
- Retries: "unlimited" hops (NIM) get up to 100 attempts. The retry window starts at the FIRST failure. It is 45s when a fallback exists, 10 min on the last hop. It stops on client disconnect.
- Error tags: TIMEOUT, NET_RESET, RATE_LIMIT, QUOTA, CONTEXT_TOO_LONG, AUTH, BAD_REQUEST, UPSTREAM_5XX, UPSTREAM_DEGRADED, NO_HOP, TOKEN_CAP, STREAM_CUT, CLIENT_GONE and others. They appear in the logs, the X-QProxy-Error-Tag header, and the client error text, which now includes the provider's real message (also in provider_message).
- Resets are baked in, no env vars: Literouter 00:00 GMT+7 (17:00 UTC), OpenRouter 00:00 UTC, Google midnight Pacific (DST-aware). Render logs are HH:MM:SS.mmm DD-MM-YYYY UTC. The Admin panel converts to my local time (GMT+1).
- Google per-hop rpm/tpm/rpd come from the AI Studio rate-limit page (no API returns them). They are editable in the Admin form and shown as "Limits" on model cards.
- Literouter sync hides models my plan can't reach, and groups the rest into collapsible Free / Premium Basic / Unverified tiers. ":metered" and ":full-context" variants are classified by base model. That classification is an assumption.

OPEN
1. FIRST: delete TEMP_ADMIN_KEY ('123') from server.js once I say testing is done.
2. Admin "paste AI Studio limits" import that fills rpm/tpm/rpd on Google hops, with a stale-after-30-days banner.
3. Google learn-from-429: read quotaValue/quotaId from the error body. Its blind spot is that limit increases are never seen.
4. Google limits are per PROJECT, not per API key. Check that my GOOGLE_KEY_n come from different projects.
5. Unverified: NIM reports degraded endpoints as HTTP 400. The 3.1-flash-lite-preview hop uses the non-preview limits. Whether Janitor/Marinara keep a reply that ends with the length notice.

HOW TO WORK WITH ME
- I'm on Windows cmd.exe. Curl must be one line with escaped double quotes (\") and no backslash continuations.
- Read the file/section first, make targeted edits, run node --check, and test with a mocked axios (node -r mock.js) before delivering. server.js needs reasoning-schemas.json beside it and env MY_KEY, NIM_API_KEY, ADMIN_KEY to boot. Kill test servers by PID, never pkill -f with text that appears in your own command line (it kills your shell).
- Never overwrite models.json or usage-state.json wholesale, since the admin panel edits them. Merge changes into the repo's copy. Hand back only the files that changed, and say which ones.
- Don't state guesses as facts about providers or Anthropic products. Say what's verified and what's assumed.
- I prefer known facts baked in over env vars, and readable Admin logs over noisy ones (the Render console can stay noisy).
