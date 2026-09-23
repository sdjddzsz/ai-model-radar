/**
 * AI 模型雷达 · 任务画像自动重算
 * 零依赖（Node 22+）。双击「重算画像.cmd」即可，不需要经过任何人。
 *
 *   node profile-scan.mjs          重算并写入 profile.local.mjs（旧文件自动备份为 .bak）
 *   node profile-scan.mjs --dry    只打印对比，不写文件
 *   node profile-scan.mjs --days=30  把统计窗口从默认 14 天改成 30 天
 *
 * ── 它在算什么 ────────────────────────────────────────────────
 * 分层原则（重要）：
 *   · 慢变层 = 能力需求向量（needCtx / 工具 / 推理 / 视觉 / 隐私 / 省钱权重 / 单次 token）
 *             → 由人工标定一次，本脚本**不动**；
 *   · 快变层 = 每类任务的日均调用次数 + 证据文件名
 *             → 本脚本从本机工作日志与产物目录自动统计，按占比重新分配总量。
 * 也就是说：它更新的是「你最近在拿模型干什么、干得多不多」，不是「这类活需要什么能力」。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(HERE, 'profile.local.mjs');

/* ── 数据源（改成你自己的路径即可）───────────────────────────── */
const LOG_DIRS = [
  { dir: 'D:\\WorkBuddy\\.workbuddy\\memory', w: 1.0 },                    // 主线逐日工作日志
  { dir: 'C:\\Users\\Administrator\\WorkBuddy', w: 0.6, deep: true }        // 各会话窗口的 memory（deep=递归找）
];
const OUT_DIRS = ['D:\\WorkBuddy\\output'];                                 // 产物目录：用来取证据文件名

/* ── 任务分类词典 ──────────────────────────────────────────────
   顺序敏感：一行只计入**第一个**命中的类，所以更具体的要排在前面。   */
const TAX = [
  // [key, 正则, 权重] —— 权重 < 1 的是"泛词"：排期讨论里反复被提到，不等于真的调用了一次
  ['adb',    /adb|uiautomator|dump|真机|模拟器|MEmu|逍遥|resource-id|screen-control|小米 ?6X|App ?内|截图核实/i, 1],
  ['math',   /拓扑|度量|开集|闭集|邻域|紧致|收敛|习题|定理|引理|证明|定义 ?\d|等价|连续映射|熊金城|值分布/i, 1],
  ['paper',  /论文|文献|arXiv|精读|NADS|非自治|动力系统|混沌|Devaney|Li[–-]Yorke/i, 0.45],
  ['board',  /工作台|总排期|看板|修订|localStorage|TASKS|ITEMS|dump-dom|node --check|推进一天|执行表/i, 1],
  ['resume', /简历|自我介绍|求职意向|面试|课程归属|技能栏|填写样本|手机号/i, 1],
  ['apply',  /投递进度|日报|话术|触达|三筛子|招聘 ?App|投递块|已投递|\bHR\b|二次触达/i, 1],
  ['jd',     /\bJD\b|职位描述|岗位描述|投递清单|收藏|优先级|岗位 ?JD/i, 0.8],
  ['envops', /环境|排查|安装|卸载|配置|端口|权限|失效|F5|安全策略|被拦|conda/i, 0.7],
  ['code',   /Python|SQL|pandas|sklearn|代码|脚本|调试|函数|题库|quiz|语法|import/i, 0.5],
  ['data',   /CSV|清洗|归纳|分类|统计|Excel|表格|字段|透视/i, 0.6],
  ['tool',   /小工具|新建|生成|程序|组件|雷达/i, 0.6],
  ['agent',  /交接|编排|多步|长流程|自动化|SOP|流程|闭环/i, 0.7],
  ['misc',   /翻译|外语|六级|听力|PDF|转换|md ?→|校验|排版/i, 0.6]
];

/* 这些类不参与自动统计：它们**根本不会被写进工作日志**（日常短问答、顺手转换），
   按日志统计只会系统性低估，所以永远沿用人工标定值。 */
const SKIP_KEYS = ['misc'];

/* 同一天、同一类最多计这么多行 —— 防止某天长篇聊一个主题把占比打飞 */
const DAY_CAP = 10;

/* ── 参数 ────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const NO_BAK = argv.includes('--no-bak');    // 界面调用时用它：界面已经做过带时间戳的备份了
const daysArg = argv.find(a => a.startsWith('--days='));
const DAYS = Math.max(1, Number(daysArg ? daysArg.split('=')[1] : 14) || 14);
const CUT = Date.now() - DAYS * 86400e3;
const TODAY = new Date().toISOString().slice(0, 10);

/* ── 扫描日志 ────────────────────────────────────────────────── */
function* walk(dir, deep, depth = 0) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (deep && depth < 3) yield* walk(p, deep, depth + 1); }
    else yield p;
  }
}

const hits = {};            // key -> 加权命中数
const seen = new Set();     // 行级去重（不同窗口可能记的是同一件事）
const dayCnt = {};          // `${key}|${date}` -> 已计入行数（每日封顶）
const datesSeen = new Set();// 已收录的日期：主线优先，各会话窗口的同名日期跳过（内容是重复记录）
let scannedFiles = 0, scannedLines = 0, countedLines = 0;

