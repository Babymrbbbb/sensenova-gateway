'use strict';
/*
 * 查看网关状态与各账号配额占用
 * 运行： node status.js
 * 结果： 控制台 + status.log（Windows 下控制台有时吞输出，看 status.log 更稳）
 */
const fs = require('fs');
const path = require('path');

const cfg = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
  } catch (e) {
    return { port: 8787 };
  }
})();
const base = `http://127.0.0.1:${cfg.port || 8787}`;
const out = [];

function line(s) {
  out.push(s);
  console.log(s);
}

(async () => {
  line('SenseNova 网关状态 @ ' + new Date().toLocaleString('zh-CN'));
  line('端点: ' + base);
  line('-'.repeat(56));

  let up = false;
  try {
    const h = await fetch(base + '/health').then((r) => r.json());
    up = true;
    line(`网关: 运行中 · 上游=${h.upstream} · 账号=${h.keys}个(可用${h.keysAvailable})`);
    line(`窗口: ${h.windowHours}小时 / 每账号-每模型上限 ${h.maxRequestsPer5h} 次`);
  } catch (e) {
    line('网关: 未启动（运行 start.cmd 即可）');
    line('原因: ' + e.message);
  }

  if (up) {
    try {
      const s = await fetch(base + '/stats').then((r) => r.json());
      line('');
      line('账号用量明细:');
      s.keys.forEach((k) => {
        const used = Object.keys(k.used5h).length
          ? Object.entries(k.used5h).map(([m, n]) => `${m}=${n}`).join(' ')
          : '(窗口内无请求)';
        line(`  ${k.name.padEnd(8)} ${k.key.padEnd(18)} 冷却=${k.cooling ? k.coolRemainSec + 's' : '否'}`);
        line(`           5h用量: ${used}`);
        line(`           累计: 成功${k.totals.ok} 失败${k.totals.fail} 已切走${k.totals.switched}`);
      });
    } catch (e) {
      line('读取 /stats 失败: ' + e.message);
    }
  }

  fs.writeFileSync(path.join(__dirname, 'status.log'), out.join('\n') + '\n', 'utf-8');
})();
