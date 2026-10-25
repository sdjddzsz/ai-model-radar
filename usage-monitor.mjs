/**
 * AILens 用量监控独立程序
 * ─ 独立运行，不依赖 AILens 主服务
 * ─ 显示：当前模型、墨点余额、用量统计、思考强度配置、最近调用记录
 * ─ 管理：端点 CRUD、路由模式切换、手动路由配置（即时生效，无需重启网关）
 * ─ 数据源：gateway-log.jsonl + config/endpoints.json + config/intern-quota.json
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = 9998;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, 'public');
const LOGF = path.join(__dirname, 'gateway-log.jsonl');
const CONFIG_FILE = path.join(__dirname, 'config', 'endpoints.json');
const QUOTA_FILE = path.join(__dirname, 'config', 'intern-quota.json');
/* ★ 模型实测数据（2026-10-02）：给路由池清单打真实能力标签用，数据由 tools/bench-models.mjs 产出 */
const BENCH_FILE = path.join(__dirname, 'bench-results.json');
let BENCH_CACHE = { map: null, mtime: 0 };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

/* ★ 崩溃只记录、不自杀（2026-10-02 根治 9998 反复重启）
 * 旧写法：log 完直接 process.exit(1) → 任何未捕获异常（例如拉用量数据时的偶发网络错误）
 * 都会把整个服务干掉，外层看门狗 5s 拉起 → 形成重启循环，面板表现为「又挂了」。
 * 现在照抄 llm-gateway.mjs 的做法：只记日志、进程继续活着继续服务（网关从不自杀就是因为这个）。
 * 真正无法服务的情形（端口被占）见下面 server.on('error')，那里仍然退出让看门狗重试。 */
process.on('uncaughtException', (e) => { try { console.error('[uncaughtException]', e && e.stack || e); } catch {} });
process.on('unhandledRejection', (e) => { try { console.error('[unhandledRejection]', e && (e.stack || e.message) || e); } catch {} });

