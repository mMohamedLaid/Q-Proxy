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

const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

// ============================================================
// MODE SELECT
// 'solo'   = just you, full 40/min
// 'shared' = you get 20 locked, users split remaining 20
// ============================================================
const MODE = 'solo'; // change to 'shared' when adding users
// ============================================================

// ============================================================
// SOLO MODE
// ============================================================
const SOLO_KEYS = {
  '+cEvv5KDLGDSbuSftoNz/w==': { name: 'me', limit: 40 }
};

// ============================================================
// SHARED MODE
// Uncomment user lines as needed. Limits auto-calculate.
// 1 user  → gets 20/min
// 2 users → each gets 10/min
// 3 users → each gets 6/min
// 4 users → each gets 5/min
// ============================================================
const SHARED_KEYS = {
  '+cEvv5KDLGDSbuSftoNz/w==': { name: 'me',    limit: 20   },
  'vC8NZQB8Xftj0atRLeu2qg==': { name: 'user1', limit: null },
  // 'WPwGYwkQYedarBCVUvFDZA==': { name: 'user2', limit: null },
  // 'hsVnNhc9Fua73jSLo8NYOw==': { name: 'user3', limit: null },
  // '7ianBRihV4OaWrI8BKaJeA==': { name: 'user4', limit: null },
};

// ============================================================
// AUTO CALCULATES user limits
// ============================================================
function buildKeyMap() {
  if (MODE === 'solo') return SOLO_KEYS;

  const keys = { ...SHARED_KEYS };
  const userKeys = Object.entries(keys).filter(([_, v]) => v.limit === null);
  const userCount = userKeys.length;
  const remaining = 40 - 20;
  const perUser = userCount > 0 ? Math.floor(remaining / userCount) : 0;

  for (const [k, v] of userKeys) {
    keys[k] = { ...v, limit: perUser };
  }

  return keys;
}

// ============================================================
// RATE LIMIT TRACKER
// ============================================================
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
// MODEL MAPPING
// ============================================================
const MODEL_MAPPING = {
  'gpt-3.5-turbo':  'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4':          'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo':    'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o':         'deepseek-ai/deepseek-v3.1',
  'claude-3-opus':  'openai/gpt-oss-120b',
  'claude-3-sonnet':'openai/gpt-oss-20b',
  'gemini-pro':     'qwen/qwen3-next-80b-a3b-thinking',
  'glm-5.1': 'z-ai/glm-5.1',
  'deepseek-v4-pro':'deepseek-ai/deepseek-v4-pro',
  'deepseek-v3.2':  'deepseek-ai/deepseek-v3.2',
};

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

// ============================================================
// MODELS LIST
// ============================================================
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nim-proxy'
  }));
  res.json({ object: 'list', data: models });
});

// ============================================================
// CHAT ENDPOINT
// ============================================================
app.post('/v1/chat/completions', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const userKey = authHeader.replace('Bearer ', '').trim();

  const rateCheck = checkRateLimit(userKey);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: { message: rateCheck.reason, type: 'rate_limit_error', code: 429 }
    });
  }

  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      const modelLower = model.toLowerCase();
      if (modelLower.includes('gpt-4') || modelLower.includes('405b')) {
        nimModel = 'meta/llama-3.1-405b-instruct';
      } else if (modelLower.includes('claude') || modelLower.includes('70b')) {
        nimModel = 'meta/llama-3.1-70b-instruct';
      } else {
        nimModel = 'meta/llama-3.1-8b-instruct';
      }
    }

    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 9024,
      extra_body: ENABLE_THINKING_MODE
        ? { chat_template_kwargs: { thinking: true } }
        : undefined,
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
      let reasoningStarted = false;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) { res.write(line + '\n'); return; }
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;

                if (SHOW_REASONING) {
                  let combined = '';
                  if (reasoning && !reasoningStarted) { combined = '<think>\n' + reasoning; reasoningStarted = true; }
                  else if (reasoning) { combined = reasoning; }
                  if (content && reasoningStarted) { combined += '</think>\n\n' + content; reasoningStarted = false; }
                  else if (content) { combined += content; }
                  if (combined) { data.choices[0].delta.content = combined; delete data.choices[0].delta.reasoning_content; }
                } else {
                  data.choices[0].delta.content = content || '';
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) { res.write(line + '\n'); }
          }
        });
      });

      response.data.on('end', () => res.end());
      response.data.on('error', () => res.end());

    } else {
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: response.data.choices.map(choice => {
          let content = choice.message?.content || '';
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            content = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + content;
          }
          return {
            index: choice.index,
            message: { role: choice.message.role, content },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      res.json(openaiResponse);
    }

  } catch (error) {
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
  console.log(`Proxy running on port ${PORT} — mode: ${MODE}`);
});
