'use strict';
/*
 * SenseNova 多 Key 网关（零依赖 · Node >= 22）
 * ------------------------------------------------------------------
 * 作用：把 N 个 SenseNova 账号的 sk- key 聚合成一个本地 OpenAI 兼容端点，
 *      对外只暴露 127.0.0.1:<port>，自动轮询 / 故障转移 / 冷却 / 配额保护。
 *
 * 上游：https://token.sensenova.cn   （注意：平台页是 platform.sensenova.cn，两者不同）
 * 用法：node server.js
 *
 * 环境变量（可覆盖，便于测试）：
 *   SN_CONFIG / SN_KEYS / SN_STATE / SN_LOG_DIR
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CONFIG_PATH = process.env.SN_CONFIG || path.join(DIR, 'config.json');
const KEYS_PATH = process.env.SN_KEYS || path.join(DIR, 'keys.json');
const KEYS_TXT_PATH = path.join(DIR, 'keys.txt');
const STATE_PATH = process.env.SN_STATE || path.join(DIR, 'state.json');
const LOG_DIR = process.env.SN_LOG_DIR || path.join(DIR, 'logs');

const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  upstream: 'https://token.sensenova.cn',
  localToken: '',
  windowHours: 5,
  // 单账号-单模型每 5 小时请求数上限（官方控制台口径 1500，留 50 余量）
  maxRequestsPer5h: 1450,
  // 命中 429 后的冷却秒数（若窗口已满，则自动延到窗口滑动释放）
  cooldownSeconds: 300,
  // 401/403（key 失效）后的冷却秒数
  badKeyCooldownSeconds: 86400,
  // 单次请求最多尝试几个 key
  maxAttempts: 4,
  // 上游响应头/数据静默超时（毫秒）
  idleTimeoutMs: 120000,
  // 自定义模型别名：{ "对外模型名": "上游 model id" }
  aliases: {},
  defaultModel: 'sensenova-6.8-flash-lite',
  logRequests: true
};

function stripBom(s) {
  return s && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf-8')));
  } catch (e) {
    return fallback;
  }
}

function loadConfig() {
  const user = readJson(CONFIG_PATH, null);
  if (!user) {
    log('WARN', `config.json 缺失或损坏，使用内置默认值：${CONFIG_PATH}`);
  }
  const cfg = Object.assign({}, DEFAULTS, user || {});
  cfg.aliases = Object.assign({}, DEFAULTS.aliases, (user && user.aliases) || {});
  cfg.port = Number(cfg.port) || DEFAULTS.port;
  return cfg;
}

/* ---------------------------------------------------------------- 日志 */

let logStream = null;
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  try {
    if (!logStream) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      logStream = fs.createWriteStream(path.join(LOG_DIR, `gateway-${day}.log`), { flags: 'a' });
    }
    logStream.write(line + '\n');
  } catch (e) {
    /* 日志失败不影响主流程 */
  }
  process.stdout.write(line + '\n');
}

function mask(k) {
  if (!k || k.length < 12) return '***';
  return k.slice(0, 7) + '...' + k.slice(-4);
}

/* ---------------------------------------------------------------- Key 池 */

// 兼容多种粘贴格式：
//   {"keys":[{"name":"acc1","key":"sk-xx"}]} / {"keys":["sk-xx"]} / {"acc1":"sk-xx"} / ["sk-xx"]
//   或同级目录 keys.txt（一行一个 key，# 开头为注释）
function loadKeys() {
  let raw = readJson(KEYS_PATH, null);
  if (!raw && fs.existsSync(KEYS_TXT_PATH)) {
    const lines = stripBom(fs.readFileSync(KEYS_TXT_PATH, 'utf-8'))
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
    raw = { keys: lines };
  }
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && Array.isArray(raw.keys)) list = raw.keys;
  else if (raw && typeof raw === 'object') {
    list = Object.keys(raw)
      .filter((k) => k !== 'keys' && typeof raw[k] === 'string')
      .map((k) => ({ name: k, key: raw[k] }));
  }

  const out = [];
  const seen = new Set();
  list.forEach((item, i) => {
    const obj = typeof item === 'string' ? { name: '', key: item } : item || {};
    const key = String(obj.key || obj.apiKey || obj.token || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      name: String(obj.name || obj.account || `acc${i + 1}`).trim(),
      key
    });
  });
  return out;
}

let cfg = loadConfig();
let KEYS = loadKeys();