/* 读取请求体（JSON） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e7) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  /* 静态文件 */
  if (p === '/' || p === '/usage-monitor.html' || p === '/usage-monitor') {
    const file = path.join(ROOT, 'usage-monitor.html');
    if (fs.existsSync(file)) {
      const buf = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(buf);
    }
    res.writeHead(404);
    return res.end('usage-monitor.html not found');
  }

  /* ★ API: 模型实测档位（2026-10-02）——路由池清单的真实能力标签数据源。
     按 mtime 缓存：重跑 bench 后刷新页面即生效，不用重启本服务。文件缺失返回空 map。 */
  if (p === '/api/bench') {
    try {
      const st = fs.existsSync(BENCH_FILE) ? fs.statSync(BENCH_FILE) : null;
      if (st && st.mtimeMs === BENCH_CACHE.mtime && BENCH_CACHE.map) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, map: BENCH_CACHE.map }));
      }
      const map = {};
      if (st) {
        const rows = JSON.parse(fs.readFileSync(BENCH_FILE, 'utf8'));
        for (const r of rows) {
          map[r.model] = {
            tier: (r.tier && r.tier.tier) || '未测',
            scorePct: r.scorePct == null ? null : r.scorePct,
            mathPct: r.mathPct == null ? null : r.mathPct,
            codePct: r.codePct == null ? null : r.codePct,
            answeredTotal: r.answeredTotal || 0,
            avgMs: r.avgMs || 0,
            insufficient: !!(r.tier && r.tier.insufficient)
          };
        }
      }
      BENCH_CACHE = { map, mtime: st ? st.mtimeMs : 0 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, map }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  /* API: 配置（读 + 写） */
  if (p === '/api/config') {
    try {
      if (req.method === 'GET') {
        if (fs.existsSync(CONFIG_FILE)) {
          const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, config: data }));
        }
        res.writeHead(404);
        return res.end(JSON.stringify({ ok: false, error: 'config not found' }));
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (!body || !body.config || typeof body.config !== 'object') {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: '缺少 config 字段' }));
        }
        /* 原子写：先写临时文件再 rename，避免半截配置文件 */
        const tmp = CONFIG_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(body.config, null, 2));
        fs.renameSync(tmp, CONFIG_FILE);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, saved: true }));
      }
    } catch (e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  /* API: 端点连通性测试（服务端代测） */
  if (p === '/api/endpoints/test' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body || !body.endpoint) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: '缺少 endpoint 字段' }));
      }
      const ep = body.endpoint;
      let key = ep.key_env ? (process.env[ep.key_env] || '') : '';
      if (!key) { try { key = fs.readFileSync(path.join(__dirname, ep.key_file), 'utf8').trim(); } catch {} }
      if (!key) {
        res.writeHead(400);
        return res.end(JSON.stringify({ ok: false, error: 'Key 缺失' }));
      }
      const r = await fetch(ep.base_url + '/models', {
        headers: { Authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(15000)
      });
      let models = [];
      try { models = (await r.json()).data?.map(m => m.id).slice(0, 20) || []; } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: r.ok, status: r.status, models, modelCount: models.length }));
    } catch (e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  /* API: 墨点余额 */
  if (p === '/config/intern-quota.json') {
    if (fs.existsSync(QUOTA_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'quota file not found' }));
  }

  /* API: 网关日志 */
  if (p === '/api/gateway-log') {
    const limit = parseInt(u.searchParams.get('limit') || '50');
    if (fs.existsSync(LOGF)) {
      const content = fs.readFileSync(LOGF, 'utf8').trim();
      const lines = content.split('\n').filter(Boolean);
      const logs = lines.slice(-limit).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ logs }));
    }
    res.writeHead(404);
    return res.end('log file not found');
  }

  /* API: 手动刷新路由池（2026-10-02）
     面板按钮 → 这里 → POST 转发到网关的 /route-pool/refresh。
     转发而非前端直连：网关只监听 127.0.0.1 且与面板不同源，走服务端更稳。 */
  if (p === '/api/route-pool/refresh' && req.method === 'POST') {
    try {
      const r = await fetch('http://127.0.0.1:9999/route-pool/refresh', { method: 'POST', signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(j));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
  }

  /* API: 路由池观测（只读：当前首选 + 候选 + 上次刷新时间） */
  if (p === '/api/route-pool' && req.method === 'GET') {
    try {
      const r = await fetch('http://127.0.0.1:9999/route-pool', { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, pool: j }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
  }

  /* API: 网关实际模型数（2026-10-01）
     面板的「模型数」列改为从这里取，而不是读 endpoints[].models（死代码字段）。
     网关 /models 已于今天改为跟随路由池实时状态（方案 B：19→30），配置里的 5/10 已过时。
     映射：/models 的 owned_by（openrouter / intern-ai / ailens-gateway）→ endpoints.json 的 id。 */
  if (p === '/api/gateway-models' && req.method === 'GET') {
    try {
      const r = await fetch('http://127.0.0.1:9999/models', { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const counts = {};
      const models = {};          /* ★ 2026-10-02 补：连模型 id+name 一起返回，面板要能列出名字 */
      let total = 0;
      for (const m of (j.data || [])) {
        const k = m.owned_by || 'unknown';
        counts[k] = (counts[k] || 0) + 1;
        total++;
        (models[k] = models[k] || []).push({ id: m.id, name: m.name || m.id, ctx: m.max_context_length ?? null });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, counts, models, total }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e && e.message || e), counts: {} }));
    }
  }

  /* API: 配置（原始静态文件，供直接访问 /config/endpoints.json 的请求兼容） */
  if (p === '/config/endpoints.json') {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(data));
    }
    res.writeHead(404);
    return res.end('config not found');
  }

  /* ---- OpenRouter 余额/用量（与 8765 面板同源；服务端代理避免浏览器跨域与 Key 泄露） ---- */
  if (p === '/api/balance') {
    try {
      let key = process.env.OPENROUTER_API_KEY || '';
      if (!key) {
        try {
          const o = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', 'OPENROUTER_API_KEY'], { encoding: 'utf8', timeout: 8000 });
          const m = o.stdout && o.stdout.match(/REG_SZ\s+(\S+)/);
          if (m) key = m[1];
        } catch {}
      }
      if (!key) { try { key = fs.readFileSync(path.join(__dirname, 'gateway.key'), 'utf8').trim(); } catch {} }
      if (!key) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'no OPENROUTER_API_KEY found' }));
      }
      const H = { Authorization: 'Bearer ' + key };
      const [kr, cr] = await Promise.all([
        fetch('https://openrouter.ai/api/v1/auth/key', { headers: H, signal: AbortSignal.timeout(15000) }).then(r => r.json()),
        fetch('https://openrouter.ai/api/v1/credits', { headers: H, signal: AbortSignal.timeout(15000) }).then(r => r.json())
      ]);
      const k = (kr && kr.data) || {};
      const c = (cr && cr.data) || {};
      /* ★ 口径澄清（2026-10-01 修正）：
         OpenRouter 没有「月度额度重置」这回事。
         - total_credits = 账户累计充值（预存美元），total_usage = 累计已花费 → 真实可用余额 = 两者之差
         - key.limit   = 该 API Key 的硬性限额（用户自设），不重置；到顶直接 402 断供
         - usage_monthly / usage_weekly / usage_daily 只是「近 N 天用量」滚动统计，不是配额、不会重置
         之前面板把 usage_monthly 当总用量算余额，虚报近 4 美元；且 limit 被误标为「月度上限（每月重置）」。 */
      const totalCredits = c.total_credits ?? null;
      const totalUsage = c.total_usage ?? null;
      const walletBalance = (totalCredits != null && totalUsage != null)
        ? Math.round((totalCredits - totalUsage) * 100) / 100 : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        /* 预存余额（真实可用） */
        walletBalance,
        totalCredits,
        totalUsage,
        /* Key 硬限额（不重置） */
        limit: k.limit ?? null,
        limitRemaining: k.limit_remaining ?? null,
        limitReset: k.limit_reset || null,
        /* 累计用量 */
        usage: k.usage ?? null,
        /* 滚动窗口统计（仅参考，非配额） */
        usageMonthly: k.usage_monthly ?? null,
        usageWeekly: k.usage_weekly ?? null,
        usageDaily: k.usage_daily ?? null,
        keyLabel: k.label || '',
        freeDaily: k.free_model_daily_requests || null
      }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  /* ---- 书生墨点余额：优先「控制台手动同步」（config/intern-quota-console.json，数值来自书生控制台真实余额），
         无同步文件才退回网关本地估算（gateway-quota.json，仅作兜底） ---- */
  if (p === '/api/intern-quota') {
    try {
      const CS = path.join(__dirname, 'config', 'intern-quota-console.json');
      let source = 'gateway';   /* 数据来源：gateway=本地估算（兜底）/ console=控制台手动同步 */
      let quota = { used5h: 0, used7d: 0, lastReset5h: Date.now(), lastReset7d: Date.now() - 7 * 86400e3 };
      if (fs.existsSync(CS)) {
        try {
          const cs = JSON.parse(fs.readFileSync(CS, 'utf8'));
          if (cs && cs.used5h != null && cs.used7d != null) { quota = { ...quota, ...cs }; source = 'console'; }
        } catch {}
      }
      if (source !== 'console' && fs.existsSync(path.join(__dirname, 'gateway-quota.json'))) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'gateway-quota.json'), 'utf8'));
          quota = { ...quota, ...data };
          if (Date.now() - quota.lastReset5h > 5 * 3600e3) { quota.used5h = 0; quota.lastReset5h = Date.now(); }
          if (Date.now() - quota.lastReset7d > 7 * 86400e3) { quota.used7d = 0; quota.lastReset7d = Date.now(); }
        } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        used5h: quota.used5h.toFixed(2),
        used7d: quota.used7d.toFixed(2),
        remaining5h: Math.max(0, 10 - quota.used5h).toFixed(2),
        remaining7d: Math.max(0, 50 - quota.used7d).toFixed(2),
        lastReset5h: quota.lastReset5h,
        lastReset7d: quota.lastReset7d,
        totalTokensUsed: Math.round((quota.used5h + quota.used7d) * 5e6),
        quotaExhausted: quota.used5h >= 10 || quota.used7d >= 50,
        source,
        updatedAt: quota.updatedAt || null
      }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  /* ---- 网关用量聚合（读 gateway-log.jsonl 近 30 天） ---- */
  if (p === '/api/gateway-spend') {
    try {
      let rows = [];
      if (fs.existsSync(LOGF)) {
        rows = fs.readFileSync(LOGF, 'utf8').trim().split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      }
      const cutoff = Date.now() - 30 * 86400e3;
      let calls = 0, inTok = 0, outTok = 0, costCny = 0, fails = 0;
      for (const r of rows) {
        if (!r || !r.t || !r.usage) continue;
        if (new Date(r.t).getTime() < cutoff) continue;
        calls++;
        inTok += r.usage.prompt_tokens || 0;
        outTok += r.usage.completion_tokens || 0;
        if (r.cost_cny != null) costCny += r.cost_cny;
        if (r.status >= 400) fails++;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, calls, inTok, outTok, costCny: Math.round(costCny * 100) / 100, fails }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  /* ---- OpenRouter 官方活动明细（Management Key 走服务端，Key 不进浏览器） ---- */
  if (p === '/api/activity') {
    try {
      let mk = '';
      try { mk = fs.readFileSync(path.join(__dirname, 'provisioning.key'), 'utf8').trim(); } catch {}
      if (!mk) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: '未配置 Management Key（provisioning.key）' }));
      }
      const r = await fetch('https://openrouter.ai/api/v1/activity', {
        headers: { Authorization: 'Bearer ' + mk }, signal: AbortSignal.timeout(20000)
      });
      const j = await r.json();
      const rows = (j && j.data) || [];
      const cutoff = Date.now() - 30 * 86400e3;
      let requests = 0, prompt = 0, completion = 0, usage = 0;
      const byModel = new Map();
      for (const x of rows) {
        const d = x.date ? Date.parse(String(x.date).replace(' ', 'T') + 'Z') : 0;
        if (d && d < cutoff) continue;
        const rq = x.requests || 0;
        requests += rq; prompt += x.prompt_tokens || 0;
        completion += x.completion_tokens || 0; usage += x.usage || 0;
        const k2 = x.model || 'unknown';
        const m = byModel.get(k2) || { model: k2, requests: 0 };
        m.requests += rq;
        byModel.set(k2, m);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true, requests, prompt, completion,
        usage: Math.round(usage * 10000) / 10000,
        models: [...byModel.values()].sort((a, b) => b.requests - a.requests).slice(0, 6)
      }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  /* ---- 当前正在用的模型（gateway-log 最新一条） ---- */
  if (p === '/api/current-model') {
    try {
      let model = null, routed = null, t = null, status = null, ms = null, provider = null;
      if (fs.existsSync(LOGF)) {
        const rows = fs.readFileSync(LOGF, 'utf8').trim().split('\n').filter(Boolean)
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i] && rows[i].model) {
            model = rows[i].model; routed = rows[i].routed || null;
            t = rows[i].t || null; status = rows[i].status || null; ms = rows[i].ms || null;
            provider = rows[i].provider || null;
            break;
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: !!model, model, routed, t, status, ms, provider }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }

  /* ---- SSE：网关日志一变就推（与 8765 面板同款实时机制） ---- */
  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let lastSize = fs.existsSync(LOGF) ? fs.statSync(LOGF).size : 0;
    let buf = '';
    const iv = setInterval(() => {
      try {
        const now = fs.statSync(LOGF).size;
        if (now > lastSize) {
          const chunk = Buffer.alloc(now - lastSize);
          const fd = fs.openSync(LOGF, 'r');
          fs.readSync(fd, chunk, 0, now - lastSize, lastSize);
          fs.closeSync(fd);
          buf += chunk.toString('utf8');
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const l of lines) {
            if (!l.trim()) continue;
            try { res.write('data: ' + l + '\n\n'); } catch { /* 客户端已断 */ }
          }
          lastSize = now;
        }
      } catch { /* 文件瞬时不可读，下轮再试 */ }
    }, 1000);
    const hb = setInterval(() => { try { res.write(':ok\n\n'); } catch { clearInterval(iv); clearInterval(hb); res.end(); } }, 20000);
    req.on('close', () => { clearInterval(iv); clearInterval(hb); });
    return;
  }

  /* 404 */
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('AILens 用量监控已启动 → http://localhost:' + PORT);
  console.log('按 Ctrl+C 停止');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log('端口 ' + PORT + ' 已被占用');
    process.exit(1);
  }
  console.error('启动失败:', e.message);
  process.exit(1);
});
