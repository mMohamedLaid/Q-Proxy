// test/run-tests.js — boots server.js with the mocked axios and exercises
// the proxy end-to-end over real HTTP. Restores models.json byte-for-byte
// when done (the admin test adds and then deletes a scratch model).
//
//   node test/run-tests.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCEN = path.join(__dirname, 'scenario.json');
const PORT = 3113;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let serverLog = '';   // everything the server printed — so tests can check what Render would show
function check(name, cond, detail) {
  if (cond) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const setScenario = obj => fs.writeFileSync(SCEN, JSON.stringify(obj));

async function chat(body, key = 'testkey') {
  return fetch(BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(body)
  });
}

async function readSSE(res) {
  const text = await res.text();
  let done = false, content = '', reasoning = '', finish = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload.trim() === '[DONE]') { done = true; continue; }
    let j; try { j = JSON.parse(payload); } catch (_) { continue; }
    const c0 = j.choices && j.choices[0];
    if (c0 && c0.delta) {
      if (typeof c0.delta.content === 'string') content += c0.delta.content;
      if (typeof c0.delta.reasoning_content === 'string') reasoning += c0.delta.reasoning_content;
    }
    if (c0 && c0.finish_reason) finish = c0.finish_reason;
  }
  return { done, content, reasoning, finish, raw: text };
}

