/**
 * 模型能力实测（2026-10-02）
 *
 * 用户定的两条标准（17:30 原话）：
 *   「能独立推导论文里的数学证明」+「能写大型重构」都算强
 *   → 测两类：数学推导 + 代码理解/重构。
 *
 * ★ 所有题目的标准答案都用 Python 独立验算过（不是我想当然写的）。
 *   这点很关键：第一轮凭印象写的 5 道题里有 2 道答案本身是错的
 *   （模运算我以为最小解是 3，实为 7；递推题我以为 466，实为 257）。
 *
 * ★ 为什么不用「让模型给自己打分」：不可信且互相吹捧。每题用正则精确判对错。
 * ★ max_tokens 必须够大：reasoning 模型的思考会吃光预算
 *   （早上实测 space-bunny 给 6000 时正文全空，我一度误判成「模型坏了」）。
 *
 * 输出：bench-results.json
 */
import fs from 'fs';
import { execSync } from 'child_process';

function getKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const o = execSync('reg query HKCU\\Environment /v OPENROUTER_API_KEY', { encoding: 'utf8', timeout: 8000, windowsHide: true });
  return o.match(/REG_SZ\s+(\S+)/)[1];
}
const KEY = getKey();
const OUT = 'D:/WorkBuddy/AILens/bench-results.json';
const PER_TASK_TIMEOUT = 45000;   /* 单题 45s：卡住本身就是结论（实践不可用） */

/* ================= 题库：答案全部 Python 验算 =================
   A 组 = 数学推导（对应「论文里的数学证明」）
   B 组 = 代码理解与重构（对应「大型重构」）
   ------------------------------------------------------------ */
const TASKS = [
  /* ---- A 数学推导 ---- */
  {
    kind: 'math', name: '丢番图方程',
    prompt: '求所有满足 x² + y² = 65 且 x、y 均为正整数的有序对 (x,y) 的个数。只输出这个数字，不要任何解释。',
    expect: /^\s*4\s*$/, verify: 'Python 枚举：(1,8)(4,7)(7,4)(8,1) 共 4 个',
  },
  {
    kind: 'math', name: '数论-模求解',
    prompt: '求满足 n ≡ 2 (mod 5) 且 n³+n 能被 7 整除 的最小正整数 n。只输出这个数字。',
    expect: /^\s*7\s*$/, verify: 'Python 扫描：解为 7, 42, …，最小 7',
  },
  {
    kind: 'math', name: '线性递推',
    prompt: '数列满足 a₁=1，a(n+1)=2a(n)+1。求 a₁₀ − a₉ − a₈ 的值。只输出这个数字。',
    expect: /^\s*257\s*$/, verify: '递推得1,3,7,15,31,63,127,255,511,1023；1023-511-255=257',
  },
  {
    kind: 'math', name: '二项概率',
    prompt: '抛一枚正面概率为 1/3 的硬币 3 次，恰好 2 次正面的概率是多少？只输出最简分数（形如 1/9）。',
    expect: /^\s*2\/9\s*$/, verify: 'C(3,2)·(1/3)²·(2/3) = 2/9',
  },
  {
    kind: 'math', name: '几何概率',
    prompt: '在边长为 1 的正方形内随机取一点，它到两条相邻边的距离之和小于 1/2 的概率是多少？只输出最简分数。',
    expect: /^\s*1\/8\s*$/, verify: '设点(x,y)，距离和=x+y<0.5 → 面积 0.25/2 = 1/8',
  },

  /* ---- B 代码理解 / 重构 ---- */
  {
    kind: 'code', name: '可变默认参数',
    prompt:
      '这段 Python 输出什么？只输出三个数（空格分隔），不要解释：\n' +
      'def f(x, acc=[]):\n    acc.append(x)\n    return sum(acc)\nprint(f(1), f(2), f(3))',
    expect: /^\s*1\s+3\s+6\s*$/, verify: '可变默认参数共享：1 / 1+2=3 / 1+2+3=6',
  },
  {
    kind: 'code', name: '字典迭代陷阱',
    prompt:
      '这段 Python 输出什么？只输出三个数（空格分隔），不要解释：\n' +
      'd = {"a": 1}\nfor k in ["a", "b", "c"]:\n    d[k] = d.get(k, 0) + 1\nprint(d["a"], d["b"], len(d))',
    expect: /^\s*2\s+1\s+3\s*$/, verify: 'a:1→2, b:1, c:1 → 2 1 3',
  },
  {
    kind: 'code', name: '闭包与作用域',
    prompt:
      '这段 JavaScript 输出什么？只输出结果，不要解释：\n' +
      'const fs = [];\nfor (let i = 0; i < 3; i++) fs.push(() => i);\nconsole.log(fs.map(f => f()).join(","));',
    expect: /^\s*0\s*,\s*1\s*,\s*2\s*$/, verify: 'let 块级作用域，每次迭代独立 → 0,1,2（var 会是 3,3,3）',
  },
  {
    kind: 'code', name: '重构-等价改写', loose: true,
    prompt:
      '把下面函数等价改写成一个 lambda，只输出这一行代码，不要解释：\n' +
      'def add_key(d, k):\n    d[k] = d.get(k, 0) + k\n    return d\n\n# 要求：原地修改 d 并返回同一个字典对象',
    expect: /lambda/,
    verify: '需含 lambda 且语义正确（原地修改 + 返回同一 dict）',
  },
  {
    kind: 'code', name: '复杂度识别',
    prompt:
      'Python 这段的时间复杂度大 O 是？只输出大 O，如 O(n log n)：\n' +
      'def f(xs):\n    out = []\n    for x in xs:\n        i = 0\n        while xs[i] != x:\n            i += 1\n        out.append(i)\n    return out',
    expect: /O\s*\(\s*n\s*2\s*\)|O\s*\(\s*n\^2\s*\)/i,
    verify: '内层 while 最坏遍历全部 → n²',
  },
];

