# 架构决策记录（ADR）

本仓库的设计取舍，供 reviewer 理解"为什么这么写"。

---

## ADR-001: 选"按用量最少"而非 round-robin

**背景**：N 个账号要在共享的 5h 滚动窗口下最大化吞吐。

**考虑过的选项**：
1. Round-robin —— 请求次数均分
2. Least-used-in-window —— 按当前 5h 窗口内的用量选账号
3. Random —— 简单但不可控

**选择**：Least-used-in-window

**理由**：
- Round-robin 只看顺序不看状态，某账号刚 429 后下一次还会被选中
- Least-used 天然把"配额已用满"和"冷却中"的账号排除掉
- 排序：`sort((a,b) => (a.used - b.used) || (a.last - b.last))` —— 先按用量升序，用量相同时按最后使用时间升序（更久没用的优先）

**代价**：排序是 O(n log n)，n = 账号数（< 100），忽略不计。

---

## ADR-002: 5h 滚动窗口用内存数组 + 文件兜底

**背景**：需要按"账号 × 模型"独立计数请求时间戳，进程重启后不丢。

**考虑过的选项**：
1. Redis（`ZRANGEBYSCORE`）
2. SQLite
3. 内存数组 + 定期落盘 JSON

**选择**：内存数组 + 延迟 2s 落盘 JSON

**理由**：
- 单机本地场景，Redis 需要额外部署
- 计数有天然上限（`maxRequestsPer5h` ≈ 1450），数组不会爆
- 时间戳按升序 push，取窗口时线性扫描 + 截断，最坏 O(n) 但 n 有界
- 落盘用 2s debounce 避免高频 I/O

**代价**：
- 进程崩溃时可能丢最后一次 debounce 的更新，最多 2s 的窗口计数
- 多进程部署会各自维护自己的窗口（本仓库不支持多进程，本地单机够用）

**清理算法**：
```js
function usedInWindow(name, model, now) {
  const arr = s.window[model] || [];
  const cut = now - windowMs;
  let keepFrom = 0;
  while (keepFrom < arr.length && arr[keepFrom] < cut) keepFrom++;
  if (keepFrom > 0) s.window[model] = arr.slice(keepFrom);  // 截断旧的
  return (s.window[model] || []).length;
}
```

---

## ADR-003: 429 冷却到窗口滑动，而不是固定秒数

**背景**：429 有两种成因：（a）真实限流（b）5h 窗口用满。

**选择**：区分处理
```js
if (status === 429) {
  const arr = s.window[model] || [];
  if (arr.length >= cfg.maxRequestsPer5h) {
    // 窗口用满：冷却到最早那次请求滑出窗口
    return Math.max(arr[0] + windowMs - now, cfg.cooldownSeconds * 1000);
  }
  return cfg.cooldownSeconds * 1000;  // 300s
}
```

**理由**：
- 固定 300s 冷却后立刻又 429，形成"限流风暴"
- 冷却到窗口滑动等于"等到配额可用"，恢复即成功

---

## ADR-004: 别名写死在 config，不做动态路由

**考虑过的选项**：
1. 静态别名映射（本仓库方案）
2. 按 prompt 长度选模型
3. 按内容类型选模型
4. 加权路由

**选择**：静态别名

**理由**：这个用例的本质是"我客户端想固定用一个逻辑名字，但想能一键切换上游实现"。加权路由和动态选择都需要额外的评估器和配置层，属于过度工程。真要动态路由，两个网关实例分开部署更清晰。

---

## ADR-005: 错误响应透传策略

**考虑过的选项**：
1. 所有 4xx/5xx 都重试
2. 只重试 RETRY_STATUS 集合里的
3. 全透传不重试

**选择**：只重试 RETRY_STATUS = `{401, 403, 408, 409, 425, 429, 500, 502, 503, 504, 529}`

**理由**：
- 400/404/422 这类客户端错误重试没意义，原样透传
- 网络错误（DNS、连接超时）单独处理，`coolKey(name, 30000, '网络错误')`
- 全透传的方案（选项 3）会导致"某账号刚被限流，客户端看到 429 就以为配额没了，但其实是这个 key 的问题"

---

## ADR-006: 零依赖（只用 Node 内置模块）

