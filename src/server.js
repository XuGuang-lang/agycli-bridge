import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { loadConfig } from './config.js';
import { resolveAgy, getVersion, listModels, run } from './agy.js';
import { buildPrompt, OutputSanitizer, StopWatcher } from './messages.js';

const cfg = loadConfig();
let bin;
let modelCache = [];
const startedAt = Date.now();

// ---------------------------------------------------------------- concurrency

let active = 0;
const waiting = [];

function acquire() {
  if (active < cfg.maxConcurrent) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active = Math.max(0, active - 1);
}

// --------------------------------------------------------------- http helpers

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

function sendError(res, status, message, type = 'invalid_request_error') {
  if (res.headersSent) return res.end();
  sendJson(res, status, { error: { message, type, code: status } });
}

function readBody(req, limitBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!cfg.apiKey) return true;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return token === cfg.apiKey || req.headers['x-api-key'] === cfg.apiKey;
}

// ------------------------------------------------------------- model handling

const EFFORTS = new Set(['low', 'medium', 'high']);

/**
 * Accepts "model" or "model:effort" so a client that can only set a model name
 * can still pick a reasoning effort.
 */
function parseModel(requested) {
  let model = (requested || '').trim() || cfg.model;
  let effort = cfg.effort;

  const idx = model.lastIndexOf(':');
  if (idx > 0) {
    const suffix = model.slice(idx + 1).toLowerCase();
    if (EFFORTS.has(suffix)) {
      effort = suffix;
      model = model.slice(0, idx);
    }
  }
  return { model: model || cfg.model, effort };
}

// ------------------------------------------------------------------ endpoints

function handleModels(res) {
  const list = modelCache.length ? modelCache : [{ id: cfg.model, name: cfg.model }];
  sendJson(res, 200, {
    object: 'list',
    data: list.map((m) => ({
      id: m.id,
      object: 'model',
      created: Math.floor(startedAt / 1000),
      owned_by: 'antigravity',
    })),
  });
}

function handleHealth(res) {
  sendJson(res, 200, {
    status: 'ok',
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    agy: { path: bin.command, version: bin.version },
    active_requests: active,
    queued_requests: waiting.length,
    default_model: cfg.model,
    models_known: modelCache.length,
  });
}

