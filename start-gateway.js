'use strict';
/*
 * 后台启动网关（脱离当前进程，退出后继续跑）
 * 运行： node start-gateway.js
 * 产物： gateway.pid + logs\stdout.log + logs\stderr.log
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const cfg = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf-8'));
  } catch (e) {
    return { port: 8787 };
  }
})();
const PORT = cfg.port || 8787;
const out = [];
const line = (s) => {
  out.push(s);
  console.log(s);
};

(async () => {
  // 已在跑就不重复起
  try {
    const h = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
    line(`网关已经在跑了（账号 ${h.keys} 个，可用 ${h.keysAvailable}），无需重复启动。`);
    fs.writeFileSync(path.join(DIR, 'start-gateway.log'), out.join('\n') + '\n', 'utf-8');
    return;
  } catch (e) {
    /* 没在跑，继续起 */
  }

  fs.mkdirSync(path.join(DIR, 'logs'), { recursive: true });
  const stdout = fs.openSync(path.join(DIR, 'logs', 'stdout.log'), 'a');
  const stderr = fs.openSync(path.join(DIR, 'logs', 'stderr.log'), 'a');

  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], {
    cwd: DIR,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', stdout, stderr]
  });
  child.unref();
  fs.writeFileSync(path.join(DIR, 'gateway.pid'), String(child.pid) + '\n', 'utf-8');
  line('已拉起网关进程 PID=' + child.pid);

  let up = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const h = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
      line(`✅ 网关就绪 http://127.0.0.1:${PORT} · 账号 ${h.keys} 个（可用 ${h.keysAvailable}）· 上游 ${h.upstream}`);
      up = true;
      break;
    } catch (e) {}
  }
  if (!up) {
    line('❌ 网关 10 秒内没起来，看 logs\\stderr.log 和 logs\\gateway-*.log');
    try {
      line('stderr: ' + fs.readFileSync(path.join(DIR, 'logs', 'stderr.log'), 'utf-8').slice(-800));
    } catch (e) {}
  }
  fs.writeFileSync(path.join(DIR, 'start-gateway.log'), out.join('\n') + '\n', 'utf-8');
  process.exit(up ? 0 : 1);
})();