const STATE = readJson(STATE_PATH, { keys: {} });
STATE.keys = STATE.keys || {};

function keyState(name) {
  if (!STATE.keys[name]) {
    STATE.keys[name] = { coolUntil: 0, lastUsedAt: 0, window: {}, totals: { ok: 0, fail: 0, switched: 0 } };
  }
  const s = STATE.keys[name];
  s.window = s.window || {};
  s.totals = Object.assign({ ok: 0, fail: 0, switched: 0 }, s.totals || {});
  return s;
}

const windowMs = () => cfg.windowHours * 3600 * 1000;

function usedInWindow(name, model, now) {
  const s = keyState(name);
  const arr = s.window[model] || [];
  const cut = now - windowMs();
  let keepFrom = 0;
  while (keepFrom < arr.length && arr[keepFrom] < cut) keepFrom++;
  if (keepFrom > 0) s.window[model] = arr.slice(keepFrom);
  return (s.window[model] || []).length;
}

function recordUse(name, model, now) {
  const s = keyState(name);
  s.window[model] = s.window[model] || [];
  s.window[model].push(now);
  s.lastUsedAt = now;
}

let saveTimer = null;
function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify(STATE, null, 2), 'utf-8');
    } catch (e) {
      log('WARN', 'state.json 写入失败: ' + e.message);
    }
  }, 2000);
  if (saveTimer.unref) saveTimer.unref();
}

function pickKey(model, now, tried) {
  const cands = KEYS.filter((k) => {
    if (tried && tried.has(k.name)) return false;
    const s = keyState(k.name);
    return !(s.coolUntil && s.coolUntil > now);
  });
  if (!cands.length) return null;
  const scored = cands.map((k) => {
    const s = keyState(k.name);
    return { k, used: usedInWindow(k.name, model, now), last: s.lastUsedAt || 0 };
  });
  const under = scored.filter((x) => x.used < cfg.maxRequestsPer5h);
  const pool = under.length ? under : scored;
  pool.sort((a, b) => (a.used - b.used) || (a.last - b.last));
  return pool[0].k;
}

function coolKey(name, ms, why) {
  const s = keyState(name);
  s.coolUntil = Math.max(s.coolUntil || 0, Date.now() + ms);
  log('WARN', `key ${name} 进入冷却 ${Math.round(ms / 1000)}s（${why}）`);
  saveStateSoon();
}

function noteSuccess(name, model) {
  const now = Date.now();
  recordUse(name, model, now);
  keyState(name).totals.ok++;
  saveStateSoon();
}

function noteFailure(name) {
  keyState(name).totals.fail++;
  saveStateSoon();
}

/* ---------------------------------------------------------------- 转发 */

function upstreamBase() {
  return new URL(cfg.upstream);
}