/* 只认「条目行」：标题 / 列表项 / 表格行。正文段落多半是解释说明，不是实际动作。 */
const ENTRY = /^\s*([-*+]\s|#{1,6}\s|\|)/;

for (const src of LOG_DIRS) {
  if (!fs.existsSync(src.dir)) continue;
  for (const f of walk(src.dir, !!src.deep)) {
    if (!/\.md$/i.test(f)) continue;
    // deep 模式只收 .workbuddy\memory 下的日志
    if (src.deep && !/[\\/]\.workbuddy[\\/]memory[\\/]/i.test(f)) continue;
    let st; try { st = fs.statSync(f); } catch (e) { continue; }
    if (st.mtimeMs < CUT) continue;                      // 窗口之外的日志不统计
    const dm = path.basename(f).match(/(\d{4}-\d{2}-\d{2})/);
    const date = dm ? dm[1] : 'unknown';
    if (src.deep) { if (datesSeen.has(date)) continue; }  // 主线已收录这天 → 窗口副本跳过
    else datesSeen.add(date);
    scannedFiles++;
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (line.length < 6 || !ENTRY.test(raw)) continue;
      const key0 = line.replace(/\s+/g, '').slice(0, 60);
      if (seen.has(key0)) continue;
      seen.add(key0);
      scannedLines++;
      for (const [key, re, wgt] of TAX) {
        if (SKIP_KEYS.includes(key)) continue;
        if (!re.test(line)) continue;
        const dk = key + '|' + date;
        if ((dayCnt[dk] || 0) >= DAY_CAP) break;         // 这天这类已经计够，不再累加
        dayCnt[dk] = (dayCnt[dk] || 0) + 1;
        hits[key] = (hits[key] || 0) + (wgt || 1) * src.w;
        countedLines++;
        break;
      }
    }
  }
}

/* ── 扫产物目录取证据 ────────────────────────────────────────── */
const evid = {};
for (const dir of OUT_DIRS) {
  if (!fs.existsSync(dir)) continue;
  for (const f of walk(dir, true, 0)) {
    let st; try { st = fs.statSync(f); } catch (e) { continue; }
    if (st.mtimeMs < CUT) continue;
    const name = path.basename(f);
    for (const [key, re] of TAX) {
      if (re.test(name)) { (evid[key] = evid[key] || []).push(name); break; }
    }
  }
}
for (const k of Object.keys(evid)) evid[k] = [...new Set(evid[k])].slice(0, 4);

/* ── 读现有画像，取人工标定的能力向量 ────────────────────────── */
let cur = null;
try { cur = (await import(pathToFileURL(PROFILE).href + '?m=' + Date.now())).default; } catch (e) {}
if (!cur || !Array.isArray(cur.tasks)) {
  console.error('没读到现有画像（' + PROFILE + '）—— 请先有一份 profile.local.mjs 再重算。');
  process.exit(1);
}

const TOTAL_OLD = cur.tasks.reduce((s, t) => s + (t.callsPerDay || 0), 0);
const TOTAL = TOTAL_OLD || 138;                     // 总量沿用上次的人工量级，只重新分配
const sumHits = Object.values(hits).reduce((a, b) => a + b, 0);

/* ── 按占比重算日均次数 ──────────────────────────────────────── */
const rows = cur.tasks.map(t => {
  const h = hits[t.key] || 0;
  const share = sumHits ? h / sumHits : 0;
  const oldN = t.callsPerDay || 0;
  const skipped = SKIP_KEYS.includes(t.key);
  // 50/50 平滑：一半信人工标定、一半信日志占比 —— 日志是"提及热度"不是精确调用数
  const mix = skipped ? oldN : (h > 0 ? 0.5 * oldN + 0.5 * TOTAL * share : oldN * 0.4);
  const ev = (evid[t.key] && evid[t.key].length) ? evid[t.key] : t.evidence;
  return { t, h, share, oldN, mix, newN: oldN, ev, skipped };
});

/* 归一化：自动部分按 mix 占比重新分配「总量 − 人工固定部分」，再对每类限幅（单次变化 ≤2.5 倍）。
   不然限幅只放不收，跑几次总量就会一路往上漂。 */
const skipSum = rows.filter(r => r.skipped).reduce((s, r) => s + r.oldN, 0);
const autoTotal = Math.max(1, TOTAL - skipSum);
const mixSum = rows.filter(r => !r.skipped).reduce((s, r) => s + r.mix, 0);
for (const r of rows) {
  if (r.skipped) { r.newN = r.oldN; continue; }
  const scaled = mixSum ? r.mix / mixSum * autoTotal : r.oldN;
  r.newN = Math.max(1, Math.round(Math.min(Math.max(scaled, r.oldN * 0.4), r.oldN * 2.5)));
}

