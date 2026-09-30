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

  const child = spawn(process.execPath, ['-r', './test/mock-axios.js', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, MY_KEY: 'testkey', ADMIN_KEY: 'adminkey', NIM_API_KEY: 'nv', GOOGLE_KEY_1: 'g1', LITEROUTER_KEY_1: 'lr1', QP_WAIT_NOTICE_MS: '600', PORT: String(PORT), MOCK_FILE: SCEN },
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
    setScenario({ mode: 'nonstream', models: ['models/gemini-2.5-flash', 'models/gemini-3.8-flash', 'gemini-3-flash', 'models/gemini-2.5-flash-lite'] });
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
    try { fs.unlinkSync(SCEN); } catch (_) {}
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch(e => { console.error('TEST DRIVER ERROR', e); process.exit(2); });
