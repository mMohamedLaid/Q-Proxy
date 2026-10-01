// test/mock-axios.js — require-hook that replaces axios for `node -r` runs,
// per the workflow in handof.md ("test with a mocked axios").
//
// Usage:
//   MOCK_FILE=./test/scenario.json node -r ./test/mock-axios.js server.js
//
// The scenario file is re-read on EVERY upstream call, so a test driver can
// rewrite it between requests without restarting the server. Streaming
// responses are real EventEmitters, so the server's data/end/error/close
// handlers exercise exactly the same code paths as a live provider.
'use strict';
const Module = require('module');
const fs = require('fs');
const { EventEmitter } = require('events');

function scenario() {
  try {
    return JSON.parse(fs.readFileSync(process.env.MOCK_FILE || 'test/scenario.json', 'utf8'));
  } catch (e) {
    return { mode: 'error', status: 500, body: 'no scenario file: ' + e.message };
  }
}

function sse(obj) { return `data: ${JSON.stringify(obj)}\n\n`; }

// endMode: 'end' (normal) | 'error' (socket error) | 'close' (premature
// close that never emits end/error — the case that used to hang streams).
function makeStream(chunks, endMode, firstDelayMs) {
  const s = new EventEmitter();
  s.destroyed = false;
  s.destroy = () => { if (!s.destroyed) { s.destroyed = true; s.emit('close'); } };
  let i = 0;
  const tick = () => {
    if (i < chunks.length) { s.emit('data', Buffer.from(chunks[i++])); setTimeout(tick, 5); return; }
    if (endMode === 'end') s.emit('end');
    else if (endMode === 'error') s.emit('error', Object.assign(new Error('mock ECONNRESET'), { code: 'ECONNRESET' }));
    else if (endMode === 'close') s.emit('close');
  };
  setTimeout(tick, firstDelayMs || 10);
  return s;
}

const mockAxios = {
  post: async (url, body, config = {}) => {
    if (!/\/chat\/completions$/.test(url)) throw new Error('mock: unexpected POST ' + url);
    const sc = scenario();
    // 'hang': the provider never answers (a request stuck in its queue). Only an
    // abort via config.signal ends it — and that is recorded in <MOCK_FILE>.aborted
    // so a test can prove the proxy really cancelled the upstream call.
    if (sc.mode === 'hang') {
      return new Promise((resolve, reject) => {
        if (!config.signal) return;
        config.signal.addEventListener('abort', () => {
          try { fs.writeFileSync((process.env.MOCK_FILE || 'test/scenario.json') + '.aborted', String(Date.now())); } catch (_) {}
          reject(Object.assign(new Error('canceled'), { name: 'CanceledError', code: 'ERR_CANCELED' }));
        }, { once: true });
      });
    }
    if (sc.mode === 'upstream-error') {
      const err = new Error('Request failed with status code ' + sc.status);
      err.response = { status: sc.status, data: sc.body || 'mock error' };
      throw err;
    }
    if (body.stream) {
      const chunks = (sc.chunks || []).map(c => (c === '[DONE]' ? 'data: [DONE]\n\n' : sse(c)));
      return { status: 200, data: makeStream(chunks, sc.endMode || 'end', sc.firstChunkDelayMs) };
    }
    return {
      status: 200,
      data: sc.json || { choices: [{ message: { role: 'assistant', content: 'mock' }, finish_reason: 'stop' }], usage: { total_tokens: 5 } }
    };
  },
  // GET .../models -> scenario.models (array of ids), for the Admin sync endpoints.
  get: async (url) => {
    if (/\/models$/.test(url)) {
      const sc = scenario();
      return { status: 200, data: { data: (sc.models || []).map(id => ({ id })) } };
    }
    throw new Error('mock: unexpected GET ' + url);
  },
  put: async (url) => { throw new Error('mock: unexpected PUT ' + url); },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'axios') return mockAxios;
  return origLoad.apply(this, arguments);
};