**理由**：
- 生产环境每次 `npm install` 都是 CVE 风险
- 本地工具，`node server.js` 直接跑最重要
- 核心代码只用 `http`、`https`、`fs`、`path`
- 测试也不用 jest，`node test/smoke.js` 直接跑

**代价**：
- 没有 axios 的便捷 API，HTTP 调用要手写（`forward()` 函数 30 行）
- 没有 `body-parser`，JSON 解析要手写（但也就 3 行 `JSON.parse(rawBody.toString('utf-8'))`）

**权衡**：这个仓库的核心是"能跑起来、能自测、能被复制"，零依赖让这三件事都变得极其简单。

---

## ADR-007: SSE 流式用 pipe 而不是自己攒

**背景**：OpenAI 的流式响应是 SSE，需要边收边转。

**选择**：`upstream.pipe(res)` —— Node 原生管道，不复制内容。

**代价**：`pipe` 期间没法插入自己的逻辑（比如按 delta 计数 token）。目前只需要透传，够用。要计数要自己 `on('data')` 逐块解析。

---

## 下一步可以做的

- 支持多个 upstream（同时挂 SenseNova + OpenAI + 其他）
- 按 model id 前缀路由到不同 upstream
- 加 Prometheus metrics 端点
- 加请求体大小限制
- Dockerfile / systemd unit（虽然本机 Windows 用不上）

---

## ADR-008: 三级模型降级链（而非单模型硬扛）

**背景**：上游模型账号有配额与限流，单 key 一旦被限流，整个调用方直接不可用。

**考虑过的选项**：
1. 单模型直连 —— 最简单，但单点故障即全断
2. Round-robin 多账号 —— 均分请求，但某账号刚 429 下一次仍会被选中
3. 三级降级链 —— 主用 → 备用 → 兜底响应

**选择**：三级降级链
- Tier-1 主用账号 / 模型：正常路径
- Tier-2 备用账号 / 模型：Tier-1 触发冷却或不可用时自动切换
- Tier-3 兜底：返回受控的安全响应（或进队列延后），绝不抛裸 5xx 给用户

**理由**：
- Round-robin 不看状态，限流风暴里会把请求均匀撒到坏账号上
- 三级链把"配额已用满 / 冷却中"的账号排除在 Tier-1，恢复即回切
- 切换判定复用 ADR-003 的"冷却到窗口滑动"而非固定秒数，避免限流风暴
- 与 ADR-005 的 `RETRY_STATUS` 配合：只有真正的临时故障才重试 / 降级，客户端错误（400/404/422）原样透传

**代价**：需要维护"账号 × 模型"的可用性状态表，但 n < 100，内存数组足够。

---

## ADR-009: 基础设施失败不计入评测通过率分母

**背景**：评测门禁的"通过率"必须反映**质量**，而不是基础设施的抖动。

**考虑过的选项**：
1. 所有非 2xx 都算失败 —— 限流风暴会瞬间把通过率打到很低，掩盖真实质量回归
2. 仅 4xx 算失败 —— 把 5xx 当质量失败同样失真（多半是上游抖动）
3. 区分 infra / quality 失败 —— 基础设施类错误从通过率分母剔除

**选择**：选项 3，引入 `isInfraFailure(status)` 分类

```js
// 基础设施类错误：与"模型回答质量"无关，不计入通过率分母
function isInfraFailure(status, err) {
  if (err) return true;                       // 网络错误 / DNS / 连接超时
  return [429, 500, 502, 503, 504].includes(status);  // 限流与上游不可用
}
```

**理由**：
- 429（配额 / 窗口用满）、503（上游不可用）、5xx（网关 / 服务器）、网络超时都属于"环境不可控"，重试 / 降级即可恢复
- 把它们算进失败会污染通过率，导致真实的质量回归被淹没在限流噪声里
- 只有"成功返回但答案错误"才计入质量失败，门禁信号更干净

**配合 ADR-008**：降级链兜住 infra 失败后，评测口径与运行时口径一致——infra 失败既不进通过率分母，也不向用户暴露裸 5xx。

**验证**：`test/mock-upstream.js` 已支持 `ok / 401 / 429 / 500 / 503` 多种行为，可在自测中切换 503 模拟上游不可用，验证降级与 `isInfraFailure` 分类。

