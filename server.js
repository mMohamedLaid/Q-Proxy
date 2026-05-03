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

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

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
  'glm-4.7':               { model: 'z-ai/glm4.7',                              thinking: null },
  'glm-4.7-think':         { model: 'z-ai/glm4.7',                              thinking: 'glm' },
};

function getExtraBody(thinkingType) {
  if (thinkingType === 'glm')  return { chat_template_kwargs: { enable_thinking: true, clear_thinking: false } };
  if (thinkingType === 'dsv4') return { chat_template_kwargs: { thinking: true, reasoning_effort: 'high' } };
  return undefined;
}

function parseThinkTags(rawText) {
  if (!rawText) return { reasoning: null, content: rawText };
  const match = rawText.match(/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
  if (match) return { reasoning: match[1].trim(), content: match[2].trim() };
  return { reasoning: null, content: rawText };
}

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

    // LOG FULL INCOMING REQUEST
    log('INFO', `[${userName}] REQUEST → model: ${model} | stream: ${stream || false}`);
    messages.forEach((m, i) => {
      log('DEBUG', `  [msg ${i}] ${m.role}: ${String(m.content).slice(0, 500)}`);
    });

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

    log('INFO', `[${userName}] → NVIDIA model: ${nimModel} | thinking type: ${thinkingType || 'off'}`);

    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      extra_body: getExtraBody(thinkingType),
      stream: stream || false
    };

    log('DEBUG', `extra_body sent: ${JSON.stringify(nimRequest.extra_body)}`);

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
      let thinkBuffer = '';
      let inThink = false;
      let thinkSent = false;
      let accumRaw = '';

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

            const nativeReasoning = delta.reasoning_content || null;
            const rawContent = delta.content || '';

            // LOG EVERY CHUNK
            log('DEBUG', `[CHUNK] native_reasoning: ${JSON.stringify(nativeReasoning?.slice(0,100))} | content: ${JSON.stringify(rawContent?.slice(0,100))}`);

            // if nvidia already returns reasoning_content natively, pass through
            if (nativeReasoning) {
              res.write(`data: ${JSON.stringify(data)}\n\n`);
              return;
            }

            accumRaw += rawContent;

            if (!inThink && !thinkSent) {
              if (accumRaw.includes('<think>')) {
                inThink = true;
                const start = accumRaw.indexOf('<think>') + 7;
                thinkBuffer += accumRaw.slice(start);
                accumRaw = '';
                return;
              } else if (accumRaw.length > 10 && !accumRaw.startsWith('<')) {
                thinkSent = true;
              }
            }

            if (inThink) {
              thinkBuffer += rawContent;
              if (thinkBuffer.includes('</think>')) {
                const end = thinkBuffer.indexOf('</think>');
                const reasoningText = thinkBuffer.slice(0, end).trim();
                const afterThink = thinkBuffer.slice(end + 8).trim();
                inThink = false;
                thinkSent = true;

                log('DEBUG', `[THINK PARSED] reasoning length: ${reasoningText.length}`);

                const reasoningChunk = {
                  ...data,
                  choices: [{
                    ...data.choices[0],
                    delta: { role: 'assistant', content: '', reasoning_content: reasoningText }
                  }]
                };
                res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);

                if (afterThink) {
                  delta.content = afterThink;
                  delete delta.reasoning_content;
                  res.write(`data: ${JSON.stringify(data)}\n\n`);
                }
              }
              return;
            }

            delta.content = rawContent;
            delete delta.reasoning_content;
            res.write(`data: ${JSON.stringify(data)}\n\n`);

          } catch (e) {
            log('ERROR', `chunk parse error: ${e.message}`);
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
      const rawText = response.data.choices[0]?.message?.content || '';
      const nativeReasoning = response.data.choices[0]?.message?.reasoning_content || null;

      // FULL DEBUG LOG OF NVIDIA RESPONSE
      log('DEBUG', `[${userName}] NVIDIA RAW RESPONSE:`);
      log('DEBUG', `  native reasoning_content: ${JSON.stringify(nativeReasoning?.slice(0, 300))}`);
      log('DEBUG', `  raw content (first 500): ${JSON.stringify(rawText.slice(0, 500))}`);

      const { reasoning, content } = parseThinkTags(rawText);

      log('DEBUG', `  parsed reasoning found: ${!!reasoning}`);
      log('DEBUG', `  parsed reasoning (first 200): ${JSON.stringify(reasoning?.slice(0, 200))}`);
      log('DEBUG', `  parsed content (first 200): ${JSON.stringify(content?.slice(0, 200))}`);

      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: response.data.choices.map((choice) => {
          const raw = choice.message?.content || '';
          const native = choice.message?.reasoning_content || null;
          const { reasoning: r, content: c } = parseThinkTags(raw);
          const finalReasoning = native || r;
          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content: c,
              ...(finalReasoning ? { reasoning_content: finalReasoning } : {})
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };

      res.json(openaiResponse);
    }

  } catch (error) {
    log('ERROR', `[${userName}] ${error.message} | status: ${error.response?.status}`);
    let errorBody = 'unavailable';
try { errorBody = JSON.stringify(error.response?.data); } catch(e) { errorBody = '[stream/timeout error]'; }
log('ERROR', `NVIDIA error body: ${errorBody}`);
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
