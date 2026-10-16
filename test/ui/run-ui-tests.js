// test/ui/run-ui-tests.js — simulated-browser tests for public/admin.html.
//
//   cd test/ui && npm install && node run-ui-tests.js
//
// Boots a COPY of the project in a temp folder (so models.json / usage-state.json
// are never touched) with the mocked axios, sends a few requests through it so
// the logs have content, then opens /admin in jsdom with a real fetch and checks
// what a person would see: login, no login flash, remembered settings, log
// controls, grouped warnings, the API-call panel and the model tester.
// jsdom has no layout engine: this checks behaviour and DOM state, not looks.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM, ResourceLoader } = require('jsdom');
// Only load this server's own files; fonts and other outside links are skipped (no network in tests).
class LocalOnly extends ResourceLoader { fetch(url, o) { return url.startsWith(BASE) ? super.fetch(url, o) : Promise.resolve(Buffer.from('')); } }

const ROOT = path.join(__dirname, '..', '..');
const PORT = 3190;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'adminkey';
let failures = 0, passes = 0;
function check(name, cond, detail) {
  if (cond) { passes++; console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(step); }
  return false;
}

function stageProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-ui-'));
  for (const f of ['server.js', 'models.json', 'reasoning-schemas.json', 'provider-limits.json', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(dir, 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'));
  fs.copyFileSync(path.join(ROOT, 'test', 'mock-axios.js'), path.join(dir, 'test', 'mock-axios.js'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'usage-state.json'), '{}');
  fs.writeFileSync(path.join(dir, 'test', 'scenario.json'), JSON.stringify({ mode: 'nonstream', json: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} } }));
  return dir;
}