async function main() {
  const modelsPath = path.join(ROOT, 'models.json');
  fs.copyFileSync(modelsPath, modelsPath + '.bak');
  // usage-state.json holds the persisted Google rpm/tpm/rpd windows and the
  // real usage counters: back it up, start every run from a blank one (so a run
  // a minute after another can't inherit its token window), and restore it after.
  const usagePath = path.join(ROOT, 'usage-state.json');
  const hadUsage = fs.existsSync(usagePath);
  if (hadUsage) fs.copyFileSync(usagePath, usagePath + '.bak');
  fs.writeFileSync(usagePath, '{}');
  const limitsPath = path.join(ROOT, 'provider-limits.json');   // the Google-limits import rewrites this file
  fs.copyFileSync(limitsPath, limitsPath + '.bak');

  const child = spawn(process.execPath, ['-r', './test/mock-axios.js', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, MY_KEY: 'testkey', ADMIN_KEY: 'adminkey', NIM_API_KEY: 'nv', GOOGLE_KEY_1: 'g1', LITEROUTER_KEY_1: 'lr1', OPENROUTER_KEY_1: 'or1', ZAI_API_KEY: 'z1', QP_NO_CATALOG_WATCH: '1', QP_WAIT_NOTICE_MS: '600', PORT: String(PORT), MOCK_FILE: SCEN },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => process.stderr.write('[server] ' + d));
  const exited = new Promise(resolve => child.on('exit', resolve));

  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { const r = await fetch(BASE + '/health'); up = r.ok; if (!up) await r.text(); } catch (_) {}
      if (!up) await sleep(200);
    }
    check('server booted', up);
    if (!up) throw new Error('server did not boot');

    // ── auth / validation ─────────────────────────────────────────────
    let r = await chat({ model: 'gemma-4-31b-nv', messages: [{ role: 'user', content: 'hi' }] }, 'wrongkey');
    check('invalid key -> 401 (not 429)', r.status === 401, 'got ' + r.status);
    await r.text();

    r = await chat({ model: 'gemma-4-31b-nv' });
    check('missing messages -> 400', r.status === 400, 'got ' + r.status);
    await r.text();

    r = await chat({ messages: [{ role: 'user', content: 'hi' }] });
    check('missing model -> 400', r.status === 400, 'got ' + r.status);
    await r.text();

    // ── non-stream ────────────────────────────────────────────────────
    setScenario({ mode: 'nonstream', json: { choices: [{ message: { role: 'assistant', content: '\n<think>secret plan</think>\n\nVisible answer' }, finish_reason: null }], usage: { total_tokens: 7 } } });
    r = await chat({ model: 'gemma-4-31b-nv', messages: [{ role: 'user', content: 'hi' }] });
    let j = await r.json();
    check('non-stream think split (leading whitespace tag)',
      j.choices?.[0]?.message?.reasoning_content === 'secret plan' && j.choices?.[0]?.message?.content === 'Visible answer',
      JSON.stringify(j.choices?.[0]?.message));
    check('non-stream finish_reason defaults to stop', j.choices?.[0]?.finish_reason === 'stop', String(j.choices?.[0]?.finish_reason));

    setScenario({ mode: 'nonstream', json: { choices: [{ message: { role: 'assistant', content: 'A', reasoning: 'orr' }, finish_reason: 'stop' }], usage: {} } });
    r = await chat({ model: 'gemma-4-31b-nv', messages: [{ role: 'user', content: 'hi' }] });
    j = await r.json();
    check('non-stream OpenRouter reasoning string field', j.choices?.[0]?.message?.reasoning_content === 'orr', JSON.stringify(j.choices?.[0]?.message));

    // ── streaming ─────────────────────────────────────────────────────
    setScenario({
      mode: 'stream', endMode: 'end',
      chunks: [
        { id: '1', choices: [{ delta: { role: 'assistant', content: '<thi' }, finish_reason: null }] },
        { id: '1', choices: [{ delta: { content: 'nk>plan</thi' }, finish_reason: null }] },
        { id: '1', choices: [{ delta: { content: 'nk>ok then' }, finish_reason: null }] },
        { id: '1', choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]'
      ]
    });
    r = await chat({ model: 'gemma-4-31b-nv', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    let s = await readSSE(r);
    check('stream: split-tag reasoning stitched', s.reasoning.includes('plan'), JSON.stringify(s.reasoning));
    check('stream: split-tag first fragment NOT leaked as reply', s.content.trim() === 'ok then', JSON.stringify(s.content));
    check('stream: finish stop + [DONE]', s.finish === 'stop' && s.done, `finish=${s.finish} done=${s.done}`);

    setScenario({
      mode: 'stream', endMode: 'close',
      chunks: [
        { id: '2', choices: [{ delta: { role: 'assistant', content: 'Hel' }, finish_reason: null }] },
        { id: '2', choices: [{ delta: { content: 'lo' }, finish_reason: null }] }
      ]
    });
    r = await chat({ model: 'gemma-4-31b-nv', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    s = await readSSE(r);
    check('stream: premature close (close-only) closed out with finish length', s.finish === 'length', String(s.finish));
    check('stream: premature close keeps delivered content', s.content.trim() === 'Hello', JSON.stringify(s.content));
    check('stream: premature close sends [DONE]', s.done);

    setScenario({ mode: 'stream', endMode: 'close', chunks: [] });
    r = await chat({ model: 'gemma-4-31b-nv', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    s = await readSSE(r);
    check('stream: premature close w/ no reply gets visible notice', s.content.includes('Connection to the model closed'), JSON.stringify(s.content));
    check('stream: premature close empty -> finish length + [DONE]', s.finish === 'length' && s.done, `finish=${s.finish} done=${s.done}`);

    setScenario({
      mode: 'stream', endMode: 'end',
      chunks: [
        { id: '3', choices: [{ delta: { role: 'assistant', reasoning: 'thinky', content: 'A' }, finish_reason: null }] },
        { id: '3', choices: [{ delta: {}, finish_reason: 'stop' }] },
        '[DONE]'
      ]
    });
    r = await chat({ model: 'gemma-4-31b-nv', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    s = await readSSE(r);
    check('stream: OpenRouter reasoning string treated as reasoning', s.reasoning.includes('thinky'), JSON.stringify(s.reasoning));
    check('stream: OpenRouter reply intact', s.content.includes('A'), JSON.stringify(s.content));

    // ── /health usage counting ────────────────────────────────────────
    r = await fetch(BASE + '/health');
    j = await r.json();
    const me = (j.users || []).find(u => u.name === 'me');
    check('/health now counts unlimited-key usage', me && me.used >= 1, JSON.stringify(j.users));

    // ── admin: sync-remove must not drop hop fields ───────────────────
    const admin = { 'X-Admin-Key': 'adminkey', 'Content-Type': 'application/json' };
    r = await fetch(BASE + '/admin/api/models', {
      method: 'POST', headers: admin,
      body: JSON.stringify({
        id: 'zz-test',
        entry: {
          model: 'nv-model', provider: 'nvidia', status: 'active', limitType: 'rate-limited',
          custom: true, maxTokens: 32000, tools: false, retryBudgetMs: 12345, maxRetries: 7,
          reasoningFieldKeys: { enable_thinking: 'thinking' },
          fallback: { model: 'test:free', provider: 'literouter', status: 'active', limitType: 'rate-limited' }
        }
      })
    });
    j = await r.json();
    check('admin: scratch model added', r.ok, JSON.stringify(j));

    r = await fetch(BASE + '/admin/api/sync/literouter/remove', {
      method: 'POST', headers: admin, body: JSON.stringify({ model: 'test:free' })
    });
    j = await r.json();
    check('admin: sync-remove ran', r.ok, JSON.stringify(j));

    r = await fetch(BASE + '/admin/api/models', { headers: admin });
    j = await r.json();
    const kept = j.models['zz-test'];
    check('sync-remove: survives as single-hop entry', !!kept && !kept.fallback, JSON.stringify(kept));
    check('sync-remove: custom flag kept', kept?.custom === true, JSON.stringify(kept));
    check('sync-remove: maxTokens floor kept', kept?.maxTokens === 32000, JSON.stringify(kept));
    check('sync-remove: tools:false kept', kept?.tools === false, JSON.stringify(kept));
    check('sync-remove: retryBudgetMs kept', kept?.retryBudgetMs === 12345, JSON.stringify(kept));
    check('sync-remove: maxRetries kept', kept?.maxRetries === 7, JSON.stringify(kept));
    check('sync-remove: reasoningFieldKeys kept', kept?.reasoningFieldKeys?.enable_thinking === 'thinking', JSON.stringify(kept));

    r = await fetch(BASE + '/admin/api/models/zz-test', { method: 'DELETE', headers: admin });
    check('admin: scratch model deleted', r.ok, String(r.status));
    await r.text();

    // ── streaming tool calls must pass through (regression: the think-tag
    //    hold-back used to swallow chunks that carry no text) ────────────
    setScenario({
      mode: 'stream', endMode: 'end',
      chunks: [
        { id: 't', choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }] },
        { id: 't', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Algiers"}' } }] }, finish_reason: null }] },
        { id: 't', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]'
      ]
    });
    r = await chat({ model: 'gemma-4-31b-nv', stream: true, messages: [{ role: 'user', content: 'weather?' }], tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: {} } } }] });
    s = await readSSE(r);
    check('stream: tool_call delta delivered', s.raw.includes('get_weather') && s.raw.includes('call_1'), s.raw.slice(0, 300));
    check('stream: tool_calls finish + [DONE]', s.finish === 'tool_calls' && s.done, `finish=${s.finish} done=${s.done}`);

    // ── Google TPM counts INPUT tokens only (regression: max_tokens was added
    //    to the estimate, so a ~9.5K prompt + the 9024 fallback = "18.5K > 14K"
    //    and the hop was skipped with NO_HOP) ──────────────────────────
    const admin2 = { 'X-Admin-Key': 'adminkey', 'Content-Type': 'application/json' };
    r = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({
      id: 'zz-google-tpm', entry: { model: 'gemma-4-31b-it', provider: 'google', status: 'active', limitType: 'rate-limited', tpmLimit: 14000, rpm: 30, tpm: 16000, rpd: 14400 } }) });
    check('tpm: scratch google model added', r.ok); await r.text();
    const bigMsg = tokens => [{ role: 'user', content: 'x'.repeat(tokens * 4) }];
    setScenario({ mode: 'nonstream', json: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} } });
    r = await chat({ model: 'zz-google-tpm', max_tokens: 0, messages: bigMsg(9500) });
    check('tpm: ~9.5K-token prompt with max_tokens 0 passes (was NO_HOP)', r.status === 200, 'got ' + r.status + ' ' + (await r.text()).slice(0, 300));
    r = await chat({ model: 'zz-google-tpm', max_tokens: 0, messages: bigMsg(15000) });
    j = await r.json().catch(() => ({}));
    check('tpm: 15K-token prompt (over the 14K request cap) is skipped -> 503', r.status === 503, 'got ' + r.status);
    check('NO_HOP single hop: pinpoints the numbers, says nothing about hops/chains/attempts',
      /^\[Q-Proxy · NO_HOP\] google\/gemma-4-31b-it was skipped — request ≈ 15,0\d\d input tokens is over the max request size of 14,000 set for this model$/.test(j.error?.message || '') && !('attempts' in j) && !/\bhops?\b|chain|budget/i.test(j.error?.message || ''), JSON.stringify(j));
    check('NO_HOP: a prompt too big to EVER fit gets no "try again" hint', j.error?.retry_after_s === undefined);
    // "14K used, then a 3K message can't pass" — retry the pair once if the minute rolled over between them
    r = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({
      id: 'zz-google-win', entry: { model: 'gemma-4-31b-it-win', provider: 'google', status: 'active', limitType: 'rate-limited', tpmLimit: 14000, rpm: 30, tpm: 16000, rpd: 14400 } }) }); await r.text();
    let windowBlocked = false, secondBody = '';
    for (let tries = 0; tries < 2 && !windowBlocked; tries++) {
      const first = await chat({ model: 'zz-google-win', max_tokens: 0, messages: bigMsg(12000) }); await first.text();
      const second = await chat({ model: 'zz-google-win', max_tokens: 0, messages: bigMsg(6000) });
      secondBody = await second.text();
      windowBlocked = second.status === 503;
    }
    check('tpm: rolling minute budget — 12K used, +6K would exceed 16K -> blocked', windowBlocked, secondBody.slice(0, 200));
    let blockJ = {}; try { blockJ = JSON.parse(secondBody); } catch (_) {}
    check('tpm: block says exactly what is full (12,000 of 16,000 used, needs ≈ 6,000)', /12,000 of 16,000 input tokens already used this minute and this request needs ≈ 6,000/.test(blockJ.error?.message || ''), secondBody.slice(0, 300));
    check('tpm: half-full minute -> "try again in ~Ns" (+ retry_after_s + Retry-After header)', /try again in ~\d+s/.test(blockJ.error?.message || '') && blockJ.error?.retry_after_s >= 1 && blockJ.error?.retry_after_s <= 60, JSON.stringify(blockJ.error));
    r = await fetch(BASE + '/admin/api/models/zz-google-tpm', { method: 'DELETE', headers: admin2 }); await r.text();
    r = await fetch(BASE + '/admin/api/models/zz-google-win', { method: 'DELETE', headers: admin2 }); await r.text();

    // ── sync-add: models/ prefix stripped, limits pre-filled from provider-limits.json ──
    const addSync = async (prov, model) => { const rr = await fetch(BASE + '/admin/api/sync/' + prov + '/add', { method: 'POST', headers: admin2, body: JSON.stringify({ model }) }); return { status: rr.status, j: await rr.json() }; };
    let a = await addSync('google', 'models/gemini-2.5-flash-lite');
    check('google add: id has no "models-" prefix', a.j.id === 'gemini-2.5-flash-lite-g', a.j.id);
    check('google add: stored model slug is bare', a.j.entry?.model === 'gemini-2.5-flash-lite', a.j.entry?.model);
    check('google add: rpm/tpm/rpd pre-filled (10 / 250K / 20)', a.j.entry?.rpm === 10 && a.j.entry?.tpm === 250000 && a.j.entry?.rpd === 20, JSON.stringify(a.j.entry));
    a = await addSync('google', 'models/gemma-4-26b-a4b-it');
    check('google add: Gemma slug matches (30 / 16K / 14.4K)', a.status === 409 || (a.j.entry?.rpm === 30 && a.j.entry?.tpm === 16000 && a.j.entry?.rpd === 14400), JSON.stringify(a.j));
    if (a.j.id) { r = await fetch(BASE + '/admin/api/models/' + a.j.id, { method: 'DELETE', headers: admin2 }); await r.text(); }
    a = await addSync('google', 'models/gemini-2.5-pro');
    check('google add: 0/0/0 model gets a warning note, NOT rpm:0 (0 would mean "untracked")', a.j.entry && a.j.entry.rpm === undefined && /0 RPM/.test(a.j.entry.notes || ''), JSON.stringify(a.j.entry));
    if (a.j.id) { r = await fetch(BASE + '/admin/api/models/' + a.j.id, { method: 'DELETE', headers: admin2 }); await r.text(); }
    a = await addSync('google', 'models/gemini-99-imaginary');
    check('google add: unknown model -> no limits + note', a.j.entry && a.j.entry.rpm === undefined && /No row/.test(a.j.entry.notes || ''), JSON.stringify(a.j.entry));
    if (a.j.id) { r = await fetch(BASE + '/admin/api/models/' + a.j.id, { method: 'DELETE', headers: admin2 }); await r.text(); }
    r = await fetch(BASE + '/admin/api/models/gemini-2.5-flash-lite-g', { method: 'DELETE', headers: admin2 }); await r.text();

    a = await addSync('literouter', 'glm-5.1:free');
    check('literouter add: :free model with a 100/day cap gets dailyCap 100', a.j.entry?.dailyCap === 100, JSON.stringify(a.j.entry));
    if (a.j.id) { r = await fetch(BASE + '/admin/api/models/' + a.j.id, { method: 'DELETE', headers: admin2 }); await r.text(); }
    a = await addSync('literouter', 'qwen3.6-27b:free');
    check('literouter add: unlimited :free model gets NO dailyCap', a.j.entry && a.j.entry.dailyCap === undefined, JSON.stringify(a.j.entry));
    if (a.j.id) { r = await fetch(BASE + '/admin/api/models/' + a.j.id, { method: 'DELETE', headers: admin2 }); await r.text(); }
    a = await addSync('literouter', 'command-a');
    check('literouter add: premium model notes its credit multiplier, no dailyCap', a.j.entry && a.j.entry.dailyCap === undefined && /1x/.test(a.j.entry.notes || ''), JSON.stringify(a.j.entry));
    if (a.j.id) { r = await fetch(BASE + '/admin/api/models/' + a.j.id, { method: 'DELETE', headers: admin2 }); await r.text(); }

    // ── sync GET: Google prefix-insensitive matching; Literouter keeps unreachable models ──
    setScenario({ mode: 'nonstream', models: ['models/gemini-2.5-flash', 'models/gemini-3.8-flash', 'gemini-3-flash-preview', 'models/gemini-2.5-flash-lite'] });
    r = await fetch(BASE + '/admin/api/sync/google', { headers: admin2 }); j = await r.json();
    check('google sync: already-configured models are not offered again under the other spelling',
      Array.isArray(j.newlyAvailable) && j.newlyAvailable.length === 1 && j.newlyAvailable[0] === 'gemini-2.5-flash-lite', JSON.stringify(j.newlyAvailable));
    check('google sync: offered model carries its limits preview', j.modelInfo?.['gemini-2.5-flash-lite']?.limits?.rpm === 10, JSON.stringify(j.modelInfo));
    check('sync: limits snapshot age is reported', j.limitsMeta && j.limitsMeta.capturedAt && typeof j.limitsMeta.stale === 'boolean', JSON.stringify(j.limitsMeta));
    setScenario({ mode: 'nonstream', models: ['glm-5.2', 'command-a', 'totally-unknown-model', 'qwen3.6-27b:free'] });
    r = await fetch(BASE + '/admin/api/sync/literouter', { headers: admin2 }); j = await r.json();
    const tierOf = id => j.modelInfo?.[id]?.tier;
    check('literouter sync: nothing dropped, tiers correct', j.newlyAvailable?.length === 4 && tierOf('glm-5.2') === 'inaccessible' && tierOf('command-a') === 'premium' && tierOf('totally-unknown-model') === 'unknown' && tierOf('qwen3.6-27b:free') === 'free', JSON.stringify(j.modelInfo));
    check('literouter sync: no more "hiddenInaccessible" count', !('hiddenInaccessible' in j));

    // ── rpm: hit the per-minute request limit -> "try again in ~Ns" ──
    r = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({ id: 'zz-google-rpm', entry: { model: 'gemma-4-26b-a4b-it', provider: 'google', status: 'active', limitType: 'rate-limited', rpm: 1 } }) }); await r.text();
    setScenario({ mode: 'nonstream', json: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} } });
    let rpmBody = {}, rpmHeader = null, rpmStatus = 0;
    for (let tries = 0; tries < 2 && rpmStatus !== 503; tries++) {
      await (await chat({ model: 'zz-google-rpm', messages: [{ role: 'user', content: 'hi' }] })).text();
      r = await chat({ model: 'zz-google-rpm', messages: [{ role: 'user', content: 'hi' }] });
      rpmStatus = r.status; rpmHeader = r.headers.get('retry-after'); rpmBody = await r.json().catch(() => ({}));
    }
    check('rpm: second request in the same minute is blocked', rpmStatus === 503, String(rpmStatus));
    check('rpm: message names the limit and says when to retry', /rpm limit reached \(1\/1 requests this minute\) — try again in ~\d+s/.test(rpmBody.error?.message || ''), rpmBody.error?.message);
    check('rpm: retry_after_s in body == Retry-After header', rpmBody.error?.retry_after_s >= 1 && String(rpmBody.error.retry_after_s) === rpmHeader, `${rpmBody.error?.retry_after_s} vs ${rpmHeader}`);
    r = await fetch(BASE + '/admin/api/models/zz-google-rpm', { method: 'DELETE', headers: admin2 }); await r.text();

    // ── TPM list: Google counts INPUT only; a provider NOT on the list stays conservative (input + max_tokens) ──
    r = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({ id: 'zz-nv-cap', entry: { model: 'nv-x', provider: 'nvidia', status: 'active', limitType: 'rate-limited', tpmLimit: 4000 } }) }); await r.text();
    r = await chat({ model: 'zz-nv-cap', max_tokens: 5000, messages: [{ role: 'user', content: 'x'.repeat(400) }] });
    j = await r.json().catch(() => ({}));
    check('tpm list: non-listed provider still counts max_tokens (prompt 100 + 5,000 > 4,000)', r.status === 503 && /prompt 100 \+ max_tokens 5,000\) is over the max request size of 4,000 set for this model/.test(j.error?.message || ''), JSON.stringify(j.error));
    r = await chat({ model: 'zz-nv-cap', max_tokens: 1000, messages: [{ role: 'user', content: 'x'.repeat(400) }] });
    check('tpm list: same model, smaller max_tokens passes', r.status === 200, 'got ' + r.status); await r.text();
    r = await fetch(BASE + '/admin/api/models/zz-nv-cap', { method: 'DELETE', headers: admin2 }); await r.text();

    // ── errors: short, one line each, no chain talk for a single-hop model ──
    r = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({ id: 'zz-g503', entry: { model: 'models/gemini-3.8-flash', provider: 'google', status: 'active', limitType: 'rate-limited' } }) }); await r.text();
    const googleErr = JSON.stringify([{ error: { code: 503, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary.', status: 'UNAVAILABLE' } }], null, 2);
    setScenario({ mode: 'upstream-error', status: 503, body: googleErr });
    let mark = serverLog.length;
    r = await chat({ model: 'zz-g503', messages: [{ role: 'user', content: 'hi' }] });
    j = await r.json(); await sleep(150);
    const errLog = serverLog.slice(mark);
    check('error: Google array-wrapped JSON is reduced to its one-line message', j.error?.provider_message === 'This model is currently experiencing high demand. Spikes in demand are usually temporary.', JSON.stringify(j.error?.provider_message));
    check('error: client message is ONE short line, names the model without "models/", includes HTTP status',
      !/\\n/.test(j.error?.message || '') && (j.error?.message || '').length < 240 && /google\/gemini-3\.8-flash: This model is currently/.test(j.error?.message || '') && /HTTP 503/.test(j.error?.message || ''), j.error?.message);
    check('error: single-hop model -> no attempts array, no "hop"/"chain" wording', !('attempts' in j) && !/\\bhops?\\b|chain/i.test(j.error?.message || ''), JSON.stringify(j).slice(0, 300));
    check('logs: the failure is logged ONCE (no WARN + ERROR pair)', (errLog.match(/high demand/g) || []).length === 1 && /\[ERROR\]/.test(errLog) && !/giving up|no more hops|trying fallback/.test(errLog), errLog.slice(0, 600));
    check('logs: error line is short and has no raw JSON', !/"error":|\[\{/.test(errLog) && !/models\/gemini/.test(errLog), errLog.slice(0, 400));
    r = await fetch(BASE + '/admin/api/models/zz-g503', { method: 'DELETE', headers: admin2 }); await r.text();

    // multi-hop chains DO keep the hop-by-hop trail (it means something there)
    r = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({ id: 'zz-chain', entry: { model: 'gemma-4-31b-it', provider: 'google', status: 'active', limitType: 'rate-limited', tpmLimit: 1000,
      fallback: { model: 'nv-y', provider: 'nvidia', status: 'active', limitType: 'rate-limited', retryAsUnlimited: false } } }) }); await r.text();
    setScenario({ mode: 'upstream-error', status: 503, body: 'overloaded' });
    r = await chat({ model: 'zz-chain', messages: [{ role: 'user', content: 'x'.repeat(8000) }] });
    j = await r.json();
    check('multi-hop: attempts trail kept, first hop skipped with a plain-English note', Array.isArray(j.attempts) && j.attempts.length === 2 && /over the max request size of 1,000 set for this model/.test(j.attempts[0].note || '') && j.attempts[1].outcome === 'failed', JSON.stringify(j.attempts));
    r = await fetch(BASE + '/admin/api/models/zz-chain', { method: 'DELETE', headers: admin2 }); await r.text();

    // ── request ids, prompt block, compiled think/reply in the console, admin filter ──
    setScenario({ mode: 'stream', endMode: 'end', chunks: [
      { id: 'r', choices: [{ delta: { role: 'assistant', reasoning_content: 'plan A' }, finish_reason: null }] },
      { id: 'r', choices: [{ delta: { content: 'the answer' }, finish_reason: null }] },
      { id: 'r', choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]' ] });
    mark = serverLog.length;
    const [pa, pb] = await Promise.all([
      chat({ model: 'gemma-4-31b-nv', stream: true, messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi A' }] }),
      chat({ model: 'gemma-4-31b-nv', stream: true, messages: [{ role: 'user', content: 'hi B' }] })]);
    await readSSE(pa); await readSSE(pb); await sleep(250);
    const par = serverLog.slice(mark);
    const rids = [...par.matchAll(/REQUEST → model: gemma-4-31b-nv[^\n]*/g)].length && [...par.matchAll(/#([a-z0-9]{4}) \[me\] REQUEST/g)].map(m => m[1]);
    check('rid: two parallel requests get different ids', rids.length === 2 && rids[0] !== rids[1], JSON.stringify(rids));
    const ridA = rids[0];
    const aLines = par.split('\n').filter(l => l.includes('#' + ridA));
    check('rid: every line of a request carries its id (request, provider, stream-complete)', aLines.some(l => /REQUEST/.test(l)) && aLines.some(l => /→ provider:/.test(l)) && aLines.some(l => /stream complete/.test(l)), aLines.join('\n').slice(0, 500));
    check('console: compiled THINK block copied to Render logs, every line tagged', new RegExp(`\\[THINK\\] #${ridA} \\[me\\] reasoning[^\\n]*\\n#${ridA} │ plan A`).test(par), par.slice(0, 900));
    check('console: compiled REPLY block copied too', new RegExp(`\\[REPLY\\] #${ridA} \\[me\\] reply[^\\n]*\\n#${ridA} │ the answer`).test(par));
    r = await fetch(BASE + '/admin/api/logs?rid=' + ridA, { headers: admin2 }); j = await r.json();
    const lv = j.logs.map(l => l.level);
    check('admin logs: ?rid= returns only that request, incl. PROMPT + THINK + REPLY', j.logs.length > 0 && j.logs.every(l => l.rid === ridA) && ['PROMPT', 'THINK', 'REPLY'].every(x => lv.includes(x)), JSON.stringify(lv));
    const promptEntry = j.logs.find(l => l.level === 'PROMPT');
    check('admin logs: PROMPT entry lists every message (system + user)', /\[msg 0\] (system|user): /.test(promptEntry?.msg || '') && /\[msg 1\] user: hi A|\[msg 0\] user: hi A/.test(promptEntry?.msg || ''), promptEntry?.msg);
    check('admin logs: capacity raised to 1000', j.capacity === 1000, String(j.capacity));
    check('boot: server clock / time zone logged once', /Server clock: .* all log stamps are UTC/.test(serverLog));

    // ── waiting notices: silent when fast, appear (and resolve) when the first output is slow ──
    mark = serverLog.length;
    setScenario({ mode: 'stream', endMode: 'end', chunks: [{ id: 'f', choices: [{ delta: { role: 'assistant', content: 'quick' }, finish_reason: null }] }, { id: 'f', choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'] });
    await readSSE(await chat({ model: 'gemma-4-31b-nv', stream: true, messages: [{ role: 'user', content: 'hi' }] })); await sleep(150);
    check('wait: a fast model prints NO waiting notice', !/⏳|first output arrived/.test(serverLog.slice(mark)), serverLog.slice(mark).slice(0, 300));
    mark = serverLog.length;
    setScenario({ mode: 'stream', endMode: 'end', firstChunkDelayMs: 1500, chunks: [{ id: 's', choices: [{ delta: { role: 'assistant', reasoning_content: 'hmm' }, finish_reason: null }] }, { id: 's', choices: [{ delta: { content: 'done' }, finish_reason: null }] }, { id: 's', choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'] });
    await readSSE(await chat({ model: 'gemma-4-31b-nv', stream: true, messages: [{ role: 'user', content: 'hi' }] })); await sleep(200);
    const slow = serverLog.slice(mark);
    check('wait: slow first output -> "still waiting for nvidia/… — Ns and no output yet"', /⏳ still waiting for nvidia\/google\/gemma-4-31b-it to start answering — \d+s and no output yet/.test(slow), slow.slice(0, 500));
    check('wait: …then "first output arrived after Ns" and the summary shows both clocks', /✓ first output arrived after \d+s/.test(slow) && /streaming \| first output after \d+s \| [\d.]+s since request/.test(slow), slow.slice(0, 900));

    // ── client hangs up while the provider is still queueing: the upstream call is CANCELLED ──
    try { fs.unlinkSync(SCEN + '.aborted'); } catch (_) {}
    setScenario({ mode: 'hang' });
    mark = serverLog.length;
    const ac = new AbortController();
    const hung = fetch(BASE + '/v1/chat/completions', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer testkey' }, body: JSON.stringify({ model: 'gemma-4-31b-nv', stream: true, messages: [{ role: 'user', content: 'hi' }] }) }).catch(() => 'aborted');
    await sleep(500); ac.abort(); await hung;
    let cancelled = false; for (let i = 0; i < 20 && !cancelled; i++) { cancelled = fs.existsSync(SCEN + '.aborted'); if (!cancelled) await sleep(100); }
    await sleep(150);
    const gone = serverLog.slice(mark);
    check('hang-up: the in-flight upstream call was aborted (not left running for nobody)', cancelled);
    check('hang-up: logged as a calm INFO (no ERROR), and it never "completes"', /client disconnected after .* cancelling the upstream request/.test(gone) && /request ended — client disconnected/.test(gone) && !/\[ERROR\]|stream complete/.test(gone), gone.slice(0, 600));
    try { fs.unlinkSync(SCEN + '.aborted'); } catch (_) {}

    // ── load-order invariant: the limits table exists before anything can read it ──
    const srcText = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('provider-limits is declared above every function that reads it (no TDZ at load)',
      srcText.indexOf('const PROVIDER_LIMITS =') > -1 && srcText.indexOf('const PROVIDER_LIMITS =') < srcText.indexOf('function tpmCountsInputOnly') && !/typeof PROVIDER_LIMITS/.test(srcText));

    // ── QUOTA outranks 429 in classifyError (known, intended): pin what it actually does ──
    const quotaBody = JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } });
    setScenario({ mode: 'upstream-error', status: 429, body: quotaBody });
    let qt0 = Date.now();
    r = await chat({ model: 'glm-5.3-nv', messages: [{ role: 'user', content: 'hi' }] });
    j = await r.json();
    check('QUOTA: a quota-worded 429 on a single-hop NIM model stops retrying at once and is returned as 429 (not 503)',
      r.status === 429 && r.headers.get('x-qproxy-error-tag') === 'QUOTA' && Date.now() - qt0 < 3000, `${r.status} ${r.headers.get('x-qproxy-error-tag')} ${Date.now() - qt0}ms`);
    r = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({ id: 'zz-q', entry: { model: 'nv-a', provider: 'nvidia', status: 'active', limitType: 'unlimited',
      fallback: { model: 'gemma-4-31b-it', provider: 'google', status: 'active', limitType: 'rate-limited' } } }) }); await r.text();
    r = await chat({ model: 'zz-q', messages: [{ role: 'user', content: 'hi' }] });
    j = await r.json();
    check('QUOTA: on a two-hop chain it still FALLS BACK to the next hop (only the retry loop stops)',
      Array.isArray(j.attempts) && j.attempts.length === 2 && j.attempts.every(a => a.reason === 'QUOTA'), JSON.stringify(j.attempts));
    r = await fetch(BASE + '/admin/api/models/zz-q', { method: 'DELETE', headers: admin2 }); await r.text();

    // ── admin auth: only ADMIN_KEY opens the panel ──
    r = await fetch(BASE + '/admin/api/models', { headers: { 'X-Admin-Key': 'wrongkey' } });
    j = await r.json().catch(() => ({}));
    check('admin: a wrong key is rejected (401)', r.status === 401 && /Invalid or missing admin key/.test(j.error?.message || ''), `${r.status} ${JSON.stringify(j)}`);
    r = await fetch(BASE + '/admin/api/models', { headers: { 'X-Admin-Key': 'adminkey' } });
    check('admin: the real ADMIN_KEY works (one wrong try did not lock it out)', r.ok, String(r.status)); await r.text();

    // ── fails closed when ADMIN_KEY is not set at all: 503 for every key, plus a boot WARN ──
    {
      const env2 = { ...process.env, MY_KEY: 'testkey', NIM_API_KEY: 'nv', PORT: String(PORT + 1), MOCK_FILE: SCEN };
      delete env2.ADMIN_KEY;
      const child2 = spawn(process.execPath, ['-r', './test/mock-axios.js', 'server.js'], { cwd: ROOT, env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
      let log2 = ''; child2.stdout.on('data', d => { log2 += d; }); child2.stderr.on('data', d => { log2 += d; });
      const exited2 = new Promise(resolve => child2.on('exit', resolve));
      const B2 = `http://127.0.0.1:${PORT + 1}`;
      let up2 = false;
      for (let i = 0; i < 50 && !up2; i++) { try { const hr = await fetch(B2 + '/health'); up2 = hr.ok; await hr.text(); } catch (_) {} if (!up2) await sleep(200); }
      check('no ADMIN_KEY: server still boots (the proxy itself does not need it)', up2);
      if (up2) {
        const codes = [];
        for (const k of ['wrongkey', 'adminkey', '']) { const ar = await fetch(B2 + '/admin/api/models', { headers: { 'X-Admin-Key': k } }); codes.push(ar.status); await ar.text(); }
        check('no ADMIN_KEY: admin panel answers 503 for every key', codes.every(c => c === 503), JSON.stringify(codes));
        check('no ADMIN_KEY: a clear WARN is logged at boot', /ADMIN_KEY is not set — the admin panel is disabled/.test(log2), log2.slice(0, 400));
      }
      child2.kill(); await Promise.race([exited2, sleep(3000)]);
    }

    // ══ retry "walls": errors that can't fix themselves must not be retried 100 times ══
    const timedChat = async (model, ms) => {
      const ac = new AbortController(); const t0 = Date.now(); const to = setTimeout(() => ac.abort(), ms);
      try {
        const rr = await fetch(BASE + '/v1/chat/completions', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer testkey' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }) });
        const jj = await rr.json().catch(() => ({})); clearTimeout(to);
        return { status: rr.status, tag: rr.headers.get('x-qproxy-error-tag'), ms: Date.now() - t0, j: jj };
      } catch (_) { return { hung: true, ms: Date.now() - t0 }; }
    };
    setScenario({ mode: 'upstream-error', status: 404, body: 'model not found' });
    let w = await timedChat('glm-5.3-nv', 4000);
    check('walls: 404 on an unlimited hop stops at once (was ~100 retries)', w.status === 404 && w.tag === 'NOT_FOUND' && w.ms < 3000, JSON.stringify({ s: w.status, t: w.tag, ms: w.ms, hung: w.hung }));
    setScenario({ mode: 'upstream-error', status: 500, body: 'Invalid API key provided' });
    w = await timedChat('glm-5.3-nv', 4000);
    check('walls: a key error reported as a 500 is AUTH and stops at once', w.tag === 'AUTH' && w.ms < 3000, JSON.stringify({ s: w.status, t: w.tag, ms: w.ms, hung: w.hung }));
    setScenario({ mode: 'network-error', code: 'ENOTFOUND' });
    w = await timedChat('glm-5.3-nv', 6000);
    check('walls: DNS failure gets 3 tries, not 100', w.tag === 'NET_DNS' && w.ms < 4000 && /after 3 attempts/.test(w.j?.error?.message || ''), JSON.stringify({ t: w.tag, ms: w.ms, hung: w.hung, m: w.j?.error?.message }));
    setScenario({ mode: 'network-error', code: 'CERT_HAS_EXPIRED' });
    w = await timedChat('glm-5.3-nv', 4000);
    check('walls: a TLS/URL config error (NET_CONFIG) stops at once', w.tag === 'NET_CONFIG' && w.ms < 1500, JSON.stringify({ t: w.tag, ms: w.ms, hung: w.hung }));
    setScenario({ mode: 'upstream-error', status: 503, body: 'service unavailable' });
    w = await timedChat('glm-5.3-nv', 1500);
    check('walls: a 503 on an unlimited hop STILL retries (the intended behaviour is unchanged)', w.hung === true, JSON.stringify(w));
    r = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({ id: 'zz-404', entry: { model: 'nv-a', provider: 'nvidia', status: 'active', limitType: 'unlimited',
      fallback: { model: 'gemma-4-31b-it', provider: 'google', status: 'active', limitType: 'rate-limited' } } }) }); await r.text();
    setScenario({ mode: 'upstream-error', status: 404, body: 'not found' });
    w = await timedChat('zz-404', 4000);
    check('walls: a 404 still FALLS BACK to the next hop (only the retrying stops)', Array.isArray(w.j?.attempts) && w.j.attempts.length === 2 && w.j.attempts.every(a => /NOT_FOUND/.test(a.reason)) && w.ms < 3000, JSON.stringify(w.j?.attempts));
    r = await fetch(BASE + '/admin/api/models/zz-404', { method: 'DELETE', headers: admin2 }); await r.text();

    // ── the retry-window wording: total time vs the window counted from the FIRST failure ──
    r = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({ id: 'zz-win', entry: { model: 'nv-slow', provider: 'nvidia', status: 'active', limitType: 'unlimited', retryBudgetMs: 1000 } }) }); await r.text();
    setScenario({ mode: 'upstream-error', status: 504, body: 'gateway timeout', delayMs: 900 });   // each attempt takes ~0.9s to fail; the window is 1s
    w = await timedChat('zz-win', 8000);
    check('retry window: a long last attempt is explained (started inside the window, allowed to finish, how long it took)',
      w.status === 504 && /after 2 attempts over \d+s — the 1s retry window \(counted from the first failure\) ran out; attempt 2 began inside it and was allowed to finish, taking \d+ms/.test(w.j?.error?.message || ''), w.j?.error?.message);
    r = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({ id: 'zz-win2', entry: { model: 'nv-fast', provider: 'nvidia', status: 'active', limitType: 'unlimited', retryBudgetMs: 300 } }) }); await r.text();
    setScenario({ mode: 'upstream-error', status: 504, body: 'gateway timeout' });                  // instant failures: nothing to explain
    w = await timedChat('zz-win2', 8000);
    check('retry window: quick failures just say the window ran out (no "allowed to finish" clause)',
      /ran out$|ran out\)/.test((w.j?.error?.message || '').split(' — the provider')[0]) && !/allowed to finish/.test(w.j?.error?.message || '') && /the 300ms retry window/.test(w.j?.error?.message || ''), w.j?.error?.message);
    for (const id of ['zz-win', 'zz-win2']) { r = await fetch(BASE + '/admin/api/models/' + id, { method: 'DELETE', headers: admin2 }); await r.text(); }

    // ══ reasoning controls written by the 🧪 detector must actually reach the provider ══
    // (they used to be silently dropped: the schema ids the detector writes did not exist)
    const upstreamBody = async (id) => {
      setScenario({ mode: 'nonstream', json: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} } });
      const rr = await chat({ model: id, messages: [{ role: 'user', content: 'hi' }] }); await rr.text(); await sleep(100);
      return JSON.parse(fs.readFileSync(SCEN + '.lastbody', 'utf8'));
    };
    const addHop = async (id, entry) => { const rr = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({ id, entry: { provider: 'nvidia', status: 'active', limitType: 'unlimited', model: 'org/' + id, ...entry } }) }); await rr.text(); };
    // exactly what admin.html's applyDetectionToHop writes for NVIDIA's DeepSeek-V4-Flash sample (thinking + reasoning_effort, both inside chat_template_kwargs)
    await addHop('zz-think', { reasoningSchema: 'thinking-and-effort', reasoning: { thinking_toggle: true, reasoning_effort: 'high' }, reasoningFieldEnabled: { thinking_toggle: true, reasoning_effort: true },
      reasoningFieldKeys: { thinking_toggle: 'thinking', reasoning_effort: 'reasoning_effort' }, reasoningFieldTransport: { thinking_toggle: 'chat_template_kwargs', reasoning_effort: 'chat_template_kwargs' }, reasoningFieldOptions: { reasoning_effort: ['high', 'low', 'max'] } });
    let ub = await upstreamBody('zz-think');
    check('detect->apply: toggle + effort in chat_template_kwargs reach the provider, under the model\'s own key ("thinking")', JSON.stringify(ub.chat_template_kwargs) === JSON.stringify({ thinking: true, reasoning_effort: 'high' }), JSON.stringify(ub));
    await addHop('zz-think2', { reasoningSchema: 'thinking-and-effort', reasoning: { thinking_toggle: false, reasoning_effort: 'high' }, reasoningFieldEnabled: { thinking_toggle: true },
      reasoningFieldKeys: { thinking_toggle: 'enable_thinking' }, reasoningFieldTransport: { thinking_toggle: 'chat_template_kwargs' } });
    ub = await upstreamBody('zz-think2');
    check('detect->apply: a field that is not switched on is NOT sent (effort stays out; toggle can send false)', JSON.stringify(ub.chat_template_kwargs) === JSON.stringify({ enable_thinking: false }) && !('reasoning_effort' in ub), JSON.stringify(ub));
    await addHop('zz-think3', { reasoningSchema: 'thinking-and-effort', reasoning: { reasoning_effort: 'low' }, reasoningFieldEnabled: { reasoning_effort: true }, reasoningFieldKeys: { reasoning_effort: 'reasoning_effort' }, reasoningFieldTransport: { reasoning_effort: 'top_level' } });
    ub = await upstreamBody('zz-think3');
    check('detect->apply: an effort level whose transport is top_level goes to the top of the request', ub.reasoning_effort === 'low' && !('chat_template_kwargs' in ub), JSON.stringify(ub));
    await addHop('zz-raw', { reasoningSchema: 'raw', reasoning: { __raw: { enable_thinking: true, clear_thinking: true } }, reasoningFieldTransport: { __raw: 'chat_template_kwargs' } });
    ub = await upstreamBody('zz-raw');
    check('detect->apply: the "raw" (special case) schema reaches the provider too', JSON.stringify(ub.chat_template_kwargs) === JSON.stringify({ enable_thinking: true, clear_thinking: true }), JSON.stringify(ub));
    check('detect->apply: the hop you already had (kimi-k3-nv, reasoning-effort-select) is unchanged', (await upstreamBody('kimi-k3-nv')).reasoning_effort === 'max');
    for (const id of ['zz-think', 'zz-think2', 'zz-think3', 'zz-raw']) { const rr = await fetch(BASE + '/admin/api/models/' + id, { method: 'DELETE', headers: admin2 }); await rr.text(); }
    check('every schema id the Admin detector can write exists in reasoning-schemas.json', ['thinking-and-effort', 'raw'].every(k => JSON.parse(fs.readFileSync(path.join(ROOT, 'reasoning-schemas.json'), 'utf8'))[k]));

    // ══ OpenRouter sync: free / paid / premium from the live price list ══
    setScenario({ mode: 'nonstream', modelObjects: [
      { id: 'google/gemma-4-31b-it:free', pricing: { prompt: '0', completion: '0' }, context_length: 262144, supported_parameters: ['temperature', 'tools', 'reasoning'] },   // already configured -> must not be offered
      { id: 'acme/free-by-suffix:free', pricing: { prompt: '0', completion: '0' }, context_length: 131072, supported_parameters: ['tools', 'reasoning'] },
      { id: 'acme/free-no-suffix', pricing: { prompt: '0', completion: '0' } },
      { id: 'acme/cheap', pricing: { prompt: '0.0000003', completion: '0.0000012' }, context_length: 200000, supported_parameters: ['temperature'] },
      { id: 'acme/just-under', pricing: { prompt: '0.000001', completion: '0.0000049' } },
      { id: 'acme/at-threshold', pricing: { prompt: '0.000001', completion: '0.000005' } },
      { id: 'acme/expensive', pricing: { prompt: '0.000015', completion: '0.000075' }, context_length: 1000000 },
      { id: 'acme/router', pricing: { prompt: '-1', completion: '-1' } },
      { id: 'acme/no-price' }
    ] });
    r = await fetch(BASE + '/admin/api/sync/openrouter', { headers: admin2 }); j = await r.json();
    const tierOr = id => j.modelInfo?.[id]?.tier;
    check('openrouter sync: configured models are not offered again; the rest are (8)', r.ok && j.newlyAvailable?.length === 8 && !j.newlyAvailable.includes('google/gemma-4-31b-it:free'), JSON.stringify(j.newlyAvailable));
    check('openrouter sync: free by ":free" suffix AND by zero price (no suffix)', tierOr('acme/free-by-suffix:free') === 'free' && tierOr('acme/free-no-suffix') === 'free');
    check('openrouter sync: everything that is not free is "paid" (cheap, $4.90, $5, expensive, variable -1, unpriced)', ['cheap', 'just-under', 'at-threshold', 'expensive', 'router', 'no-price'].every(k => tierOr('acme/' + k) === 'paid'), JSON.stringify(['cheap', 'just-under', 'at-threshold', 'expensive', 'router', 'no-price'].map(k => tierOr('acme/' + k))));
    check('openrouter sync: every model is either free or paid', Object.values(j.modelInfo).every(v => v.tier === 'free' || v.tier === 'paid'));
    check('openrouter sync: price per MILLION tokens is reported ($0.30 in / $1.20 out)', Math.abs(j.modelInfo['acme/cheap'].price.in - 0.3) < 1e-9 && Math.abs(j.modelInfo['acme/cheap'].price.out - 1.2) < 1e-9 && j.modelInfo['acme/free-by-suffix:free'].price === null, JSON.stringify(j.modelInfo['acme/cheap']));
    check('openrouter sync: context + tool/reasoning support are read from the response (null when not listed)', j.modelInfo['acme/free-by-suffix:free'].context === 131072 && j.modelInfo['acme/free-by-suffix:free'].tools === true && j.modelInfo['acme/free-by-suffix:free'].reasoning === true && j.modelInfo['acme/cheap'].tools === false && j.modelInfo['acme/free-no-suffix'].tools === null, JSON.stringify(j.modelInfo['acme/cheap']));
    check('openrouter sync: the free per-key daily cap is sent along so the panel can say it', j.tierNotes?.freePerDayPerKey === 50, JSON.stringify(j.tierNotes));

    // ══ Google limits: paste-to-refresh (AI Studio table) ══
    const fx = fs.readFileSync(path.join(__dirname, 'fixtures', 'ai-studio-limits.txt'), 'utf8');
    const limitsPath2 = path.join(ROOT, 'provider-limits.json');
    const litBefore = JSON.stringify(JSON.parse(fs.readFileSync(limitsPath2, 'utf8')).literouter);
    const post = async (url, body) => { const rr = await fetch(BASE + url, { method: 'POST', headers: admin2, body: JSON.stringify(body) }); return { status: rr.status, j: await rr.json().catch(() => ({})) }; };
    const getModels = async () => (await (await fetch(BASE + '/admin/api/models', { headers: admin2 })).json()).models;
    const getStatus = async () => (await fetch(BASE + '/admin/api/limits/status', { headers: admin2 })).json();
    let pv = await post('/admin/api/limits/google/preview', { text: fx });
    check('limits import: the real AI Studio paste parses to all 44 model rows (header lines and the Tools section ignored)', pv.status === 200 && pv.j.rows === 44, JSON.stringify({ s: pv.status, rows: pv.j.rows, e: pv.j.error }));
    check('limits import: pasting the same table = no differences', pv.j.changes.length === 0 && pv.j.added.length === 0 && pv.j.hopChanges.length === 0, JSON.stringify({ c: pv.j.changes, a: pv.j.added, h: pv.j.hopChanges }).slice(0, 300));
    const fxChanged = fx.replace(/(Gemini 2\.5 Flash\t?\nText-out models\t?\n)0 \/ 5\n/, '$10 / 10\n');
    check('limits import: (test setup) the edited paste really differs', fxChanged !== fx);
    pv = await post('/admin/api/limits/google/preview', { text: fxChanged });
    check('limits import: preview shows the changed table row', pv.j.changes.length === 1 && pv.j.changes[0].label === 'Gemini 2.5 Flash' && pv.j.changes[0].field === 'rpm' && pv.j.changes[0].from === 5 && pv.j.changes[0].to === 10, JSON.stringify(pv.j.changes));
    check('limits import: preview shows which EXISTING Google hop would change', pv.j.hopChanges.some(h => h.id === 'gemini-2.5-flash-g' && h.field === 'rpm' && h.from === 5 && h.to === 10), JSON.stringify(pv.j.hopChanges));
    let mm = await getModels();
    check('limits import: preview changes NOTHING', mm['gemini-2.5-flash-g'].rpm === 5 && JSON.parse(fs.readFileSync(limitsPath2, 'utf8')).google.models['gemini-2.5-flash'].rpm === 5);
    pv = await post('/admin/api/limits/google/apply', { text: fxChanged });
    mm = await getModels();
    const fileAfter = JSON.parse(fs.readFileSync(limitsPath2, 'utf8'));
    check('limits import: apply updates the existing hop', pv.status === 200 && mm['gemini-2.5-flash-g'].rpm === 10, JSON.stringify({ s: pv.status, rpm: mm['gemini-2.5-flash-g']?.rpm }));
    check('limits import: apply writes the table (capturedAt = today) and leaves the Literouter section untouched', fileAfter.google.models['gemini-2.5-flash'].rpm === 10 && fileAfter.google.capturedAt === new Date().toISOString().slice(0, 10) && JSON.stringify(fileAfter.literouter) === litBefore);
    pv = await post('/admin/api/limits/google/apply', { text: fx });   // put the original numbers back
    mm = await getModels();
    check('limits import: pasting the original table again restores the original numbers', mm['gemini-2.5-flash-g'].rpm === 5 && JSON.parse(fs.readFileSync(limitsPath2, 'utf8')).google.models['gemini-2.5-flash'].rpm === 5);
    pv = await post('/admin/api/limits/google/preview', { text: fx.split('\n').slice(0, 26).join('\n') + '\n' });
    check('limits import: a partial paste KEEPS the rows it does not contain', pv.status === 200 && pv.j.rows >= 3 && pv.j.rows < 10 && pv.j.keptNotInPaste >= 30, JSON.stringify({ rows: pv.j.rows, kept: pv.j.keptNotInPaste }));
    pv = await post('/admin/api/limits/google/preview', { text: 'this is not a table\nat all' });
    check('limits import: something that is not the table is refused with an explanation (400)', pv.status === 400 && /Couldn't find the AI Studio rate-limit table/.test(pv.j.error?.message || ''), JSON.stringify(pv));

    // ══ Google limits: learn from Google's own 429 ══
    const g429 = (id, value, model) => JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: id, quotaDimensions: { location: 'global', model }, quotaValue: String(value) }] }] } }]);
    // returns the HTTP status + whether our OWN rpm window blocked the request before Google was ever called (then there is no 429 to learn from)
    const hit429 = async (body, modelId = 'gemini-2.5-flash-g') => { setScenario({ mode: 'upstream-error', status: 429, body }); const rr = await chat({ model: modelId, messages: [{ role: 'user', content: 'hi' }] }); const txt = await rr.text(); await sleep(200); hit429.lastBlockedLocally = /NO_HOP/.test(txt); return rr.status; };
    check('learn-429: (setup) hop starts at rpm 5', (await getModels())['gemini-2.5-flash-g'].rpm === 5);
    mark = serverLog.length;
    await hit429(g429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 10, 'gemini-2.5-flash'));
    mm = await getModels(); let st = await getStatus();
    check('learn-429: Google says rpm is 10 -> the hop value is corrected', mm['gemini-2.5-flash-g'].rpm === 10, String(mm['gemini-2.5-flash-g'].rpm));
    check('learn-429: the mismatch is recorded and the "may be outdated" flag is raised', st.outdated === true && st.mismatches.length === 1 && st.mismatches[0].model === 'gemini-2.5-flash' && st.mismatches[0].field === 'rpm' && st.mismatches[0].ours === 5 && st.mismatches[0].google === 10, JSON.stringify(st.mismatches));
    check('learn-429: one clear WARN says what changed and where to refresh', /\[limits\] Google says gemini-2\.5-flash RPM is 10 \(we had 5\).*Refresh limits/.test(serverLog.slice(mark)), serverLog.slice(mark).slice(0, 300));
    await hit429(g429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 10, 'gemini-2.5-flash'));
    st = await getStatus();
    check('learn-429: the same value again changes nothing and adds no duplicate', st.mismatches.length === 1 && (await getModels())['gemini-2.5-flash-g'].rpm === 10);
    await hit429(g429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 99, 'gemini-3-flash'));
    check('learn-429: a violation for a DIFFERENT model is ignored', (await getModels())['gemini-2.5-flash-g'].rpm === 10 && (await getStatus()).mismatches.length === 1);
    await hit429(g429('GenerateContentInputTokensPerModelPerMinute-FreeTier', 250000, 'gemini-2.5-flash'));
    check('learn-429: a value that already matches (tpm 250,000) changes nothing', (await getModels())['gemini-2.5-flash-g'].tpm === 250000 && (await getStatus()).mismatches.length === 1);
    await hit429(g429('SomeQuotaWeDoNotKnow', 7, 'gemini-2.5-flash'));
    check('learn-429: an unrecognised quota id is ignored, never guessed', (await getModels())['gemini-2.5-flash-g'].rpm === 10 && (await getStatus()).mismatches.length === 1);
    const odd = await hit429('Too Many Requests');
    check('learn-429: a plain-text 429 body does not break anything', odd === 429 && (await getStatus()).mismatches.length === 1, String(odd));
    pv = await post('/admin/api/limits/google/preview', { text: fx });
    check('learn-429 + import: refreshing from the table puts the corrected hop back in line (10 -> 5)', pv.j.hopChanges.some(h => h.id === 'gemini-2.5-flash-g' && h.field === 'rpm' && h.from === 10 && h.to === 5), JSON.stringify(pv.j.hopChanges));
    pv = await post('/admin/api/limits/google/apply', { text: fx });
    st = await getStatus();
    check('learn-429 + import: applying a refresh clears the warning', st.mismatches.length === 0, JSON.stringify(st.mismatches));
    // (a different model: gemini-2.5-flash has already used up this minute's 5 requests, so OUR rpm would block it before Google is called)
    await hit429(g429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 15000, 'gemma-4-31b-it'), 'gemma-4-31b-g');
    st = await getStatus();
    mm = await getModels();
    check('learn-429: a daily-limit violation maps to rpd (and every hop on that model is corrected)', !hit429.lastBlockedLocally && mm['gemma-4-31b-g'].rpd === 15000 && mm['gemma-4-31b'].rpd === 15000 && st.mismatches[0]?.field === 'rpd' && st.mismatches[0]?.model === 'gemma-4-31b-it' && st.mismatches[0].fixedHops.length >= 2, JSON.stringify({ blockedLocally: hit429.lastBlockedLocally, st: st.mismatches }));
    r = await post('/admin/api/limits/dismiss', {});
    check('limits: Dismiss clears the mismatch list', (await getStatus()).mismatches.length === 0);

    // ══ "model is gone" is recognised however the provider says it ══
    const okReply = { mode: 'nonstream', json: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} } };
    await addHop('zz-gone', { provider: 'literouter', model: 'glm-4.6:free', dailyCap: 100 });
    setScenario({ mode: 'upstream-error', status: 400, body: '{"error":{"message":"The model `glm-4.6:free` does not exist or you do not have access to it.","type":"invalid_request_error"}}' });
    w = await timedChat('zz-gone', 4000);
    check('gone: a 400 "model does not exist" is NOT_FOUND (it used to be a hard BAD_REQUEST that never falls back)', w.status === 400 && w.tag === 'NOT_FOUND' && w.ms < 3000, JSON.stringify({ s: w.status, t: w.tag, ms: w.ms }));
    setScenario({ mode: 'upstream-error', status: 422, body: '{"detail":"unknown model glm-4.6:free"}' });
    w = await timedChat('zz-gone', 4000);
    check('gone: a 422 "unknown model" is NOT_FOUND too', w.tag === 'NOT_FOUND', JSON.stringify({ s: w.status, t: w.tag }));
    setScenario({ mode: 'upstream-error', status: 400, body: '{"error":{"message":"Invalid value for temperature: must be between 0 and 2"}}' });
    w = await timedChat('zz-gone', 4000);
    check('gone: an ordinary bad request stays BAD_REQUEST', w.tag === 'BAD_REQUEST', JSON.stringify({ s: w.status, t: w.tag }));
    setScenario({ mode: 'upstream-error', status: 400, body: '{"error":{"message":"The model is temporarily unavailable, try again"}}' });
    w = await timedChat('zz-gone', 4000);
    check('gone: "temporarily unavailable" is NOT mistaken for gone', w.tag !== 'NOT_FOUND', JSON.stringify({ s: w.status, t: w.tag }));
    setScenario({ mode: 'upstream-error', status: 400, body: '{"error":{"message":"The tool search was not found. The model can only call the listed tools."}}' });
    w = await timedChat('zz-gone', 4000);
    check('gone: "tool not found" in a bad request is NOT mistaken for a missing model', w.tag === 'BAD_REQUEST', JSON.stringify({ s: w.status, t: w.tag }));
    setScenario({ mode: 'upstream-error', status: 400, body: '{"error":{"message":"Invalid model parameter: top_k is not supported"}}' });
    w = await timedChat('zz-gone', 4000);
    check('gone: "Invalid model parameter ..." (a bad field, not a missing model) stays BAD_REQUEST', w.tag === 'BAD_REQUEST', JSON.stringify({ s: w.status, t: w.tag }));
    setScenario({ mode: 'upstream-error', status: 400, body: '{"error":{"message":"Invalid model: glm-4.6:free"}}' });
    w = await timedChat('zz-gone', 4000);
    check('gone: "Invalid model: <id>" is still NOT_FOUND', w.tag === 'NOT_FOUND', JSON.stringify({ s: w.status, t: w.tag }));
    r = await fetch(BASE + '/admin/api/models', { method: 'POST', headers: admin2, body: JSON.stringify({ id: 'zz-gone-chain', entry: { provider: 'literouter', model: 'glm-4.6:free', status: 'active', limitType: 'rate-limited', dailyCap: 100,
      fallback: { provider: 'nvidia', model: 'org/alive', status: 'active', limitType: 'unlimited' } } }) }); await r.text();
    setScenario({ mode: 'upstream-error', status: 400, body: '{"error":{"message":"The model does not exist"}}' });
    w = await timedChat('zz-gone-chain', 4000);
    check('gone: with a 400 "does not exist" the chain now FALLS BACK to the next hop', Array.isArray(w.j?.attempts) && w.j.attempts.length === 2 && w.j.attempts.every(a => /NOT_FOUND/.test(a.reason)), JSON.stringify(w.j?.attempts));
    r = await fetch(BASE + '/admin/api/models/zz-gone-chain', { method: 'DELETE', headers: admin2 }); await r.text();

    // ══ hop warnings ══
    const getWarn = async () => (await fetch(BASE + '/admin/api/warnings', { headers: admin2 })).json();
    const warnFor = (ww, provider, model) => ww.hops.find(x => x.provider === provider && x.model === model);
    let ww = await getWarn();
    check('warnings: the endpoint answers with hops, counts and the last-check times', Array.isArray(ww.hops) && typeof ww.counts === 'object' && typeof ww.catalogCheckedAt === 'object', JSON.stringify(Object.keys(ww)));
    const gone1 = warnFor(ww, 'literouter', 'glm-4.6:free');
    check('warnings (request): a real request that got "does not exist" flags the hop as gone, and says it was seen in a request', gone1 && gone1.kind === 'gone' && gone1.source === 'request' && gone1.entries.includes('zz-gone') && /does not exist/.test(gone1.detail), JSON.stringify(gone1));
    setScenario(okReply);
    await (await chat({ model: 'zz-gone', messages: [{ role: 'user', content: 'hi' }] })).text();
    check('warnings (request): a later success clears it (the provider answered, so it is not gone)', !warnFor(await getWarn(), 'literouter', 'glm-4.6:free'));
    r = await fetch(BASE + '/admin/api/models/zz-gone', { method: 'DELETE', headers: admin2 }); await r.text();

    // ══ Literouter free tier: prompts over its fixed context get summarized by Literouter — the log says so ══
    await addHop('zz-ctx', { provider: 'literouter', model: 'zz-ctx-model:free' });
    await addHop('zz-ctx-paid', { provider: 'literouter', model: 'zz-ctx-paid-model' });
    setScenario(okReply);
    const longMsg = [{ role: 'user', content: 'word '.repeat(7000) }];      // ≈ 8.7K estimated tokens
    let mark2 = serverLog.length;
    await (await chat({ model: 'zz-ctx', messages: [{ role: 'user', content: 'hi' }] })).text();
    check('context (literouter free): a short prompt logs no notice', !/\[context\] literouter\/zz-ctx-model:free/.test(serverLog.slice(mark2)));
    mark2 = serverLog.length;
    await (await chat({ model: 'zz-ctx', messages: longMsg })).text();
    check('context (literouter free): a prompt over 5,000 tokens logs that Literouter will summarize it', /\[context\] literouter\/zz-ctx-model:free .*over Literouter's free 5,000-token context.*summarize/.test(serverLog.slice(mark2)), serverLog.slice(mark2).slice(0, 400));
    mark2 = serverLog.length;
    await (await chat({ model: 'zz-ctx-paid', messages: longMsg })).text();
    check('context (literouter non-free): no 5,000 notice for a model that is not a :free variant', !/\[context\]/.test(serverLog.slice(mark2)));
    for (const id of ['zz-ctx', 'zz-ctx-paid']) { r = await fetch(BASE + '/admin/api/models/' + id, { method: 'DELETE', headers: admin2 }); await r.text(); }

    // Earlier sync tests used tiny mock lists, which (correctly) flagged every real hop as gone. Start the saved-table
    // checks from a clean slate: tell each provider's check that EVERYTHING configured is still listed.
    const configuredIds = async (prov) => { const mm = await getModels(); const ids = new Set(); for (const e of Object.values(mm)) for (let h = e; h; h = h.fallback) if (h.provider === prov) ids.add(h.model); return [...ids]; };
    const resetCatalog = async () => { for (const prov of ['google', 'literouter', 'openrouter', 'nvidia', 'zai']) { setScenario({ mode: 'nonstream', models: await configuredIds(prov) }); await post('/admin/api/warnings/check', { provider: prov }); } };
    await resetCatalog();
    ww = await getWarn();
    check('warnings: with every configured model listed there are no catalog warnings', ww.hops.filter(x => x.source === 'catalog').length === 0, JSON.stringify(ww.hops.filter(x => x.source === 'catalog').map(x => x.key)));

    // saved-table warnings. The 429 learner tests above left a Gemma hop at rpd 15,000 (table: 14,400): that IS a "limits changed".
    ww = await getWarn();
    const lim = warnFor(ww, 'google', 'gemma-4-31b-it');
    check('warnings (saved table): a hop whose numbers drifted from the table is "limits changed", with the numbers', lim && lim.kind === 'limits-changed' && lim.source === 'snapshot' && /rpd 15,000 here vs 14,400 in the saved table/.test(lim.detail), JSON.stringify(lim));
    await post('/admin/api/limits/google/apply', { text: fx });
    ww = await getWarn();
    check('warnings (saved table): refreshing the limits clears it — and the real config has no saved-table warnings', ww.hops.filter(x => x.source === 'snapshot').length === 0, JSON.stringify(ww.hops.filter(x => x.source === 'snapshot')));
    await addHop('zz-w-gpaid', { provider: 'google', model: 'gemini-2.5-pro' });
    await addHop('zz-w-glim', { provider: 'google', model: 'gemma-4-26b-a4b-it', rpd: 99999 });
    await addHop('zz-w-lnofree', { provider: 'literouter', model: 'command-a:free' });
    await addHop('zz-w-lcap', { provider: 'literouter', model: 'glm-5.1:free', dailyCap: 30 });
    await addHop('zz-w-lnone', { provider: 'literouter', model: 'brand-new-thing:free' });
    ww = await getWarn();
    check('warnings (saved table): a Google model the table lists 0/0/0 is "turned paid"', warnFor(ww, 'google', 'gemini-2.5-pro')?.kind === 'turned-paid', JSON.stringify(warnFor(ww, 'google', 'gemini-2.5-pro')));
    const gl = warnFor(ww, 'google', 'gemma-4-26b-a4b-it');
    check('warnings (saved table): "limits changed" marks ONLY the hop that differs, not the other hops on the same model', gl?.kind === 'limits-changed' && JSON.stringify(gl.entries) === JSON.stringify(['zz-w-glim']) && gl.table?.rpd === 14400, JSON.stringify(gl));
    check('warnings (saved table): a Literouter free model with no free version in the catalog is "turned paid"', warnFor(ww, 'literouter', 'command-a:free')?.kind === 'turned-paid');
    check('warnings (saved table): a Literouter cap that differs from the catalog is "limits changed" (30/day vs 100/day)', /30\/day here vs 100\/day/.test(warnFor(ww, 'literouter', 'glm-5.1:free')?.detail || ''), JSON.stringify(warnFor(ww, 'literouter', 'glm-5.1:free')));
    check('warnings (saved table): a Literouter model that is not in the catalog at all is "gone"', warnFor(ww, 'literouter', 'brand-new-thing:free')?.kind === 'gone');
    for (const id of ['zz-w-gpaid', 'zz-w-glim', 'zz-w-lnofree', 'zz-w-lcap', 'zz-w-lnone']) { r = await fetch(BASE + '/admin/api/models/' + id, { method: 'DELETE', headers: admin2 }); await r.text(); }

    // live-catalog warnings, from the provider's /models list
    await addHop('zz-c-ok', { provider: 'literouter', model: 'glm-4.6:free', dailyCap: 100 });
    await addHop('zz-c-gone', { provider: 'literouter', model: 'glm-4.7:free', dailyCap: 100 });
    await addHop('zz-c-paid', { provider: 'literouter', model: 'glm-5:free', dailyCap: 100 });
    await addHop('zz-c-ign', { provider: 'literouter', model: 'kimi-k2.7-code-cheap:free', dailyCap: 30, ignoreCatalog: true });
    await addHop('zz-c-g', { provider: 'google', model: 'gemini-9-flash' });
    setScenario({ mode: 'nonstream', models: ['glm-4.6:free', 'glm-5', 'something-else'] });
    r = await fetch(BASE + '/admin/api/sync/literouter', { headers: admin2 }); j = await r.json();
    ww = await getWarn();
    check('catalog: a configured model the provider no longer lists is "gone"', warnFor(ww, 'literouter', 'glm-4.7:free')?.kind === 'gone' && warnFor(ww, 'literouter', 'glm-4.7:free')?.source === 'catalog', JSON.stringify(warnFor(ww, 'literouter', 'glm-4.7:free')));
    check('catalog: a ":free" model whose paid twin is still listed is "turned paid" (and the warning says so)', warnFor(ww, 'literouter', 'glm-5:free')?.kind === 'turned-paid' && /"glm-5" is/.test(warnFor(ww, 'literouter', 'glm-5:free')?.detail || ''), JSON.stringify(warnFor(ww, 'literouter', 'glm-5:free')));
    check('catalog: a model that is still listed has no warning; ignoreCatalog suppresses it', !warnFor(ww, 'literouter', 'glm-4.6:free') && !warnFor(ww, 'literouter', 'kimi-k2.7-code-cheap:free'));
    check('catalog: the sync panel tells "gone" and "turned paid" apart in its no-longer-listed rows', j.noLongerListedKinds?.['glm-4.7:free']?.kind === 'gone' && j.noLongerListedKinds?.['glm-5:free']?.kind === 'turned-paid', JSON.stringify(j.noLongerListedKinds).slice(0, 300));
    const litBefore2 = ww.hops.filter(x => x.provider === 'literouter' && x.source === 'catalog').length;
    setScenario({ mode: 'nonstream', modelObjects: [] });
    r = await fetch(BASE + '/admin/api/warnings/check', { method: 'POST', headers: admin2, body: JSON.stringify({ provider: 'literouter' }) }); j = await r.json();
    check('catalog: an EMPTY list from the provider is ignored — it never flags everything as gone', /empty list/.test(j.results?.literouter || '') && j.hops.filter(x => x.provider === 'literouter' && x.source === 'catalog').length === litBefore2, JSON.stringify(j.results));
    setScenario({ mode: 'nonstream', models: ['glm-4.6:free', 'glm-4.7:free', 'glm-5:free'] });
    r = await fetch(BASE + '/admin/api/warnings/check', { method: 'POST', headers: admin2, body: JSON.stringify({ provider: 'literouter' }) }); j = await r.json();
    check('catalog: when a model comes back it is cleared (the "Check now" button works)', j.results?.literouter === 'ok' && !warnFor(j, 'literouter', 'glm-4.7:free') && !warnFor(j, 'literouter', 'glm-5:free') && typeof j.catalogCheckedAt?.literouter === 'string', JSON.stringify(j.results));
    setScenario({ mode: 'nonstream', modelObjects: [{ id: 'models/gemini-9-flash-preview' }, { id: 'models/gemini-2.5-flash' }] });
    r = await fetch(BASE + '/admin/api/sync/google', { headers: admin2 }); j = await r.json();
    ww = await getWarn(); const gren = warnFor(ww, 'google', 'gemini-9-flash');
    check('catalog (Google): a renamed model is "gone" and the warning says what is listed instead', gren?.kind === 'gone' && JSON.stringify(gren.instead) === JSON.stringify(['gemini-9-flash-preview']) && j.noLongerListedKinds?.['gemini-9-flash']?.instead?.[0] === 'gemini-9-flash-preview', JSON.stringify({ gren, k: j.noLongerListedKinds?.['gemini-9-flash'] }));
    for (const id of ['zz-c-ok', 'zz-c-gone', 'zz-c-paid', 'zz-c-ign', 'zz-c-g']) { r = await fetch(BASE + '/admin/api/models/' + id, { method: 'DELETE', headers: admin2 }); await r.text(); }
    check('warnings: removing the hop removes its warning', !warnFor(await getWarn(), 'google', 'gemini-9-flash') && !warnFor(await getWarn(), 'literouter', 'glm-4.7:free'));

    await resetCatalog();

    // ══ free / paid groups for Google and Z.ai (NIM is free-only: no grouping) ══
    setScenario({ mode: 'nonstream', modelObjects: ['gemma-4-26b-it', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'text-embedding-004'].map(id => ({ id: 'models/' + id })) });
    r = await fetch(BASE + '/admin/api/sync/google', { headers: admin2 }); j = await r.json();
    const tg = id => j.modelInfo?.[id]?.tier;
    check('google tiers: 14.4K and 500 requests/day are "generous"; 20/day is "thin"; 0/0/0 is "paid only"; not in the table is "unknown"',
      tg('gemma-4-26b-it') === 'generous' && tg('gemini-3.1-flash-lite') === 'generous' && tg('gemini-2.5-flash-lite') === 'thin' && tg('gemini-2.5-pro') === 'paidonly' && tg('text-embedding-004') === 'unknown', JSON.stringify(Object.fromEntries(Object.entries(j.modelInfo || {}).map(([k, v]) => [k, v.tier]))));
    check('google tiers: the generous line (500/day) is sent along so the panel can say it', j.tierNotes?.generousRpd === 500, JSON.stringify(j.tierNotes));
    setScenario({ mode: 'nonstream', models: ['glm-4.7-flash', 'glm-4.5-flash', 'glm-4.6v-flash', 'glm-5.2'] });
    r = await fetch(BASE + '/admin/api/sync/zai', { headers: admin2 }); j = await r.json();
    check('zai tiers: the vision flash model is free, glm-5.2 is paid (the free list comes from Z.ai\'s pricing page); Z.ai has no limits snapshot to show', j.modelInfo?.['glm-4.6v-flash']?.tier === 'free' && j.modelInfo?.['glm-5.2']?.tier === 'paid' && j.limitsMeta === null, JSON.stringify({ m: j.modelInfo, l: j.limitsMeta }));
    setScenario({ mode: 'nonstream', models: ['org/some-nim-model'] });
    r = await fetch(BASE + '/admin/api/sync/nvidia', { headers: admin2 }); j = await r.json();
    check('nvidia: free-only, so no free/paid grouping (everything stays "unknown")', Object.values(j.modelInfo || {}).every(v => v.tier === 'unknown') && !j.tierNotes, JSON.stringify(j.modelInfo));

    // ── /health after a cycle-free run (cycle guard smoke) ────────────
    r = await fetch(BASE + '/health');
    check('/health still healthy at end', r.ok, String(r.status));
    await r.text();
  } finally {
    child.kill();
    await Promise.race([exited, sleep(3000)]);
    fs.copyFileSync(modelsPath + '.bak', modelsPath);
    fs.unlinkSync(modelsPath + '.bak');
    if (hadUsage) { fs.copyFileSync(usagePath + '.bak', usagePath); fs.unlinkSync(usagePath + '.bak'); } else { try { fs.unlinkSync(usagePath); } catch (_) {} }
    fs.copyFileSync(limitsPath + '.bak', limitsPath); fs.unlinkSync(limitsPath + '.bak');
    try { fs.unlinkSync(SCEN); } catch (_) {}
    try { fs.unlinkSync(SCEN + '.lastbody'); } catch (_) {}
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('TEST DRIVER ERROR', e); process.exit(2); });