/* ---------- 档位判定（输入 0-100 百分制） ----------
 * ★ MIN_SAMPLE = 6：实答题数少于这个数不给「强」及以上。
 *   起因：gemma-4-31b 只答了3 题（跳过 7）恰好全对 → 100%，被误判成强档。
 *   样本太少的高分不可信，必须降级并标注。 */
const MIN_SAMPLE = 6;
function tierOf(pct, answeredTotal) {
  const insufficient = answeredTotal < MIN_SAMPLE;
  let t;
  if (pct >= 90) t = { tier: '强', note: '论文级推导 / 大型重构' };
  else if (pct >= 70) t = { tier: '中上', note: '常规硬任务够用' };
  else if (pct >= 50) t = { tier: '中', note: '日常主力' };
  else if (pct >= 30) t = { tier: '弱', note: '仅简单任务 / 兜底' };
  else t = { tier: '零', note: '不建议使用' };
  /* 样本不足：上限压到「中上」—— 5题全对不等于 10 题全对 */
  if (insufficient) {
    const cap = { 强: '中上', 中上: '中上', 中: '中', 弱: '弱', 零: '零' }[t.tier];
    return { tier: cap, note: `样本不足（仅答 ${answeredTotal}/${TASKS.length} 题）`, insufficient: true };
  }
  return t;
}

/* ★ 输出截断识别（19:55）：模型把 max_tokens 花在输出推理过程上，还没给出答案就被切断。
 * 例：laguna-s-2.1 线性递推题 out=1690 tokens，内容是 "a₁ = 1, and the recurrence relation is…"。
 * 这类不该当普通 0 分（会低估模型），应单独标记 —— 它反映的是「响应被截断」而非「答错」。 */
const TRUNCATED_HINT = /^\s*(a[₁₁n]|to find|we need|first,|let me|let's|计算|首先|由|根据)/i;
function isTruncated(out, outTok, maxTokens) {
  if (!out) return false;
  if (outTok >= maxTokens * 0.9) return true;              /* 用满预算 = 大概率截断 */
  if (out.length > 120 && TRUNCATED_HINT.test(out)) return true;  /* 开头在推导、且很长 */
  return false;
}

async function ask(model, prompt, maxTokens) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PER_TASK_TIMEOUT);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'User-Agent': 'AILens-Bench/1.0' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }),
      signal: ctl.signal,
    });
    const ms = Date.now() - t0;
    if (res.status === 429) {
      /* ★ 关键：429是「限流」不是「模型不行」，绝不能直接判 0 分。
         实测连续发请求会被OpenRouter 限流，第二个模型 10 题全 429 → 会被误判成「零分模型」。
         必须读Retry-After 退避重试；真重试失败才标 skipped（结果里单独统计，不计入分数）。 */
      const ra = Number(res.headers.get('retry-after') || 0);
      const waitMs = Math.max(2000, Math.min(ra * 1000 || 8000, 30000));
      return { ok: false, ms, out: '', err: '429', retryAfterMs: waitMs, rateLimited: true };
    }
    if (!res.ok) return { ok: false, ms, out: '', err: 'HTTP ' + res.status };
    const j = await res.json();
    return {
      ok: true, ms,
      out: (j.choices?.[0]?.message?.content || '').trim(),
      reasoning: !!j.choices?.[0]?.message?.reasoning,
      outTok: j.usage?.completion_tokens || 0,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, out: '', err: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ★ 联网预检（2026-10-02）：OpenRouter 经常整段抽风（DNS ENOTFOUND / fetch failed）。
 * 若不先探活就直接开跑，23×10 题全是超时 → 干等两小时还一题没测出来。
 * 开跑前先打 /api/v1/models，连不上就明确退出（BENCH_SKIP_PREFLIGHT=1 可绕过）。 */
async function preflight() {
  if (process.env.BENCH_SKIP_PREFLIGHT) { process.stderr.write('  [预检] 已跳过\n'); return; }
  const url = 'https://openrouter.ai/api/v1/models';
  for (let i = 1; i <= 3; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + KEY }, signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) { process.stderr.write('  [预检] OpenRouter 可达 ✓\n'); return; }
      process.stderr.write(`  [预检] 第${i}次 HTTP ${r.status}\n`);
    } catch (e) {
      clearTimeout(t);
      process.stderr.write(`  [预检] 第${i}次失败: ${String(e.message || e)}\n`);
    }
    if (i < 3) await sleep(1500);
  }
  process.stderr.write('\n✗ 预检失败：OpenRouter 当前不可达（DNS/网络 outage）。\n  这是网络问题不是脚本问题 —— 等网络恢复后再跑（或设 BENCH_SKIP_PREFLIGHT=1 强制开跑）。\n');
  process.exit(2);
}