function forward(method, upstreamPath, headers, bodyBuf, onHead) {
  return new Promise((resolve, reject) => {
    const base = upstreamBase();
    const lib = base.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || (base.protocol === 'https:' ? 443 : 80),
        method,
        path: upstreamPath,
        headers
      },
      (res) => {
        resolve(res);
      }
    );
    req.setTimeout(cfg.idleTimeoutMs, () => {
      req.destroy(new Error(`上游静默超时(${cfg.idleTimeoutMs}ms)`));
    });
    req.on('error', reject);
    if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

function drain(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

const RETRY_STATUS = new Set([401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 529]);

function cooldownFor(status, name, model, now) {
  if (status === 401 || status === 403) return cfg.badKeyCooldownSeconds * 1000;
  if (status === 429) {
    const s = keyState(name);
    const arr = s.window[model] || [];
    // 若窗口计数已达上限，说明是配额耗尽：冷却到最早那次请求滑出窗口
    if (arr.length >= cfg.maxRequestsPer5h) {
      const until = arr[0] + windowMs() - now;
      return Math.max(until, cfg.cooldownSeconds * 1000);
    }
    return cfg.cooldownSeconds * 1000;
  }
  return 30000;
}

function jsonError(res, status, message, extra) {
  const payload = Object.assign({ error: { message, type: 'gateway_error', code: status } }, extra || {});
  const buf = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

/* ---------------------------------------------------------------- 主服务 */

function pickModel(reqBody, reqPath) {
  let model = (reqBody && reqBody.model) || '';
  if (model && cfg.aliases[model]) model = cfg.aliases[model];
  if (!model && /\/chat\/completions|\/messages|\/responses/.test(reqPath)) model = cfg.defaultModel;
  return model || cfg.defaultModel;
}

function buildUpstreamHeaders(clientHeaders, key) {
  const h = {};
  Object.keys(clientHeaders).forEach((k) => {
    const lk = k.toLowerCase();
    if (['host', 'authorization', 'x-api-key', 'content-length', 'connection', 'accept-encoding'].includes(lk)) return;
    h[k] = clientHeaders[k];
  });
  h['authorization'] = 'Bearer ' + key;
  h['accept-encoding'] = 'identity';
  return h;
}

function authorized(req) {
  if (!cfg.localToken) return true;
  const auth = req.headers['authorization'] || '';
  if (auth === 'Bearer ' + cfg.localToken) return true;
  if (req.headers['x-api-key'] === cfg.localToken) return true;
  return false;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/health') {
    const now = Date.now();
    const healthy = KEYS.filter((k) => !(keyState(k.name).coolUntil > now));
    const buf = Buffer.from(
      JSON.stringify({
        ok: true,
        keys: KEYS.length,
        keysAvailable: healthy.length,
        upstream: cfg.upstream,
        windowHours: cfg.windowHours,
        maxRequestsPer5h: cfg.maxRequestsPer5h,
        time: new Date().toISOString()
      })
    );
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(buf);
  }

  if (pathname === '/stats') {
    const now = Date.now();
    const rows = KEYS.map((k) => {
      const s = keyState(k.name);
      const perModel = {};
      Object.keys(s.window).forEach((m) => {
        perModel[m] = usedInWindow(k.name, m, now);
      });
      return {
        name: k.name,
        key: mask(k.key),
        cooling: (s.coolUntil || 0) > now,
        coolRemainSec: Math.max(0, Math.round(((s.coolUntil || 0) - now) / 1000)),
        lastUsedAt: s.lastUsedAt ? new Date(s.lastUsedAt).toISOString() : null,
        used5h: perModel,
        totals: s.totals
      };
    });
    const buf = Buffer.from(JSON.stringify({ windowHours: cfg.windowHours, keys: rows }, null, 2));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(buf);
  }

  if (!pathname.startsWith('/v1')) {
    return jsonError(res, 404, '只代理 /v1/* 路径，例如 /v1/chat/completions', { hint: 'GET /health · GET /stats' });
  }

  if (!authorized(req)) {
    return jsonError(res, 401, '本地网关鉴权失败：请在 Authorization: Bearer <localToken> 中携带本地令牌（见 config.json 的 localToken）');
  }

  if (!KEYS.length) {
    return jsonError(res, 503, '网关里一个 API key 都没有。请把 sk- 开头的 key 填进 keys.json 后重启网关。', {
      fix: [{ file: KEYS_PATH, format: '{ "keys": [ { "name": "acc1", "key": "sk-xxxx" } ] }' }]
    });
  }

  // 读取请求体
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks);

  let reqBody = null;
  const ctype = String(req.headers['content-type'] || '');
  if (rawBody.length && ctype.includes('application/json')) {
    try {
      reqBody = JSON.parse(rawBody.toString('utf-8'));
    } catch (e) {
      return jsonError(res, 400, '请求体不是合法 JSON: ' + e.message);
    }
  }

  const model = pickModel(reqBody, pathname);
  if (reqBody && typeof reqBody === 'object' && reqBody.model !== model) {
    reqBody.model = model;
  }
  const isStream = !!(reqBody && reqBody.stream);
  const outBody = reqBody ? Buffer.from(JSON.stringify(reqBody)) : rawBody;

  // /v1/models：本地模型清单（别名 + 上游清单）
  if (pathname === '/v1/models' && req.method === 'GET') {
    const known = [
      'sensenova-6.8-flash-lite',
      'sensenova-u1.5-lite',
      'sensenova-u1.5-fast',
      'deepseek-v4-flash',
      'deepseek-flash',
      'glm-5.2',
      'kimi-k3'
    ].concat(Object.keys(cfg.aliases));
    const buf = Buffer.from(
      JSON.stringify({
        object: 'list',
        data: known.map((id) => ({ id, object: 'model', owned_by: 'sensenova-via-local-gateway' }))
      })
    );
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(buf);
  }

  const now = Date.now();
  const tried = new Set();
  let lastStatus = 0;
  let lastBody = null;
  let attempts = 0;

  while (attempts < Math.min(cfg.maxAttempts, KEYS.length + 1)) {
    const k = pickKey(model, Date.now(), tried);
    if (!k) break;
    tried.add(k.name);
    attempts++;

    const headers = buildUpstreamHeaders(req.headers, k.key);
    headers['content-length'] = String(outBody.length);

    let upstream;
    try {
      upstream = await forward(req.method, pathname + url.search, headers, outBody);
    } catch (e) {
      noteFailure(k.name);
      coolKey(k.name, 30000, '网络错误: ' + e.message);
      lastStatus = 502;
      lastBody = Buffer.from(JSON.stringify({ error: { message: '连接上游失败: ' + e.message } }));
      continue;
    }

    if (upstream.statusCode >= 400) {
      const body = await drain(upstream);
      noteFailure(k.name);
      lastStatus = upstream.statusCode;
      lastBody = body;
      if (RETRY_STATUS.has(upstream.statusCode) && attempts < Math.min(cfg.maxAttempts, KEYS.length)) {
        coolKey(k.name, cooldownFor(upstream.statusCode, k.name, model, now), 'HTTP ' + upstream.statusCode);
        keyState(k.name).totals.switched++;
        log('INFO', `${pathname} model=${model} key=${k.name} -> ${upstream.statusCode}，切换下一个 key`);
        continue;
      }
      log('INFO', `${pathname} model=${model} key=${k.name} -> ${upstream.statusCode}（不重试/已用尽）`);
      res.writeHead(upstream.statusCode, {
        'content-type': upstream.headers['content-type'] || 'application/json; charset=utf-8',
        'x-gateway-key': k.name,
        'x-gateway-attempts': String(attempts)
      });
      return res.end(body);
    }

    // 成功
    noteSuccess(k.name, model);
    const outHeaders = Object.assign({}, upstream.headers);
    delete outHeaders['content-length'];
    delete outHeaders['content-encoding'];
    delete outHeaders['transfer-encoding'];
    outHeaders['x-gateway-key'] = k.name;
    outHeaders['x-gateway-attempts'] = String(attempts);
    outHeaders['x-gateway-model'] = model;
    res.writeHead(upstream.statusCode, outHeaders);
    upstream.pipe(res);

    upstream.on('end', () => {
      if (cfg.logRequests) {
        log(
          'INFO',
          `${req.method} ${pathname} model=${model} key=${k.name} attempts=${attempts} stream=${!!isStream} ${Date.now() - started}ms`
        );
      }
    });
    return;
  }

  if (lastStatus) {
    res.writeHead(lastStatus, { 'content-type': 'application/json; charset=utf-8', 'x-gateway-attempts': String(attempts) });
    return res.end(lastBody);
  }

  return jsonError(res, 503, '所有 key 都在冷却中或都被排除，暂时无可用账号。请稍后重试或补充账号。', {
    cooldownSeconds: cfg.cooldownSeconds,
    keys: KEYS.length
  });
});

