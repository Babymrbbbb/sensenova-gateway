'use strict';
/*
 * 网关自测（用模拟上游验证逻辑，不消耗任何真实配额）
 * 运行： node test/smoke.js
 * 结果： 控制台 + test/tmp/report.txt
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(__dirname, 'tmp');
const NODE = process.execPath;
let MOCK_PORT = 8899;
let MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
let GW_PORT = 8901;
const GW = () => `http://127.0.0.1:${GW_PORT}`;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail == null ? '' : String(detail) });
  console.log(`${pass ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch (e) {}
    await sleep(150);
  }
  return false;
}

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then((r) => r.json());
}

let KEY_FILES = null;

function startGateway(overrides, tag) {
  const keysFile = path.join(TMP, `keys-${tag}.json`);
  const cfgFile = path.join(TMP, `config-${tag}.json`);
  const stateFile = path.join(TMP, `state-${tag}.json`);
  const logDir = path.join(TMP, `logs-${tag}`);

  fs.writeFileSync(keysFile, JSON.stringify(KEY_FILES, null, 2));
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(
      Object.assign(
        {
          port: GW_PORT,
          host: '127.0.0.1',
          upstream: MOCK_URL,
          localToken: '',
          windowHours: 5,
          maxRequestsPer5h: 1000,
          cooldownSeconds: 60,
          badKeyCooldownSeconds: 86400,
          maxAttempts: 4,
          idleTimeoutMs: 20000,
          defaultModel: 'sensenova-6.8-flash-lite',
          aliases: { 'sn-lite': 'sensenova-6.8-flash-lite' },
          logRequests: true
        },
        overrides || {}
      ),
      null,
      2
    )
  );

  const proc = spawn(NODE, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, {
      SN_CONFIG: cfgFile,
      SN_KEYS: keysFile,
      SN_STATE: stateFile,
      SN_LOG_DIR: logDir
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', (d) => process.stdout.write('[gw:' + tag + '] ' + d));
  proc.stderr.on('data', (d) => process.stdout.write('[gw:' + tag + '!] ' + d));
  return { proc, stateFile, cfgFile };
}

async function callGateway(body, model) {
  const r = await fetch(GW() + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ model: model || 'sensenova-6.8-flash-lite', messages: [{ role: 'user', content: 'ping' }] }, body || {}))
  });
  const text = await r.text();
  return { status: r.status, key: r.headers.get('x-gateway-key'), attempts: r.headers.get('x-gateway-attempts'), text };
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  GW_PORT = await getFreePort();
  MOCK_PORT = await getFreePort();
  MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
  console.log('网关测试端口: ' + GW_PORT + ' / 模拟上游端口: ' + MOCK_PORT);

  KEY_FILES = {
    keys: [
      { name: 'acc1', key: 'sk-mock-a' },
      { name: 'acc2', key: 'sk-mock-b' },
      { name: 'acc3', key: 'sk-mock-c' },
      { name: 'acc4', key: 'sk-mock-d' }
    ]
  };

  // ---------- 启动模拟上游 ----------
  const mock = spawn(NODE, [path.join(__dirname, 'mock-upstream.js')], {
    env: Object.assign({}, process.env, { MOCK_PORT: String(MOCK_PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  mock.stderr.on('data', (d) => process.stdout.write('[mock] ' + d));
  const mockUp = await waitFor(MOCK_URL + '/_mock/stats');
  check('模拟上游启动', mockUp, MOCK_URL);
  if (!mockUp) throw new Error('mock upstream 起不来');

  // ================= Phase A =================
  console.log('\n--- Phase A: 启动 / 轮询 / 别名 / 流式 ---');
  const A = startGateway({}, 'a');
  const healthA = await waitFor(GW() + '/health');
  check('网关启动 + /health', healthA);
  const health = await fetch(GW() + '/health').then((r) => r.json());
  check('健康检查识别 4 个 key', health.keys === 4, JSON.stringify({ keys: health.keys, available: health.keysAvailable }));

  const seq = [];
  for (let i = 0; i < 5; i++) {
    const r = await callGateway({});
    seq.push(r.key);
  }
  check('前 4 次请求轮询到 4 个不同账号', new Set(seq.slice(0, 4)).size === 4, 'key 序列=' + seq.join(' > '));
  check('第 5 次请求回到用量最少的账号', seq[4] === seq[0], `第5次=${seq[4]}, 第1次=${seq[0]}`);

  const alias = await callGateway({}, 'sn-lite');
  check('自定义模型别名映射生效', /model=sensenova-6.8-flash-lite/.test(alias.text), alias.text.slice(0, 120));

  const sres = await fetch(GW() + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'sensenova-6.8-flash-lite', stream: true, messages: [{ role: 'user', content: 'ping' }] })
  });
  const sse = await sres.text();
  const deltas = (sse.match(/data: /g) || []).length;
  check('流式(SSE)转发正常', sres.status === 200 && sse.includes('[DONE]') && deltas >= 5, `事件数=${deltas}, 含[DONE]=${sse.includes('[DONE]')}`);

  const unauth = await fetch(GW() + '/v2/whatever').then((r) => r.status);
  check('非 /v1 路径返回 404', unauth === 404, 'status=' + unauth);
  A.proc.kill();

  // ================= Phase B =================
  console.log('\n--- Phase B: 配额保护（每账号每模型 5h 上限=3）---');
  const B = startGateway({ maxRequestsPer5h: 3 }, 'b');
  await waitFor(GW() + '/health');
  let overLimit = null;
  for (let i = 0; i < 12; i++) {
    const r = await callGateway({});
    if (r.status !== 200) overLimit = r;
  }
  const statsB = await fetch(GW() + '/stats').then((r) => r.json());
  const used = statsB.keys.map((k) => k.used5h['sensenova-6.8-flash-lite'] || 0);
  check('12 次请求在 4 个账号间均分，无人超限', overLimit === null && used.every((u) => u <= 3), '各账号用量=' + JSON.stringify(used));
  check('配额均分后仍能继续服务（优雅降级）', (await callGateway({})).status === 200, '第 13 次请求');
  B.proc.kill();

  // ================= Phase C =================
  console.log('\n--- Phase C: 故障转移 / 失效 key / 全冷却 ---');
  const C = startGateway({ maxRequestsPer5h: 1000, cooldownSeconds: 60 }, 'c');
  await waitFor(GW() + '/health');

  // C1: acc1 连续 429 -> 应自动切到下一个 key 并成功
  await post(MOCK_URL + '/_mock/behavior', { key: 'sk-mock-a', mode: '429', times: 1 });
  const c1 = await callGateway({});
  check('单 key 429 自动切换其它账号', c1.status === 200 && c1.attempts === '2', `status=${c1.status}, 用了${c1.attempts}个key, 命中=${c1.key}`);

  // C2: 402 类失效 key（401）应被隔离，改用健康账号
  await post(MOCK_URL + '/_mock/behavior', { key: 'sk-mock-a', mode: 'ok', times: 0 });
  await post(MOCK_URL + '/_mock/behavior', { key: 'sk-mock-b', mode: '401' });
  await post(MOCK_URL + '/_mock/behavior', { key: 'sk-mock-c', mode: '401' });
  const c2a = await callGateway({});
  const c2b = await callGateway({});
  const statsC = await fetch(GW() + '/stats').then((r) => r.json());
  const longCool = statsC.keys.filter((k) => k.coolRemainSec > 80000).map((k) => k.name);
  check('失效 key(401) 被长冷却隔离', c2a.status === 200 && c2b.status === 200 && longCool.length >= 2, '长冷却账号=' + JSON.stringify(longCool));
  check('被隔离后请求仍由健康账号完成', /key=sk-mock-d/.test(c2b.text), c2b.text.slice(0, 140));

  // C3: 最后一个健康账号也 429 -> 原样回传上游错误
  await post(MOCK_URL + '/_mock/behavior', { key: 'sk-mock-d', mode: '429' });
  const c3 = await callGateway({});
  check('全部账号 429 时回传上游错误码', c3.status === 429, 'status=' + c3.status + ' body=' + c3.text.slice(0, 100));

  // C4: 此时全部冷却 -> 503 且给出可读提示
  const c4 = await callGateway({});
  check('全部冷却时返回 503 + 中文提示', c4.status === 503 && /冷却/.test(c4.text), 'status=' + c4.status + ' body=' + c4.text.slice(0, 160));

  C.proc.kill();

  // ================= 无 key 场景 =================
  console.log('\n--- Phase D: 空 key 池 ---');
  KEY_FILES = { keys: [] };
  const D = startGateway({}, 'd');
  await waitFor(GW() + '/health');
  const d = await callGateway({});
  check('未填 key 时给出明确指引', d.status === 503 && /keys\.json/.test(d.text), 'status=' + d.status + ' body=' + d.text.slice(0, 160));
  D.proc.kill();
  mock.kill();

  // ---------- 汇总 ----------
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  const lines = [];
  lines.push('SenseNova 网关自测报告');
  lines.push('时间: ' + new Date().toISOString());
  lines.push('结果: ' + pass + ' 通过 / ' + fail + ' 失败 / 共 ' + results.length);
  lines.push('');
  results.forEach((r, i) => lines.push(`${i + 1}. ${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? '  ->  ' + r.detail : ''}`));
  const report = lines.join('\n');
  fs.writeFileSync(path.join(TMP, 'report.txt'), report, 'utf-8');
  console.log('\n' + report);
  console.log('\nREPORT_FILE=' + path.join(TMP, 'report.txt'));
  process.exitCode = fail ? 1 : 0;
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  const cause = e && e.cause ? `${e.cause.code || ''} ${e.cause.message || e.cause}` : '';
  const lines = ['SMOKE-ERROR: ' + (e && e.stack ? e.stack : e), 'CAUSE: ' + cause, ''];
  lines.push('已完成的检查项:');
  results.forEach((r, i) => lines.push(`${i + 1}. ${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? '  ->  ' + r.detail : ''}`));
  const text = lines.join('\n');
  console.error(text);
  try {
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(path.join(TMP, 'report.txt'), text, 'utf-8');
  } catch (x) {}
  process.exit(1);
});