function chunkPayload(id, model, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function toOpenAiUsage(usage) {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
}

async function handleChatCompletions(req, res, body) {
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return sendError(res, 400, 'Request body is not valid JSON');
  }
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return sendError(res, 400, '"messages" must be a non-empty array');
  }

  const { model, effort } = parseModel(payload.model);
  const stream = payload.stream === true;
  const { prompt, turns } = buildPrompt(payload.messages, cfg);

  if (!prompt.trim()) {
    return sendError(res, 400, 'Refusing to send an empty prompt');
  }

  const id = 'chatcmpl-' + randomUUID();
  const controller = new AbortController();
  // `res` close is the reliable disconnect signal: `req` has already emitted
  // end (the body was fully read), so its close does not track the client.
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  await acquire();

  const sanitizer = new OutputSanitizer(cfg);
  const stopper = new StopWatcher(payload.stop);
  let collected = '';
  let sentAny = false;

  if (cfg.debug) {
    console.error(`[req] ${model}${effort ? ':' + effort : ''} turns=${turns} ` +
      `stream=${stream} chars=${prompt.length}`);
  }

  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`data: ${JSON.stringify(chunkPayload(id, model, { role: 'assistant' }))}\n\n`);
    }

    const emit = (raw) => {
      const cleaned = sanitizer.push(raw);
      if (!cleaned) return false;
      const { text, stop } = stopper.push(cleaned);
      if (text) {
        sentAny = true;
        if (stream) {
          res.write(`data: ${JSON.stringify(chunkPayload(id, model, { content: text }))}\n\n`);
        } else {
          collected += text;
        }
      }
      return stop; // true tells runOnce to kill the process
    };

    const onDelta = (delta) => emit(delta);

    const result = await run({
      bin, prompt, model, effort, cfg, onDelta, signal: controller.signal,
    });

    // Flush whatever the sanitizer/stop-watcher was still holding back.
    const tail = sanitizer.flush();
    if (tail) {
      const { text } = stopper.push(tail);
      if (text) {
        sentAny = true;
        if (stream) {
          res.write(`data: ${JSON.stringify(chunkPayload(id, model, { content: text }))}\n\n`);
        } else {
          collected += text;
        }
      }
    }
    const held = stopper.flush();
    if (held) {
      sentAny = true;
      if (stream) {
        res.write(`data: ${JSON.stringify(chunkPayload(id, model, { content: held }))}\n\n`);
      } else {
        collected += held;
      }
    }

    const finishReason = 'stop';
    const usage = toOpenAiUsage(result.usage);

    if (stream) {
      const final = chunkPayload(id, model, {}, finishReason);
      if (usage) final.usage = usage;
      res.write(`data: ${JSON.stringify(final)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: collected },
          finish_reason: finishReason,
        }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
  } catch (err) {
    if (err.code === 'EABORTED') {
      if (!res.writableEnded) res.end();
      return;
    }
    const status = err.code === 'ETIMEDOUT' ? 504 : 502;
    console.error(`[error] ${err.message}`);

    if (res.headersSent) {
      // Headers are out, so the status code can no longer carry the error.
      // Close the stream cleanly rather than writing the message into the
      // content: injected text would land in the chat log as if the character
      // had said it. The failure is already logged above.
      if (stream && !res.writableEnded) {
        const reason = sentAny ? 'stop' : 'length';
        res.write(`data: ${JSON.stringify(chunkPayload(id, model, {}, reason))}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      if (!res.writableEnded) res.end();
    } else {
      sendError(res, status, err.message, 'upstream_error');
    }
  } finally {
    release();
  }
}

// -------------------------------------------------------------------- routing

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (route === '/' || route === '/health') return handleHealth(res);

  if (!authorized(req)) {
    return sendError(res, 401, 'Invalid API key', 'authentication_error');
  }

  if (req.method === 'GET' && (route === '/v1/models' || route === '/models')) {
    return handleModels(res);
  }

  if (req.method === 'POST' &&
      (route === '/v1/chat/completions' || route === '/chat/completions')) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendError(res, 413, err.message);
    }
    return handleChatCompletions(req, res, body);
  }

  sendError(res, 404, `No route for ${req.method} ${route}`);
});

// Long generations must not be cut off by the server's own timers.
server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 75_000;

// ---------------------------------------------------------------------- start

function main() {
  try {
    bin = resolveAgy(cfg.agyPath);
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
  bin.version = getVersion(bin);
  modelCache = listModels(bin);

  server.listen(cfg.port, cfg.host, () => {
    const base = `http://${cfg.host}:${cfg.port}`;
    console.log('');
    console.log('  agycli-bridge  —  Antigravity CLI as an OpenAI-compatible API');
    console.log('  ' + '-'.repeat(58));
    console.log(`  endpoint      ${base}/v1`);
    console.log(`  agy           ${bin.command}`);
    console.log(`  version       ${bin.version}`);
    console.log(`  model         ${cfg.model}${cfg.effort ? ' (effort: ' + cfg.effort + ')' : ''}`);
    console.log(`  models known  ${modelCache.length || 'none (agy models failed)'}`);
    console.log(`  concurrency   ${cfg.maxConcurrent}`);
    console.log(`  auth          ${cfg.apiKey ? 'API key required' : 'open (no key)'}`);
    console.log(`  workdir       ${cfg.workdir}`);
    console.log('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  Port ${cfg.port} is already in use. ` +
        `Set "port" in config.json or BRIDGE_PORT.\n`);
    } else {
      console.error(`\n  Server error: ${err.message}\n`);
    }
    process.exit(1);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('\n  shutting down');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  }
}

main();