server.requestTimeout = 0;
server.headersTimeout = 60000;

function start() {
  server.listen(cfg.port, cfg.host, () => {
    log('INFO', '==================================================');
    log('INFO', `SenseNova 网关已启动: http://${cfg.host}:${cfg.port}`);
    log('INFO', `上游: ${cfg.upstream}/v1`);
    log('INFO', `Key 池: ${KEYS.length} 个 [${KEYS.map((k) => k.name).join(', ') || '空'}]`);
    log('INFO', `本地鉴权: ${cfg.localToken ? '已开启' : '未开启（仅监听 127.0.0.1）'}`);
    log('INFO', `自定义模型别名: ${Object.keys(cfg.aliases).length ? JSON.stringify(cfg.aliases) : '（无）'}`);
    log('INFO', '检查: GET /health · GET /stats');
    log('INFO', '==================================================');
  });
  server.on('error', (e) => {
    log('ERROR', '网关启动失败: ' + e.message);
    process.exitCode = 1;
  });
}

process.on('SIGINT', () => {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(STATE, null, 2), 'utf-8');
  } catch (e) {}
  process.exit(0);
});

if (require.main === module) {
  if (process.argv.includes('--check')) {
    log('INFO', `配置检查 -> key=${KEYS.length} 个, 端口=${cfg.port}, 上游=${cfg.upstream}`);
    process.exit(0);
  }
  start();
}

module.exports = { server, start, loadKeys, loadConfig, STATE };