async function openAdmin(query, storage) {
  const dom = await JSDOM.fromURL(BASE + '/admin' + (query || ''), {
    runScripts: 'dangerously', resources: new LocalOnly(), pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, BASE), o);
      w.AbortController = AbortController;
      w.scrollTo = () => {};
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.navigator.clipboard = { writeText: async t => { w.__copied = t; } };
      if (storage) for (const k of Object.keys(storage)) w.localStorage.setItem(k, storage[k]);
    }
  });
  return dom;
}
const click = (w, el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const setVal = (w, el, v, ev = 'input') => { el.value = v; el.dispatchEvent(new w.Event(ev, { bubbles: true })); };

async function main() {
  const dir = stageProject();
  const child = spawn(process.execPath, ['-r', './test/mock-axios.js', 'server.js'], {
    cwd: dir,
    env: { ...process.env, MY_KEY: 'testkey', ADMIN_KEY: KEY, NIM_API_KEY: 'nv', GOOGLE_KEY_1: 'g1', LITEROUTER_KEY_1: 'lr1', OPENROUTER_KEY_1: 'or1', ZAI_API_KEY: 'z1', QP_NO_CATALOG_WATCH: '1', PORT: String(PORT), MOCK_FILE: path.join(dir, 'test', 'scenario.json') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOut = '';
  child.stdout.on('data', d => serverOut += d); child.stderr.on('data', d => serverOut += d);
  const dones = [];
  try {
    const up = await until(async () => (await fetch(BASE + '/admin/api/models', { headers: { 'X-Admin-Key': KEY } })).status === 200, 8000, 150);
    check('server booted', !!up, serverOut.slice(-300));
    if (!up) return;

    // Traffic so the logs have several requests (one with an upstream error).
    const models = await (await fetch(BASE + '/admin/api/models', { headers: { 'X-Admin-Key': KEY } })).json();
    const names = Object.keys(models.models || models).filter(n => !n.startsWith('_'));
    const sendChat = (model) => fetch(BASE + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer testkey' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false }) }).then(r => r.text());
    await sendChat(names[0]); await sendChat(names[0]);
    fs.writeFileSync(path.join(dir, 'test', 'scenario.json'), JSON.stringify({ mode: 'upstream-error', status: 401, body: 'bad key' }));
    await sendChat(names[0]);
    fs.writeFileSync(path.join(dir, 'test', 'scenario.json'), JSON.stringify({ mode: 'nonstream', json: { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: {} } }));

    // ── 1. Fresh visit: login gate, no dashboard ──
    let dom = await openAdmin('');
    dones.push(dom);
    let w = dom.window, d = w.document;
    await sleep(300);
    check('fresh visit shows the login gate', d.getElementById('dashboard').hidden === true && d.getElementById('login-gate').style.display !== 'none');
    check('fresh visit does NOT add the autologin class', !d.documentElement.classList.contains('autologin'));
    check('"Stay signed in" is ticked by default', d.getElementById('stay-signed-in').checked === true);

    // wrong key
    setVal(w, d.getElementById('key-input'), 'nope'); click(w, d.getElementById('key-submit'));
    check('wrong key shows an error and stays on the gate', !!(await until(() => d.getElementById('login-error').textContent.length > 0)) && d.getElementById('dashboard').hidden === true);

    // right key
    setVal(w, d.getElementById('key-input'), KEY); click(w, d.getElementById('key-submit'));
    check('right key opens the dashboard', !!(await until(() => d.getElementById('dashboard').hidden === false)));
    check('key saved because Stay signed in was ticked', w.localStorage.getItem('qproxy-admin-key') === KEY);

    // ── 2. Logs controls ──
    await until(() => d.querySelectorAll('#log-viewer .log-line, .log-line').length > 0, 6000);
    const lineCount = () => d.querySelectorAll('.log-line').length;
    check('logs render lines', lineCount() > 0, 'lines=' + lineCount());
    const chip = lvl => d.querySelector(`#log-level-chips [data-lvl="${lvl}"]`);
    const lvls = [...d.querySelectorAll('#log-level-chips [data-lvl]')].map(c => c.getAttribute('data-lvl'));
    check('level chips exist', lvls.length >= 3, lvls.join(','));
    const errChip = chip('ERROR');
    if (errChip) {
      click(w, errChip);
      await sleep(500);
      const shown = [...d.querySelectorAll('.log-line .lvl')].map(x => x.textContent.trim());
      check('ERROR chip alone leaves only ERROR lines', shown.length > 0 && shown.every(x => x === 'ERROR'), shown.join(','));
      check('"All" chip is no longer lit', !d.getElementById('log-chip-all').classList.contains('on'));
      const warnChip = chip('WARN');
      if (warnChip) {
        click(w, warnChip); await sleep(500);
        const s2 = new Set([...d.querySelectorAll('.log-line .lvl')].map(x => x.textContent.trim()));
        check('ERROR + WARN chips can be combined', [...s2].every(x => x === 'ERROR' || x === 'WARN') && s2.size >= 1, [...s2].join(','));
      }
      click(w, d.getElementById('log-chip-all')); await sleep(500);
      check('"All" brings every level back', d.getElementById('log-chip-all').classList.contains('on'));
    }
    // group by request
    d.getElementById('log-group').checked = true; d.getElementById('log-group').dispatchEvent(new w.Event('change', { bubbles: true }));
    await sleep(400);
    const heads = d.querySelectorAll('.log-group-head');
    check('Group by request makes collapsible chunks', heads.length >= 2, 'heads=' + heads.length);
    const before = lineCount();
    if (heads[0]) { click(w, heads[0]); await sleep(300); check('clicking a chunk head folds it', lineCount() < before, before + ' -> ' + lineCount()); }
    click(w, d.getElementById('log-collapse-btn')); await sleep(300);
    const afterCollapse = lineCount();
    click(w, d.getElementById('log-expand-btn')); await sleep(300);
    check('Collapse all / Expand all change the visible lines', lineCount() > afterCollapse, afterCollapse + ' -> ' + lineCount());
    // order
    const ord = d.getElementById('log-order');
    const firstRid = () => (d.querySelector('.log-group-head .gid') || {}).textContent;
    const a = firstRid();
    setVal(w, ord, [...ord.options].map(o => o.value).find(v => v !== ord.value), 'change'); await sleep(400);
    check('changing the order reorders the chunks', firstRid() !== a, a + ' vs ' + firstRid());

    // ── 3. Remembered settings (qproxy-ui) ──
    await sleep(900);
    const ui1 = JSON.parse(w.localStorage.getItem('qproxy-ui') || '{}');
    check('view settings were saved to localStorage', !!ui1 && Object.keys(ui1).length > 0 && ui1.logs && ui1.logs.group === true, JSON.stringify(ui1).slice(0, 200));

    // ── 4. Model tester ──
    const sel = d.getElementById('tester-provider');
    check('tester lists providers', sel.options.length >= 3, sel.options.length + '');
    setVal(w, sel, 'nvidia', 'change');
    click(w, d.getElementById('tester-load'));
    await until(() => d.getElementById('tester-models').value.trim().length > 0);
    const lines = d.getElementById('tester-models').value.split('\n').filter(Boolean);
    check('Load my configured models fills the box', lines.length > 0, lines.length + '');
    setVal(w, d.getElementById('tester-models'), lines.slice(0, 2).join('\n'));
    click(w, d.getElementById('tester-run'));
    check('tester shows result rows', !!(await until(() => d.querySelectorAll('#tester-results > *').length >= 1, 8000)));
    const resTxt = d.getElementById('tester-results').textContent;
    check('tester rows carry a verdict', /works|ok|no text|fail|quota|auth|not found|rate/i.test(resTxt), resTxt.slice(0, 120));

    // ── 4b. "Test this config" button on a hop ──
    const editBtn = d.querySelector('.edit-btn[data-edit="gemma-4-31b-nv"]');
    check('Models list has an Edit button for a model with reasoning controls', !!editBtn);
    if (editBtn) {
      click(w, editBtn);
      const cfgBtn = await until(() => d.querySelector('#hop-list .cfg-test-btn'));
      check('the hop editor has a labelled "Test this config" button', !!cfgBtn && /Test this config/.test(cfgBtn.textContent));
      if (cfgBtn) {
        check('no result is shown before the button is pressed', !d.querySelector('#hop-list .cfg-test'));
        click(w, cfgBtn);
        const panel = await until(() => { const p = d.querySelector('#hop-list .cfg-test'); return p && /accepted/.test(p.textContent) ? p : null; }, 8000);
        check('pressing it shows "accepted" with the exact reasoning fields that were sent', !!panel && /enable_thinking/.test(panel.textContent) && /chat_template_kwargs/.test(panel.textContent), panel ? panel.textContent.slice(0, 200) : 'no panel');
        const rf = d.querySelector('#hop-list [data-rf="enable_thinking"]');
        if (rf) {
          setVal(w, rf, rf.value === 'true' ? 'false' : 'true', 'change');
          check('changing a reasoning field clears the old result (it no longer describes the hop)', !d.querySelector('#hop-list .cfg-test'));
        } else check('changing a reasoning field clears the old result (it no longer describes the hop)', false, 'no enable_thinking control found');
        const cfgBtn2 = d.querySelector('#hop-list .cfg-test-btn');
        click(w, cfgBtn2);
        const panel2 = await until(() => { const p = d.querySelector('#hop-list .cfg-test'); return p && /accepted/.test(p.textContent) ? p : null; }, 8000);
        check('testing again sends the NEW value, not the saved one', !!panel2 && /"enable_thinking":(true|false)/.test(panel2.textContent) && panel2.textContent.includes('"enable_thinking":' + (rf ? rf.value : 'x')), panel2 ? panel2.textContent.slice(0, 200) : 'no panel');
      }
    }

    // ── 4b2. Per-hop "Test" button on the model cards ──
    const card1 = d.querySelector('.model-card[data-id="gemma-4-31b-nv"]');
    const t1 = card1 && card1.querySelector('.model-card-top .test-hop-btn');
    check('single-hop card has a Test button next to Edit/Remove', !!t1 && /Test/.test(t1.textContent) && !card1.querySelector('.chain .test-hop-btn'));
    if (t1) {
      click(w, t1);
      const dp = await until(() => d.querySelector('#hop-list .detect-panel, #hop-list .detect-nv-link, #hop-list [data-detect-input]'));
      check('Test opens the editor with the detect panel (link + paste box) already expanded', !!dp && !!d.querySelector('#hop-list textarea'));
      check('no request is sent by just opening it', !d.querySelector('#hop-list .cfg-test'));
    }
    const multiCard = d.querySelector('.model-card[data-id="gemma-4-31b"]');
    const multiBtns = multiCard ? multiCard.querySelectorAll('.chain .test-hop-btn') : [];
    check('multi-hop card has one Test button per hop (none by Edit)', multiBtns.length >= 2 && !multiCard.querySelector('.model-card-top .test-hop-btn'), String(multiBtns.length));
    if (multiBtns.length >= 2) {
      click(w, multiBtns[1]);
      const blocks = await until(() => { const b = d.querySelectorAll('#hop-list .hop-block'); return b.length >= 2 ? b : null; });
      const open = blocks ? Array.from(blocks).map(b => !!b.querySelector('textarea')) : [];
      check('Test on hop #2 expands only that hop\'s detect panel', open[1] === true && open[0] === false, JSON.stringify(open));
    }

    // ── 4c. Detect controls: link to NVIDIA's page, and reading pasted Python / JS / curl examples ──
    const EX_GLM = `from openai import OpenAI

client = OpenAI(
  base_url = "https://integrate.api.nvidia.com/v1",
  api_key = "$NVIDIA_API_KEY"
)

completion = client.chat.completions.create(
  model="z-ai/glm-5.3",
  messages=[{"role":"system","content":"You are a helpful assistant."},{"role":"user","content":"Which number is larger, 9.11 or 9.8?"}],
  temperature=0.5,
  top_p=1,
  max_tokens=1024,
  stream=False
)

print(completion.choices[0].message)`;
    const EX_KIMI = `import requests

invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"
stream = True

headers = {
    "Authorization": "Bearer $NVIDIA_API_KEY",
    "Accept": "text/event-stream" if stream else "application/json",
}

payload = {
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What is in this image?"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "https://assets.ngc.nvidia.com/products/api-catalog/phi-3-5-vision/example1b.jpg"
          }
        }
      ]
    }
  ],
  "model": "moonshotai/kimi-k3",
  "max_tokens": 16384,
  "seed": 0,
  "stream": stream,
  "temperature": 1,
  "reasoning_effort": "max"
}

response = requests.post(invoke_url, headers=headers, json=payload, stream=stream)
if stream:
    for line in response.iter_lines():
        if line:
            print(line.decode("utf-8"))
else:
    print(response.json())`;
    const EX_GEMMA = `payload = {
  "messages": [{"role": "user", "content": [{"type": "text", "text": "What is in this image?"}]}],
  "model": "google/diffusiongemma-26b-a4b-it",
  "chat_template_kwargs": {
    "enable_thinking": True
  },
  "max_tokens": 4096,
  "stream": stream,
  "temperature": 1,
  "top_p": 0.95
}`;
    const EX_JS = `const completion = await openai.chat.completions.create({
    model: "z-ai/glm-5.3",
    messages: [{"role":"user","content":"hi"}],
    temperature: 1, // a comment
    extra_body: { chat_template_kwargs: { enable_thinking: true } },
    stream: true,
})`;
    const EX_CURL = `curl https://integrate.api.nvidia.com/v1/chat/completions -H "Authorization: Bearer $K" -H "Content-Type: application/json" -d '{"model":"z-ai/glm-5.3","messages":[{"role":"user","content":"x"}],"reasoning_effort":"high"}'`;
    const detectOn = async (modelId, text) => {
      const eb = d.querySelector(`.edit-btn[data-edit="${modelId}"]`);
      if (!eb) return null;
      click(w, eb);
      const det = await until(() => d.querySelector('#hop-list .detect-btn'));
      if (!det) return null;
      if (!d.querySelector('#hop-list [data-detect-input]')) click(w, det);
      const ta = await until(() => d.querySelector('#hop-list [data-detect-input]'));
      if (text != null) {
        setVal(w, ta, text);
        click(w, d.querySelector('#hop-list [data-act="detect-scan"]'));
        await until(() => d.querySelector('#hop-list .detect-result'));
      }
      return det;
    };
    const resultText = () => (d.querySelector('#hop-list .detect-result') || {}).textContent || '';
    let detBtn = await detectOn('glm-5.3-nv', null);
    check('the hop editor button is labelled "Detect controls"', !!detBtn && /Detect controls/.test(detBtn.textContent), detBtn && detBtn.textContent);
    const nvLinks = [...d.querySelectorAll('#hop-list .detect-nv-link a')].map(a => a.getAttribute('href'));
    check('NVIDIA hop: the panel links to the model\'s page (z-ai/glm-5.3 -> build.nvidia.com/z-ai/glm-5-3) and offers the "_" form too', nvLinks[0] === 'https://build.nvidia.com/z-ai/glm-5-3' && nvLinks[1] === 'https://build.nvidia.com/z-ai/glm-5_3', JSON.stringify(nvLinks));
    check('NVIDIA link opens in a new tab safely', [...d.querySelectorAll('#hop-list .detect-nv-link a')].every(a => a.getAttribute('target') === '_blank' && /noopener/.test(a.getAttribute('rel') || '')));
    setVal(w, d.querySelector('#hop-list [data-detect-input]'), EX_GLM);
    click(w, d.querySelector('#hop-list [data-act="detect-scan"]'));
    await until(() => d.querySelector('#hop-list .detect-result'));
    let rt = resultText();
    check('Python OpenAI-client example (GLM-5.3, no reasoning field): reads the request and says "No reasoning parameter"', /No reasoning parameter/.test(rt) && /z-ai\/glm-5\.3/.test(rt) && /temperature/.test(rt) && /max_tokens/.test(rt), rt.slice(0, 300));
    check('...and does not warn about a model mismatch (same model)', !/This example is for/.test(rt));
    const applyNone = d.querySelector('#hop-list [data-act="detect-apply"]');
    check('...and offers "Apply: send no reasoning fields"', !!applyNone && /send no reasoning fields/.test(applyNone.textContent), applyNone && applyNone.textContent);
    if (applyNone) {
      click(w, applyNone);
      const schemaSel = d.querySelector('#hop-list select[data-f="reasoningSchema"]');
      check('applying it leaves the hop with no reasoning schema (nothing is sent)', !!schemaSel && schemaSel.value === '', schemaSel && schemaSel.value);
    }
    await detectOn('kimi-k3-nv', EX_KIMI);
    rt = resultText();
    check('Python requests example (Kimi-K3, with "stream": stream and a headers dict with an if-else): finds reasoning_effort = "max" at the top level', /reasoning_effort/.test(rt) && /"max"/.test(rt) && /top_level/.test(rt), rt.slice(0, 300));
    check('...and says the example shows only ONE value, so the other values are not known from it', /ONE value/.test(rt), rt.slice(0, 400));
    await detectOn('gemma-4-31b-nv', EX_GEMMA);
    rt = resultText();
    check('Python dict with True (diffusiongemma): finds enable_thinking inside chat_template_kwargs', /enable_thinking/.test(rt) && /chat_template_kwargs/.test(rt), rt.slice(0, 300));
    check('...and warns when the example is for a different model than the hop (gemma-4-31b-it vs diffusiongemma)', /This example is for/.test(rt) && /diffusiongemma/.test(rt), rt.slice(0, 400));
    await detectOn('glm-5.3-nv', EX_JS);
    rt = resultText();
    check('JavaScript create({...}) call with bare keys, a comment and extra_body: finds enable_thinking (extra_body is read as top level)', /enable_thinking/.test(rt) && /chat_template_kwargs/.test(rt), rt.slice(0, 300));
    await detectOn('glm-5.3-nv', EX_CURL);
    rt = resultText();
    check('curl -d \'{...}\': finds reasoning_effort "high"', /reasoning_effort/.test(rt) && /"high"/.test(rt), rt.slice(0, 300));
    await detectOn('glm-5.3-nv', 'client.chat.completions.create(model="z-ai/glm-5.3", messages=[], extra_body={"google": {"thinking_config": {"thinking_level": "low", "include_thoughts": True}}})');
    rt = resultText();
    check('a nested wrapper such as Google\'s google.thinking_config is flagged as a special case (Raw), NOT reported as "no reasoning parameter"', /Special case/.test(rt) && /google/.test(rt) && !/No reasoning parameter/.test(rt), rt.slice(0, 300));
    await detectOn('glm-5.3-nv', 'client.chat.completions.create(model="z-ai/glm-5.3", messages=[], response_format={"type": "json_schema", "json_schema": {"schema": {"properties": {"reasoning": {"type": "string"}}}}})');
    rt = resultText();
    check('a JSON schema that merely has a property named "reasoning" is NOT mistaken for a reasoning control', /No reasoning parameter/.test(rt) && !/Special case/.test(rt), rt.slice(0, 300));
    await detectOn('glm-5.3-nv', 'client.chat.completions.create(model="z-ai/glm-5.3", messages=[], reasoning_effort=my_effort)');
    rt = resultText();
    check('a reasoning field whose value is a variable is reported as unreadable (not as "no controls")', /variables or expressions/.test(rt) && !/No reasoning parameter/.test(rt), rt.slice(0, 300));
    await detectOn('glm-5.3-nv', 'hello, this is not code');
    rt = resultText();
    check('text with no request in it says it could not read one', /Couldn't read a request/.test(rt), rt.slice(0, 200));
    await detectOn('glm-4.7-flash-z', null);
    check('a non-NVIDIA hop has no NVIDIA link', !d.querySelector('#hop-list .detect-nv-link'));

    // ── 5. Warnings: grouped + collapsible ──
    const cats = d.querySelectorAll('details[data-warn-cat]');
    if (cats.length) {
      const c = cats[0], k = c.getAttribute('data-warn-cat'), was = c.open;
      c.open = !was; c.dispatchEvent(new w.Event('toggle', { bubbles: true }));
      await sleep(900);
      const ui2 = JSON.parse(w.localStorage.getItem('qproxy-ui') || '{}');
      check('opening/closing a warning group is remembered', ui2.warnOpen && ui2.warnOpen[k] === !was, JSON.stringify(ui2.warnOpen));
    } else console.log('SKIP warning groups (no warnings in this run)');

    // ── 6. Provider tab remembered + API call panel ──
    const tabs = [...d.querySelectorAll('#provider-tabs button, #provider-tabs [data-tab], #provider-tabs [data-provider]')];
    check('provider tabs render', tabs.length >= 2, tabs.length + '');
    const tabOf = el => el.getAttribute('data-tab') || el.getAttribute('data-provider') || el.textContent.trim();
    const pick = tabs.find(t => /google|literouter|zai|openrouter/i.test(tabOf(t))) || tabs[1];
    if (pick) {
      click(w, pick); await sleep(1000);
      const ui3 = JSON.parse(w.localStorage.getItem('qproxy-ui') || '{}');
      check('chosen provider tab is saved', !!ui3.providerTab, JSON.stringify(ui3.providerTab));
      const apiBtn = d.querySelector('[data-sync-api]');
      if (apiBtn) {
        click(w, apiBtn);
        check('API call panel opens', !!(await until(() => d.querySelector('[data-sync-api-send]'), 4000)));
        const sendBtn = d.querySelector('[data-sync-api-send]');
        if (sendBtn) {
          click(w, sendBtn);
          check('"Send it now" shows a raw answer', !!(await until(() => d.querySelector('[data-sync-api-copy]'), 6000)));
        }
      } else console.log('SKIP API call panel (tab has no Sync button)');
    }

    // ── 7. Click to copy ──
    const copyEl = d.querySelector('.copyable[data-copy]');
    if (copyEl) {
      click(w, copyEl); await sleep(200);
      check('click-to-copy puts the text on the clipboard', w.__copied === copyEl.getAttribute('data-copy'), String(w.__copied));
      check('a toast appears', d.getElementById('toast').classList.contains('show') || d.getElementById('toast').textContent.length > 0);
    } else console.log('SKIP click-to-copy (no copyable element)');
    const saved = { 'qproxy-admin-key': KEY, 'qproxy-ui': w.localStorage.getItem('qproxy-ui') };
    dom.window.close();

    // ── 8. Reload with the saved key: no login flash, settings restored ──
    dom = await openAdmin('', saved); dones.push(dom);
    w = dom.window; d = w.document;
    check('saved key adds the autologin class before anything paints', d.documentElement.classList.contains('autologin'));
    check('dashboard opens by itself', !!(await until(() => d.getElementById('dashboard').hidden === false)));
    check('autologin class is removed once signed in', !d.documentElement.classList.contains('autologin'));
    check('login gate was never shown on the way', d.getElementById('login-gate').style.display === 'none');
    check('Group by request is restored', d.getElementById('log-group').checked === true);
    dom.window.close();

    // ── 9. Rejected saved key ──
    dom = await openAdmin('', { 'qproxy-admin-key': 'stale' }); dones.push(dom);
    w = dom.window; d = w.document;
    check('stale saved key falls back to the login screen with a message', !!(await until(() => /rejected/i.test(d.getElementById('login-error').textContent))));
    check('stale key is forgotten', w.localStorage.getItem('qproxy-admin-key') === null);
    check('autologin class removed after rejection', !d.documentElement.classList.contains('autologin'));
    dom.window.close();

    // ── 10. ?key= in the URL signs in and is stripped ──
    dom = await openAdmin('?key=' + KEY); dones.push(dom);
    w = dom.window; d = w.document;
    check('?key= signs in', !!(await until(() => d.getElementById('dashboard').hidden === false)));
    check('?key= is removed from the address bar', !/key=/.test(w.location.search), w.location.href);
    dom.window.close();

    // ── 11. Stay signed in unticked: nothing stored; Sign out clears ──
    dom = await openAdmin(''); dones.push(dom);
    w = dom.window; d = w.document; await sleep(200);
    d.getElementById('stay-signed-in').checked = false;
    setVal(w, d.getElementById('key-input'), KEY); click(w, d.getElementById('key-submit'));
    await until(() => d.getElementById('dashboard').hidden === false);
    check('unticked Stay signed in stores no key', w.localStorage.getItem('qproxy-admin-key') === null);
    w.localStorage.setItem('qproxy-admin-key', KEY);
    check('Sign out button exists', !!d.getElementById('signout-btn'));
    dom.window.close();
  } finally {
    finished = true;
    for (const x of dones) { try { x.window.close(); } catch (_) {} }
    child.kill('SIGTERM');
    await sleep(300);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  finished = true;
  console.log(`\n${failures ? 'SOME FAILED' : 'ALL PASS'} — ${passes} pass / ${failures} fail`);
  process.exit(failures ? 1 : 0);
}
// A page request that finishes just AFTER its window was closed rejects inside the page's own code (document is gone).
// That is a teardown race, not a bug in the admin page, so it is ignored once the test run is over - never before.
let finished = false;
process.on('unhandledRejection', (e) => {
  if (finished && /127\.0\.0\.1:\d+\/admin/.test(String(e && e.stack))) return;
  console.error(e); process.exit(2);
});
main().catch(e => { console.error(e); process.exit(2); });
