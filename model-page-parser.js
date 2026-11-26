// model-page-parser.js — reads the TEXT of a model's page (API reference tab, model card, playground panel,
// sample code, or OpenAPI/JSON) and pulls out what the admin panel needs: the reasoning_effort values, which one
// applies when the field is omitted, whether "off" exists, and max_tokens / temperature limits.
//
// Rules it follows (so a wrong guess can't hide):
//  • everything it reports comes with the VERBATIM line it was read from (`quotes`);
//  • when two places disagree (model-card prose vs API reference) it reports BOTH under `conflicts` and picks
//    nothing — a person decides;
//  • it never invents: no match -> the field is simply absent.
'use strict';

const EFFORT_WORDS = ['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const WORD_RE = new RegExp('\\b(' + EFFORT_WORDS.join('|') + ')\\b', 'gi');
const NEXT_PARAM_RE = /\b(max_tokens|max_completion_tokens|temperature|top_p|top_k|seed|stream|stop|frequency_penalty|presence_penalty|tools?|tool_choice|messages|response_format|n\b|logprobs|min_p)\b/i;
const HOSTS = new Set(['build.nvidia.com', 'docs.api.nvidia.com', 'huggingface.co']);

function htmlToText(html) {
  let h = String(html || '');
  const json = [];
  h = h.replace(/<script[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi, (_, j) => { json.push(j); return ' '; });
  h = h.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  h = h.replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  h = h.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
  return (h + '\n' + json.join('\n')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
}

function uniq(a) { return [...new Set(a)]; }
function oneLine(s, n = 220) { return String(s).replace(/\s+/g, ' ').trim().slice(0, n); }

// Values listed after a reasoning_effort mention, up to the next parameter name.
function effortBlocks(text) {
  const out = [];
  const re = /reasoning[_\s-]?effort/gi;
  const starts = [];
  let m;
  while ((m = re.exec(text))) starts.push({ index: m.index, len: m[0].length });
  for (let k = 0; k < starts.length; k++) {
    m = { index: starts[k].index, 0: text.substr(starts[k].index, starts[k].len) };
    const endCap = k + 1 < starts.length ? starts[k + 1].index : text.length;   // a window never runs into the NEXT mention
    let win = text.slice(m.index + m[0].length, Math.min(m.index + m[0].length + 600, endCap));
    const nx = win.search(NEXT_PARAM_RE);
    if (nx > 40) win = win.slice(0, nx);          // keep at least a little text: the enum often follows the name directly
    else if (nx >= 0 && nx <= 40) win = win.slice(0, 600);
    out.push({ at: m.index, win, head: text.slice(Math.max(0, m.index - 80), m.index + 40) });
  }
  return out;
}

function valuesFromWindow(win) {
  // 1) a JSON/enum list:  "enum": ["low","high","max"]   or   Available options: low, high, max   or   [low|high|max]
  const lists = [];
  let m = win.match(/enum[^\[]{0,20}\[([^\]]{1,200})\]/i);
  if (m) lists.push(m[1]);
  m = win.match(/(?:available options|allowed values|possible values|options|one of|values?)\s*[:\-]?\s*([^\n.]{3,160})/i);
  if (m) lists.push(m[1]);
  m = win.match(/\[\s*(?:"|')?(none|off|minimal|low|medium|high|xhigh|max)\b[^\]]{0,120}\]/i);
  if (m) lists.push(m[0]);
  m = win.match(/available options\s*:?\s*\n?([\s\S]{0,120})/i);
  if (m) lists.push(m[1]);
  for (const l of lists) {
    const found = (l.match(WORD_RE) || []).map(w => w.toLowerCase());
    if (found.length >= 2) return uniq(found);
  }
  // 2) a toggle row from the playground:  Low High Max   (words separated by whitespace only, 2+ in a row)
  m = win.match(/((?:\b(?:none|off|minimal|low|medium|high|xhigh|max)\b[\s,/|•·-]*){2,})/i);
  if (m) return uniq((m[1].match(WORD_RE) || []).map(w => w.toLowerCase()));
  return [];
}

function parseModelText(rawText) {
  const text = String(rawText || '');
  const res = { quotes: {}, conflicts: [], notes: [] };
  const blocks = effortBlocks(text);
  const candidates = [];
  for (const b of blocks) {
    const values = valuesFromWindow(b.win);
    // default / omitted behaviour
    let def = null, defQuote = null;
    let dm = b.win.match(/default(?:s)?(?:\s+(?:value|is|to|of))?\s*[:=]?\s*["'`]?\s*(none|off|minimal|low|medium|high|xhigh|max)\b/i)
      || b.win.match(/["'`](none|off|minimal|low|medium|high|xhigh|max)["'`]\s*\(default\)/i)
      || b.win.match(/\bdefault\b[^\n]{0,40}?\b(none|off|minimal|low|medium|high|xhigh|max)\b/i);
    if (dm) { def = dm[1].toLowerCase(); defQuote = oneLine(dm[0]); }
    let omitted = null, omitQuote = null;
    const om = b.win.match(/(?:omitted|not (?:set|provided|specified|passed)|if (?:you )?(?:omit|don'?t (?:set|pass|provide)))[^.\n]{0,80}?\b(none|off|disabled|minimal|low|medium|high|xhigh|max)\b/i);
    if (om) { omitted = om[1].toLowerCase(); omitQuote = oneLine(om[0]); }
    // a single value shown in sample code: "reasoning_effort": "low"
    const single = text.slice(b.at, b.at + 80).match(/reasoning[_\s-]?effort["'`]?\s*[:=]\s*["'`]?(none|off|minimal|low|medium|high|xhigh|max)\b/i);
    if (values.length || def || omitted || single) candidates.push({ at: b.at, rawWin: b.win, values, def, defQuote, omitted, omitQuote, single: single ? single[1].toLowerCase() : null, quote: oneLine(text.slice(b.at, b.at + 200)) });
  }
  if (candidates.length) {
    // The candidate with the longest value list is the real parameter description; the rest are examples/prose.
    // API-reference wording ("enum", "Available options") outranks prose and sample code; then the longer list.
    const apiStyle = c => /enum|available options/i.test(c.rawWin || '') ? 100 : 0;
    const withVals = candidates.filter(c => c.values.length).sort((a, b) => (apiStyle(b) + b.values.length) - (apiStyle(a) + a.values.length));
    const best = withVals[0] || null;
    if (best) {
      res.reasoningEffort = { values: best.values, default: best.def || null, omittedMeans: best.omitted || null, hasOff: best.values.some(v => v === 'none' || v === 'off'), chosenFrom: apiStyle(best) ? 'API-reference wording' : 'first match' };
      res.quotes.reasoningEffort = best.quote;
      if (best.defQuote) res.quotes.default = best.defQuote;
      if (best.omitQuote) res.quotes.omitted = best.omitQuote;
      // Other places listing a DIFFERENT set of values
      for (const c of withVals.slice(1)) {
        if (c.values.slice().sort().join() !== best.values.slice().sort().join()) res.conflicts.push({ what: 'reasoning_effort values', a: { values: best.values, quote: best.quote }, b: { values: c.values, quote: c.quote } });
      }
      const defs = uniq(candidates.map(c => c.def).filter(Boolean));
      if (defs.length > 1) res.conflicts.push({ what: 'reasoning_effort default', values: defs });
    } else {
      const only = candidates.find(c => c.single || c.def);
      if (only) {
        res.reasoningEffort = { values: only.single ? [only.single] : [], default: only.def || null, omittedMeans: only.omitted || null, hasOff: false, partial: true };
        res.quotes.reasoningEffort = only.quote;
        res.notes.push('Only one effort value was visible (a sample); the full list was not on this text. Paste the API Reference or playground text too.');
      }
    }
  }
  // Is there a separate thinking on/off control?
  const tg = text.match(/\b(enable_thinking|clear_thinking|thinking_toggle|thinking)\b[^\n]{0,60}\b(true|false|on|off|toggle)\b/i);
  if (tg) { res.thinkingControl = { key: tg[1].toLowerCase(), quote: oneLine(tg[0]) }; }
  // Always-on hints
  const always = text.match(/[^.\n]*(?:always on|cannot be (?:turned |switched )?off|no (?:off|none) (?:option|setting)|thinking is (?:always )?(?:enabled|on))[^.\n]*/i);
  if (always) res.notes.push('Possible "thinking always on" wording: "' + oneLine(always[0], 160) + '"');
  // max_tokens / temperature
  const mt = text.match(/max_tokens[\s\S]{0,260}/i);
  if (mt) {
    const seg = mt[0];
    const dflt = seg.match(/default[^0-9\n]{0,20}(\d[\d,]*)/i);
    const mx = seg.match(/(?:maximum|max(?:imum)?|up to|≤|<=)\s*(?:value)?\s*(?:of|is|:)?\s*(\d[\d,]*)/i);
    res.maxTokens = {};
    if (dflt) res.maxTokens.default = Number(dflt[1].replace(/,/g, ''));
    if (mx) res.maxTokens.max = Number(mx[1].replace(/,/g, ''));
    if (!Object.keys(res.maxTokens).length) delete res.maxTokens; else res.quotes.maxTokens = oneLine(seg, 200);
  }
  const tp = text.match(/temperature[\s\S]{0,200}/i);
  if (tp) {
    const mm = tp[0].match(/(?:range|between|from)?\s*(\d(?:\.\d+)?)\s*(?:to|–|-|and)\s*(\d(?:\.\d+)?)/i);
    const d = tp[0].match(/default[^0-9\n]{0,20}(\d(?:\.\d+)?)/i);
    if (mm || d) { res.temperature = { ...(mm ? { min: Number(mm[1]), max: Number(mm[2]) } : {}), ...(d ? { default: Number(d[1]) } : {}) }; res.quotes.temperature = oneLine(tp[0], 160); }
  }
  if (!res.reasoningEffort) res.notes.push('No reasoning_effort found in this text. Either the model has no such control, or the text pasted was not the parameters section.');
  return res;
}

// Accepts a URL on an allowed host. Returns { text } or { error }. `getter(url)` = axios.get-like.
async function fetchPageText(url, getter) {
  let u;
  try { u = new URL(url); } catch (_) { return { error: 'That is not a valid URL.' }; }
  if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) return { error: `Only ${[...HOSTS].join(', ')} pages can be fetched. Paste the page text instead.` };
  let r;
  try { r = await getter(u.toString()); } catch (e) { return { error: `Could not fetch the page (${e.response?.status || ''} ${e.message}). Paste its text instead.` }; }
  const body = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  const text = htmlToText(body);
  if (!/reasoning|max_tokens|temperature/i.test(text)) return { error: 'The page came back as an empty shell (these pages are drawn by the browser, so the server only sees the frame). Open the page, select the API Reference / Parameters text (or the playground panel), copy it and paste it here.' };
  return { text };
}

module.exports = { parseModelText, htmlToText, fetchPageText, HOSTS };
