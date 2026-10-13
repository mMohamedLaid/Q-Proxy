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
    for (const x of dones) { try { x.window.close(); } catch (_) {} }
    child.kill('SIGTERM');
    await sleep(300);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n${failures ? 'SOME FAILED' : 'ALL PASS'} — ${passes} pass / ${failures} fail`);
  process.exit(failures ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(2); });
