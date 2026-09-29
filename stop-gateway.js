'use strict';
/*
 * 停止后台网关（读 gateway.pid）
 * 运行： node stop-gateway.js
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const pidFile = path.join(DIR, 'gateway.pid');
const out = [];
const line = (s) => {
  out.push(s);
  console.log(s);
};

try {
  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  if (pid) {
    process.kill(pid);
    line('已结束网关进程 PID=' + pid);
    fs.unlinkSync(pidFile);
  }
} catch (e) {
  line('没找到在跑的网关（gateway.pid 不存在或进程已退出）: ' + e.message);
}
fs.writeFileSync(path.join(DIR, 'stop-gateway.log'), out.join('\n') + '\n', 'utf-8');