/* ── 打印对比 ────────────────────────────────────────────────── */
const pad = (s, n) => { let w = 0; for (const c of String(s)) w += /[\x00-\xff]/.test(c) ? 1 : 2; return String(s) + ' '.repeat(Math.max(0, n - w)); };
console.log('\n任务画像自动重算 · 窗口 ' + DAYS + ' 天 · 日志 ' + scannedFiles + ' 份 / ' + scannedLines + ' 行');
console.log('─'.repeat(74));
console.log(pad('任务', 30) + pad('命中', 7) + pad('占比', 8) + pad('原日均', 8) + '新日均');
console.log('─'.repeat(74));
for (const r of rows) {
  const flag = r.skipped ? ' 人工' : (r.newN > r.oldN ? ' ↑' : (r.newN < r.oldN ? ' ↓' : '  '));
  console.log(pad(r.t.icon + ' ' + r.t.name, 30) + pad(r.h.toFixed(1), 7) + pad((r.share * 100).toFixed(1) + '%', 8) + pad(r.oldN, 8) + r.newN + flag);
}
console.log('─'.repeat(74));
console.log('日均总调用：' + TOTAL_OLD + ' → ' + rows.reduce((s, r) => s + r.newN, 0) + '（总量口径沿用上次，只重新分配）');
const up = rows.filter(r => r.newN > r.oldN).sort((a, b) => (b.newN - b.oldN) - (a.newN - a.oldN)).slice(0, 3);
console.log('占比上升最多：' + (up.length ? up.map(r => r.t.icon + ' ' + r.t.name).join('、') : '（无）'));

if (DRY) { console.log('\n--dry：只打印，未写入。去掉 --dry 即写入并自动备份旧文件。\n'); process.exit(0); }

/* ── 写回 ────────────────────────────────────────────────────── */
if (!NO_BAK) fs.copyFileSync(PROFILE, PROFILE + '.bak');

function jstr(v) { return JSON.stringify(v); }
const tasksSrc = rows.map(r => {
  const t = r.t;
  const note = t.note + (r.h > 0 ? '' : ' （近 ' + DAYS + ' 天日志里没出现过，用量已下调）');
  return [
    '    { key:' + jstr(t.key) + ', icon:' + jstr(t.icon) + ', name:' + jstr(t.name) + ', freq:' + jstr(t.freq) + ',',
    '      evidence:' + jstr(r.ev) + ',',
    '      needCtx:' + t.needCtx + ', need:{ tools:' + !!t.need.tools + ', reasoning:' + !!t.need.reasoning + ', vision:' + !!t.need.vision + ' },',
    '      callsPerDay:' + r.newN + ', inputTok:' + t.inputTok + ', outputTok:' + t.outputTok + ', cacheHit:' + t.cacheHit + ',',
    '      privacy:' + jstr(t.privacy) + ', cnStrong:' + !!t.cnStrong + ', priceWeight:' + t.priceWeight + ',',
    '      note:' + jstr(note) + ' }'
  ].join('\n');
}).join(',\n\n');

const src = `/**
 * ⚠️ 本机专属任务画像 —— 不要提交到 Git（已在 .gitignore 里忽略）
 *
 * 这份是你自己机器上真实跑过的任务构成，含产物文件名等私人信息。
 * 服务端会优先加载本文件；找不到时自动退回 profile.example.mjs 的通用示例。
 *
 * 【本文件由 profile-scan.mjs 于 ${TODAY} 自动重算】
 *   自动部分：每类任务的日均调用次数、证据文件名（按近 ${DAYS} 天工作日志与产物统计）
 *   人工部分：needCtx / 工具·推理·视觉 / 隐私 / 省钱权重 / 单次 token —— 这些是能力需求向量，
 *             机器判断不了，改这些请直接编辑本文件，或让人帮你看。
 *   想回到上一版：把 profile.local.mjs.bak 改回来即可（服务会自动热加载，不用重启）。
 */
export default {
  generated: '${TODAY}',
  sources: [
    '本机 output 目录产物（近 ${DAYS} 天内新增/修改过的）',
    '工作日志 .workbuddy\\\\memory\\\\*.md（近 ${DAYS} 天，${scannedFiles} 份 / ${scannedLines} 行，去重后按行分类）',
    '各会话窗口 .workbuddy\\\\memory\\\\*.md（主线优先，同日期只取一份，避免重复计同一件事）'
  ],
  revision: {
    date: '${TODAY}',
    mode: 'auto',
    days: ${DAYS},
    added: ${jstr(up.map(r => r.t.icon + ' ' + r.t.name))},
    note: '由 profile-scan.mjs 自动重算：扫描近 ${DAYS} 天工作日志 ${scannedFiles} 份 / ${scannedLines} 行，只更新「各任务的日均调用次数与证据」，能力需求向量（上下文 / 工具 / 推理 / 视觉 / 隐私 / 省钱权重）沿用人工标定值。'
  },
  profile: ${jstr(cur.profile, null, 2).replace(/\n/g, '\n  ')},
  tasks: [
${tasksSrc}
  ]
};
`;

fs.writeFileSync(PROFILE, src, 'utf8');
console.log('\n✓ 已写入 ' + PROFILE + (NO_BAK ? '' : '（旧文件备份在 profile.local.mjs.bak）'));
console.log('  服务会按文件修改时间热加载 —— 不用重启，页面 5 分钟内自动跟上。\n');
