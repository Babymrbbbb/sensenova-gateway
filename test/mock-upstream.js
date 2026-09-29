'use strict';
/*
 * 模拟 SenseNova 上游（仅供网关自测，不含任何真实请求）
 * 行为表：ok / 429 / 401 / 500，可通过控制接口随时切换。
 */
const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 8899);
const KNOWN = new Set(['sk-mock-a', 'sk-mock-b', 'sk-mock-c', 'sk-mock-d']);

const behavior = {}; // key -> { mode, times }
const stats = {}; // key -> { calls, lastModel, statuses: [] }

function setBehavior(key, mode, times) {
  behavior[key] = { mode, times: times == null ? Infinity : Number(times) };
}

function bump(key, status, model) {
  stats[key] = stats[key] || { calls: 0, lastModel: null, statuses: [] };
  stats[key].calls++;
  stats[key].lastModel = model || stats[key].lastModel;
  stats[key].statuses.push(status);
}

function nextStatus(key) {
  const b = behavior[key];
  if (!b || b.mode === 'ok') return 200;
  if (b.times > 0) {
    if (Number.isFinite(b.times)) b.times--;
    return Number(b.mode);
  }
  return 200;
}

function sse(res, model, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  const parts = text.split(' ');
  parts.forEach((p) => {
    res.write(
      'data: ' + JSON.stringify({ choices: [{ delta: { content: p + ' ' }, finish_reason: '' }], model }) + '\n\n'
    );
  });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], model }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8');

  if (req.url === '/_mock/behavior' && req.method === 'POST') {
    const b = JSON.parse(raw || '{}');
    if (b.key) setBehavior(b.key, b.mode, b.times);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, behavior }));
  }
  if (req.url === '/_mock/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ stats, behavior }, null, 2));
  }

  const auth = String(req.headers['authorization'] || '');
  const key = auth.replace(/^Bearer\s+/i, '').trim();
  let body = {};
  try {
    body = JSON.parse(raw || '{}');
  } catch (e) {}

  if (!KNOWN.has(key)) {
    bump(key || '(none)', 401, null);
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'invalid api key: ' + key, type: 'authentication_error' } }));
  }

  const status = nextStatus(key);
  bump(key, status, body.model);

  if (status !== 200) {
    const map = {
      401: { message: 'invalid api key', type: 'authentication_error' },
      429: { message: 'quota exceeded (mock)', type: 'quota_exceeded_error' },
      500: { message: 'internal server error (mock)', type: 'server_error' }
    };
    res.writeHead(status, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: map[status] || { message: 'mock error' } }));
  }

  const model = body.model || 'none';
  if (body.stream) return sse(res, model, 'pong from mock upstream');

  const payload = {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'pong｜model=' + model + '｜key=' + key }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 }
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
});

server.listen(PORT, '127.0.0.1', () => {
  console.error('[mock] listening on http://127.0.0.1:' + PORT);
});
