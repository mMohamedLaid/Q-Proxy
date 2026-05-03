// server.js - OpenAI to NVIDIA NIM Proxy with Rate Limiting
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// ============================================================
// MODE SELECT
// ============================================================
const MODE = 'solo';

const SOLO_KEYS = {
  '+cEvv5KDLGDSbuSftoNz/w==': { name: 'me', limit: 40 }
};

const SHARED_KEYS = {
  '+cEvv5KDLGDSbuSftoNz/w==': { name: 'me',    limit: 20   },
  'vC8NZQB8Xftj0atRLeu2qg==': { name: 'user1', limit: null },
  // 'WPwGYwkQYedarBCVUvFDZA==': { name: 'user2', limit: null },
  // 'hsVnNhc9Fua73jSLo8NYOw==': { name: 'user3', limit: null },
  // '7ianBRihV4OaWrI8BKaJeA==': { name: 'user4', limit: null },
};

function buildKeyMap() {
  if (MODE === 'solo') return SOLO_KEYS;
  const keys = { ...SHARED_KEYS };
  const userKeys = Object.entries(keys).filter(([_, v]) => v.limit === null);
  const userCount = userKeys.length;
  const perUser = userCount > 0 ? Math.floor(20 / userCount) : 0;
  for (const [k, v] of userKeys) keys[k] = { ...v, limit: perUser };
  return keys;
}

const usageTracker = {};

function checkRateLimit(apiKey) {
  const keyMap = buildKeyMap();
  const keyInfo = keyMap[apiKey];
  if (!keyInfo) return { allowed: false, reason: 'Invalid API key' };
  const now = Date.now();
  if (!usageTracker[apiKey] || now > usageTracker[apiKey].resetAt) {
    usageTracker[apiKey] = { count: 0, resetAt: now + 60000 };
  }
  if (usageTracker[apiKey].count >= keyInfo.limit) {
    const waitSec = Math.ceil((usageTracker[apiKey].resetAt - now) / 1000);
    return { allowed: false, reason: `Rate limit hit. Try again in ${waitSec}s` };
  }
  usageTracker[apiKey].count++;
  return { allowed: true };
}