/* 单题最多试 RETRIES 次；限流优先退避（含每题之间的固定间隔） */
const RETRIES = Number(process.env.BENCH_RETRIES || 3);
/* 每题间隔：默认 1.5s；BENCH_SLOW=1 时 9s（限流严重时用，实测 1.5s 会被大量 429）。
   模型之间的间隔再额外加 4s，给上游喘息。 */
const BETWEEN_TASKS = process.env.BENCH_SLOW ? 9000 : 1500;
const MODEL_GAP = process.env.BENCH_SLOW ? 4000 : 1500;

async function askWithRetry(model, prompt, maxTokens) {
  let last = null;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const r = await ask(model, prompt, maxTokens);
    if (r.ok || r.err === 'timeout') return r;
    last = r;
    if (r.rateLimited) {
      await sleep(r.retryAfterMs);
      continue;
    }
    /* ★ 空输出（HTTP 200 但 content 为空、outTok=0）也重试。
       实测 nemotron-ultra 出现过 4 次「无报错但正文空白」—— 不是限流也不是超时，
       是上游偶发返回空 content。这种情况直接判 0 分会低估模型能力。 */
    if (r.ok && !r.out) {
      await sleep(1200);
      continue;
    }
    await sleep(1000);
  }
  /* 重试用尽：若最后是限流或空输出，标 skipped 而不是 0 分—— 分数必须反映模型能力而非网络/上游抖动 */
  return { ...(last || {}), skipped: true, err: last?.rateLimited ? 'rate-limited' : (last?.err || (last?.ok ? 'empty-output' : 'unknown')) };
}

await preflight();

const targets = JSON.parse(fs.readFileSync('D:/WorkBuddy/AILens/bench-targets.json', 'utf8'));
const MAXTOK = Number(process.env.BENCH_MAXTOK || 12000);
/* 断点续跑：已存在结果且样本量够（>=6 题）且没被强制重测的模型直接跳过。
   BENCH_REDO=all 全部重跑；BENCH_REDO=bad 只重跑样本不足/未测的。 */
const PREV = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
const prevMap = new Map(PREV.map(r => [r.model, r]));
const REDO = process.env.BENCH_REDO || '';
const MIN_SAMPLE_OK = 6;
const results = [];
for (const m of targets) {
  const p = prevMap.get(m);
  if (p && REDO !== 'all') {
    const bad = (p.answeredTotal ?? 0) < MIN_SAMPLE_OK;
    const wantRedo = REDO === 'bad' ? bad : false;
    if (!wantRedo && !bad) {
      process.stderr.write(`  跳过 ${m}（已有结果，实答 ${p.answeredTotal}/10，${p.scorePct}%）\n`);
      results.push(p);
      continue;
    }
    process.stderr.write(`  重测 ${m}（上次实答仅 ${p.answeredTotal ?? 0}/10，样本不足）\n`);
  }
  const detail = [];
  let mathOk = 0, codeOk = 0, totalMs = 0, totalOut = 0, sawReasoning = false, timeouts = 0, skipped = 0, truncated = 0;
  const answered = { math: 0, code: 0 };   /* 实际拿到答案的题数（分母，剔除 skipped） */
  for (const t of TASKS) {
    const r = await askWithRetry(m, t.prompt, MAXTOK);
    totalMs += r.ms;
    totalOut += r.outTok || 0;
    if (r.reasoning) sawReasoning = true;
    if (r.err === 'timeout') timeouts++;
    if (r.skipped) skipped++;
    let pass = false;
    let trunc = false;
    if (r.ok) {
      trunc = isTruncated(r.out, r.outTok || 0, MAXTOK);
      if (trunc) truncated++;
      else {
        answered[t.kind]++;
        pass = t.expect.test(r.out || '') || (t.loose && /lambda/.test(r.out || '') && r.out.length > 20);
        if (pass) { if (t.kind === 'math') mathOk++; else codeOk++; }
      }
    }
    detail.push({ kind: t.kind, name: t.name, pass, ms: r.ms, outTok: r.outTok || 0, err: r.err, skipped: !!r.skipped, truncated: trunc, out: (r.out || '').slice(0, 100) });
    process.stderr.write(pass ? '✓' : (r.skipped ? '·' : (trunc ? '✂' : '✗')));
    await sleep(BETWEEN_TASKS);
  }
  /* ★ 分数用「实际作答题数」作分母，剔除因限流被跳过的题 ——
     否则限流会把模型误判成 0 分（实测第二个模型 10 题全 429 → 被判「零分，不建议使用」）。 */
  const mathMax = answered.math, codeMax = answered.code;
  const total = mathOk + codeOk;
  /* ★ 修bug（19:13）：原来写成 `const pct = (max) => Math.round(total / max * 100)`，
     只收分母却永远拿**总分 total** 去除 → 出现 120% / 200% / 240% 这种荒谬数字
     （5/5 + 1/5 时 total=6，除以 mathMax=5 就成 120%）。
     现在必须显式传分子分母。 */
  const pct = (num, den) => den > 0 ? Math.round(num / den * 100) : null;
  const mathPct = pct(mathOk, mathMax);
  const codePct = pct(codeOk, codeMax);
  /* 总分取两类百分比的平均 —— 用它而不是 score/totalTotal，
     这样「某类题被限流跳过」不会拉低另一类的得分。 */
  const scorePct = (mathPct != null && codePct != null)
    ? Math.round((mathPct + codePct) / 2) : null;
  const row = {
    model: m,
    score: total,
    /* 归一化百分制（0-100），可比性最强；null 说明全被限流，没测出来 */
    scorePct,
    math: mathOk, mathMax,            /* 数学：答对数 / 实答题数 */
    code: codeOk, codeMax,
    mathPct, codePct,
    answeredTotal: mathMax + codeMax,
    truncated,
    tier: scorePct == null ? { tier: '未测', note: '全被限流，需重测' } : tierOf(scorePct, mathMax + codeMax),
    avgMs: Math.round(totalMs / TASKS.length),
    totalOut, reasoning: sawReasoning, timeouts, skipped,
    detail,
  };
  results.push(row);
  /* ★ 增量落盘：每测完一个模型就写一次。原脚本只在最后写一次，
     一旦中途网络抽风/进程被杀，已测的模型全丢（14/25 的教训）。 */
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(row));
  const flags = [timeouts ? '超时' + timeouts : '', truncated ? '截断' + truncated : '', skipped ? '跳过' + skipped : ''].filter(Boolean).join(' ');
  process.stderr.write(`  ${m}  ${scorePct != null ? scorePct + '%' : '未测'} [数 ${mathOk}/${mathMax} 码 ${codeOk}/${codeMax} 实答${mathMax + codeMax}/10] → ${row.tier.tier}  ${row.avgMs}ms ${flags}\n`);
  await sleep(MODEL_GAP);
}

/* 排序：先按分数，同分按「实答题数多者优先」（样本多更可信），再按速度 */
results.sort((a, b) =>
  (b.scorePct ?? -1) - (a.scorePct ?? -1) ||
  (b.answeredTotal ?? 0) - (a.answeredTotal ?? 0) ||
  a.avgMs - b.avgMs);
fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log('\n=== 排名（分数 = 数学校准% 与 代码校准% 的平均；实答 = 实际作答题数） ===');
console.log('  分数  档位    数学   代码   实答速度      模型');
for (const r of results) {
  const s = r.scorePct != null ? String(r.scorePct) + '%' : '  未测';
  console.log(`  ${s.padStart(5)}  ${r.tier.tier.padEnd(3)} ${String(r.mathPct ?? '-').padStart(5)} ${String(r.codePct ?? '-').padStart(6)}   ${String(r.answeredTotal ?? 0).padStart(2)}/10 ${String(r.avgMs).padStart(6)}ms  ${r.model}`);
}
console.log('\n→ ' + OUT);