// ============================================================
// LOGGING
// ============================================================
function log(level, msg, extra = '') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg} ${extra}`);
}

// ============================================================
// MODEL MAPPING
// thinking: null = none, 'glm' = GLM style, 'dsv4' = DeepSeek V4 style
// ============================================================
const MODEL_MAPPING = {
  'gpt-3.5-turbo':         { model: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', thinking: null },
  'gpt-4':                 { model: 'qwen/qwen3-coder-480b-a35b-instruct',      thinking: null },
  'gpt-4-turbo':           { model: 'moonshotai/kimi-k2-instruct-0905',         thinking: null },
  'gpt-4o':                { model: 'deepseek-ai/deepseek-v3.1',                thinking: null },
  'claude-3-opus':         { model: 'openai/gpt-oss-120b',                      thinking: null },
  'claude-3-sonnet':       { model: 'openai/gpt-oss-20b',                       thinking: null },
  'glm-5.1':               { model: 'z-ai/glm-5.1',                             thinking: null },
  'glm-5.1-think':         { model: 'z-ai/glm-5.1',                             thinking: 'glm'  },
  'deepseek-v3.2':         { model: 'deepseek-ai/deepseek-v3.2',                thinking: null },
  'deepseek-v3.2-think':   { model: 'deepseek-ai/deepseek-v3.2',                thinking: 'dsv4' },
  'deepseek-v4-pro':       { model: 'deepseek-ai/deepseek-v4-pro',              thinking: null },
  'deepseek-v4-pro-think': { model: 'deepseek-ai/deepseek-v4-pro',              thinking: 'dsv4' },
};

function getExtraBody(thinkingType) {
  if (thinkingType === 'glm')  return { chat_template_kwargs: { enable_thinking: true, clear_thinking: false } };
  if (thinkingType === 'dsv4') return { chat_template_kwargs: { thinking: true, reasoning_effort: 'high' } };
  return undefined;
}

// ============================================================
// PARSE <think> TAGS FROM RAW TEXT
// Splits raw model output into { reasoning, content }
// ============================================================
function parseThinkTags(rawText) {
  if (!rawText) return { reasoning: null, content: rawText };
  const match = rawText.match(/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
  if (match) {
    return { reasoning: match[1].trim(), content: match[2].trim() };
  }
  return { reasoning: null, content: rawText };
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  const keyMap = buildKeyMap();
  const now = Date.now();
  const status = Object.entries(keyMap).map(([key, info]) => ({
    name: info.name,
    limit: info.limit,
    used: usageTracker[key]?.count || 0,
    resetsIn: usageTracker[key]
      ? Math.max(0, Math.ceil((usageTracker[key].resetAt - now) / 1000)) + 's'
      : 'n/a'
  }));
  res.json({ status: 'ok', mode: MODE, users: status });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(m => ({
    id: m, object: 'model', created: Date.now(), owned_by: 'nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

// ============================================================
// CHAT ENDPOINT
// ============================================================
app.post('/v1/chat/completions', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const userKey = authHeader.replace('Bearer ', '').trim();
  const keyMap = buildKeyMap();
  const userName = keyMap[userKey]?.name || 'unknown';

  const rateCheck = checkRateLimit(userKey);
  if (!rateCheck.allowed) {
    log('WARN', `[${userName}] Rate limit hit`);
    return res.status(429).json({
      error: { message: rateCheck.reason, type: 'rate_limit_error', code: 429 }
    });
  }

  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    const mapping = MODEL_MAPPING[model];
    let nimModel, thinkingType;

    if (mapping) {
      nimModel = mapping.model;
      thinkingType = mapping.thinking;
    } else {
      thinkingType = null;
      const ml = model.toLowerCase();
      if (ml.includes('gpt-4') || ml.includes('405b')) nimModel = 'meta/llama-3.1-405b-instruct';
      else if (ml.includes('claude') || ml.includes('70b')) nimModel = 'meta/llama-3.1-70b-instruct';
      else nimModel = 'meta/llama-3.1-8b-instruct';
    }

    log('INFO', `[${userName}] → ${nimModel} | thinking: ${thinkingType || 'off'} | stream: ${stream || false}`);

    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      extra_body: getExtraBody(thinkingType),
      stream: stream || false
    };

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json'
      }
    );

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      // for streaming: accumulate raw text to detect <think> tags
      let rawAccum = '';
      let thinkSent = false;
      let thinkBuffer = '';
      let inThink = false;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(line => {
          if (!line.startsWith('data: ')) return;
          if (line.includes('[DONE]')) { res.write(line + '\n\n'); return; }

          try {
            const data = JSON.parse(line.slice(6));
            const delta = data.choices?.[0]?.delta;
            if (!delta) { res.write(`data: ${JSON.stringify(data)}\n\n`); return; }

            let rawContent = delta.content || '';
            // also catch if NVIDIA already returns reasoning_content natively
            let nativeReasoning = delta.reasoning_content || null;

            if (nativeReasoning) {
              // NVIDIA returned it properly — pass it straight through
              delta.reasoning_content = nativeReasoning;
              res.write(`data: ${JSON.stringify(data)}\n\n`);
              return;
            }

            // Parse <think> tags from streaming text
            rawAccum += rawContent;

            if (!inThink && !thinkSent) {
              if (rawAccum.includes('<think>')) {
                inThink = true;
                const start = rawAccum.indexOf('<think>') + 7;
                thinkBuffer += rawAccum.slice(start);
                rawAccum = '';
              } else if (!rawAccum.startsWith('<')) {
                // no think tag coming, just send content normally
                thinkSent = true;
                delta.content = rawContent;
                delete delta.reasoning_content;
                res.write(`data: ${JSON.stringify(data)}\n\n`);
              }
              // else: might still be partial <think> tag, wait
              return;
            }

            if (inThink) {
              thinkBuffer += rawContent;
              if (thinkBuffer.includes('</think>')) {
                const end = thinkBuffer.indexOf('</think>');
                const reasoningText = thinkBuffer.slice(0, end).trim();
                const afterThink = thinkBuffer.slice(end + 8).trim();
                inThink = false;
                thinkSent = true;

                // send reasoning chunk
                const reasoningChunk = {
                  ...data,
                  choices: [{
                    ...data.choices[0],
                    delta: { role: 'assistant', content: '', reasoning_content: reasoningText }
                  }]
                };
                res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);

                // send content after </think> if any
                if (afterThink) {
                  delta.content = afterThink;
                  delta.reasoning_content = null;
                  res.write(`data: ${JSON.stringify(data)}\n\n`);
                }
              }
              return;
            }

            // normal content after thinking done
            delta.content = rawContent;
            delete delta.reasoning_content;
            res.write(`data: ${JSON.stringify(data)}\n\n`);

          } catch (e) {
            res.write(line + '\n');
          }
        });
      });

      response.data.on('end', () => {
        log('INFO', `[${userName}] ✓ stream complete`);
        res.end();
      });
      response.data.on('error', (err) => {
        log('ERROR', `[${userName}] stream error: ${err.message}`);
        res.end();
      });

    } else {
      // non-streaming: parse <think> tags from full response
      const choice = response.data.choices[0];
      const rawText = choice.message?.content || '';
      const { reasoning, content } = parseThinkTags(rawText);

      log('INFO', `[${userName}] ✓ reply received | has_thinking: ${!!reasoning} | chars: ${content.length}`);

      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: response.data.choices.map((choice, i) => {
          const raw = choice.message?.content || '';
          const { reasoning: r, content: c } = parseThinkTags(raw);
          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content: c,
              ...(r ? { reasoning_content: r } : {})
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };

      res.json(openaiResponse);
    }

  } catch (error) {
    log('ERROR', `Proxy error: ${error.message} | status: ${error.response?.status}`);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found`, type: 'invalid_request_error', code: 404 } });
});

app.listen(PORT, () => {
  log('INFO', `Proxy running on port ${PORT} — mode: ${MODE}`);
});
