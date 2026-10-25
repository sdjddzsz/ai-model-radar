/**
 * AILens 本地路由网关（OpenAI 兼容代理）
 * ─ WorkBuddy / Cherry 把条目指向 http://localhost:9999/v1，模型名填 auto
 * ─ model=auto 时：按关键词把请求路由到对应条目模型，并自动挂兜底链
 * ─ model 为具体 slug 时：原样透传（手动指定的优先级最高）
 * ─ 自杀机制：Cherry + WorkBuddy 都关闭超过 2 分钟 → 自动退出（由计划任务负责再拉起）
 * ─ 规则与 AILens「模型顾问」页同一套 —— 改规则两边一起生效（顾问页在 public/index.html）
 */
import http from 'node:http';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const PORT = 9999;
const UPSTREAM = 'https://openrouter.ai/api/v1/chat/completions';
const UPSTREAM_MODELS = 'https://openrouter.ai/api/v1/models';
/* 书生·端砚（上海 AI 实验室）— OpenAI 兼容格式，科研端点 */
const INTERN_BASE = 'https://discovery-api.intern-ai.org.cn/v1';
const INTERN_MODELS_URL = 'https://discovery-api.intern-ai.org.cn/v1/models';
const BOOK_KEY_FILE = 'D:/WorkBuddy/AILens/book.key';
/* ★★ 本地端点：zcode-bridge（8787）—— 2026-10-03 新增，第三个上游。
   起因：Hermes 只有一个 base_url 槽位，AILens 网关(9999) 和 zcode-bridge(8787) 无法共存 ——
   改来改去就是「两个桥混在一起」（改 9999 → 被 providers.glm 拽回 8787；反之亦然）。
   正确解法不是让客户端折腾，而是**让网关把 8787 的模型收进来**：
   客户端只连 9999 一个端点，/v1/models 里同时列出 AILens 路由池 + GLM 系列，选谁都在同一个列表里。
   ★ 为什么这几个模型走本地而不是 OpenRouter：它们是 zcode-bridge 独有的（OpenRouter 没有），
     且 GLM-5.3-Flash 是免费即时档，适合做兜底/强制的确定性选项。 */
const LOCAL_BASE = 'http://127.0.0.1:8787/v1';
const LOCAL_MODELS_URL = LOCAL_BASE + '/models';
const LOCAL_MODELS = new Set(['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']);
/* zcode-bridge 的 /v1/models 不返回窗口字段（实测 4 个模型都没有 context_length），
   下面这些值取自 Hermes 侧 providers.glm 段里用户自己填的 context_length（1M），
   并且我按 GLM 官方规格核对过：GLM-5 系列 1M 窗口成立。 */
const LOCAL_CTX = {
  'GLM-5.3': 1000000, 'GLM-5.3-Flash': 1000000, 'GLM-5.2': 1000000, 'GLM-5-Turbo': 1000000
};
const LOGF = 'D:/WorkBuddy/AILens/gateway-log.jsonl';
const CONFIG_FILE = 'D:/WorkBuddy/AILens/config/endpoints.json';   /* 手动路由配置（mode/endpoints/routing） */
const REGISTRY_FILE = 'D:/WorkBuddy/AILens/config/model-registry.json';  /* ★ 模型档案：追踪上/下架与转收费（跨进程持久化） */
const PIDF = 'D:/WorkBuddy/AILens/gateway.pid';
const APPS = ['Cherry Studio.exe', 'WorkBuddy.exe'];

/* ★ 动态上下文显示：记住最近一次实际服务的模型及其窗口，
   GET /models 里 auto 条目的 context 就跟着变 —— WorkBuddy 在消息返回后刷新显示时能看到真实窗口 */
let lastServedModel = null;
let lastServedCtx = null;
let lastServedAt = 0;          /* ★ lastServedModel 的时间戳(ms)：供外部判断「这轮对话是否刚结束」 */
let lastServedUa = '';         /* ★ 20:05 新增：这轮请求的 UA。外部同步器据此判断「是否 WorkBuddy 自己发的」——
                                  本机 WorkBuddy 与 Hermes(Cherry 也可能) 共用本网关，若不区分客户端，
                                  对方流量会覆盖 lastServedModel → 外部脚本把 id 改来改去 → WorkBuddy 反复热重载。*/
function noteServed(m, ua) {
  if (!m) return;
  lastServedModel = m;
  lastServedCtx = modelCtx({ id: m }) || null;
  lastServedAt = Date.now();
  if (ua) lastServedUa = String(ua).slice(0, 120);
}

/* ★ 书生系模型真实上下文窗口。
   2026-10-01 修正：之前注释写「书生 /models API 不返回该字段」—— **错的，它返回了，
   位置是 data[].input_modalities[].supported_inputs.max_context_length.value（单位 token）**。
   我9-30 当时只看了 data[].id/name 就断定「未公布」，导致 4 个模型在 /models 里没有窗口字段
   → auto 的 ctx 跟随实际路由漂移时对不上（昨天 21:15 记的那个「无法修复」结论，部分原因就在这）。
   下列值全部取自书生端点 /models 实测，不再靠第三方文档交叉推测。 */
const INTERN_CTX = {
  'intern-s2': 262144,                 /* 实测 262144 */
  'Atria-Dawn-Preview': 524288,        /* 实测 524288 */
  'Agents-A1': 262144,                 /* 实测 262144 */
  'deepseek-v4-pro-0813': 1048576,     /* 实测 1048576 */
  'deepseek-v4-flash-0731': 1048576,   /* 实测 1048576 */
  'deepseek-v4-flash-vision': 1048576, /* 实测 1048576 */
  'glm-5.3': 1048576,                  /* 实测 1048576 */
  'kimi-k2.6': 262144,                 /* 实测 262144 */
  'minimax-m3': 1048576,               /* 实测 1048576 */
  'qwen3.8-27b': 262144                /* 实测 262144 */
};
/* ★ 显示名美化（2026-10-01，方案 B）：动态池里模型 id 很长（nvidia/nemotron-3-ultra-550b-a55b:free），
   直接当名字在客户端列表里没法看。规则：去掉厂商前缀、`:free` 后缀转「Free」、剩余部分把 `ai/` `vN` 之类清掉。 */
function prettyName(id) {
  let s = String(id);
  const free = /:free$/.test(s);
  s = s.replace(/:free$/, '');
  s = s.replace(/^stealth\//, '');            /* space-bunny-alpha → SpaceBunnyAlpha */
  const seg = s.split('/').pop() || s;
  const nice = seg
    .replace(/-/g, ' ')
    .replace(/\b(\d)b\b/gi, '$1B')
    .trim()
    .replace(/\s+/g, ' ');
  const pretty = nice.replace(/\b\w/g, c => c.toUpperCase());
  return free ? pretty + '·Free' : pretty;
}

function modelCtx(m) {
  if (!m) return undefined;
  if (m.id === 'auto') return lastServedCtx || 1048576;
  return prices[m.id]?.ctx || INTERN_CTX[m.id] || LOCAL_CTX[m.id] || undefined;
}


/* ---------- 书生墨点追踪 ---------- */
const TOKENS_PER_DIAN = 5e6;   /* 1 墨点 = 500 万 tokens */
/* 5 小时限额：10 墨点；7 天限额：50 墨点（用户确认 2026-09-30：控制台 `10.000`/`50.000` 即 10.0/50.0，小数点非千分位）
   ⚠ 教训：不要把带三位小数零的数字误读为千分位，10.000 = 十，50.000 = 五十 */
const QUINTA_5H_LIMIT = 10;    /* 5 小时限额：10 墨点 */
const QUINTA_7D_LIMIT = 50;    /* 7 天限额：50 墨点 */
const QUOTA_FILE = 'D:/WorkBuddy/AILens/gateway-quota.json';
const CONSOLE_QUOTA_FILE = 'D:/WorkBuddy/AILens/config/intern-quota-console.json';   /* 控制台手动同步的真实墨点值（书生无余额 API，用户从控制台同步） */
let quota = { used5h: 0, used7d: 0, lastReset5h: Date.now(), lastReset7d: Date.now() - 7 * 86400e3 };

function loadQuota() {
  try {
    const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    quota = { ...quota, ...data };
    /* 自动重置：5 小时/7 天到期 */
    if (Date.now() - quota.lastReset5h > 5 * 3600e3) { quota.used5h = 0; quota.lastReset5h = Date.now(); }
    if (Date.now() - quota.lastReset7d > 7 * 86400e3) { quota.used7d = 0; quota.lastReset7d = Date.now(); }
  } catch {}
}
function saveQuota() {
  try { fs.writeFileSync(QUOTA_FILE, JSON.stringify(quota, null, 2)); } catch {}
}
loadQuota();

function recordInternUsage(promptTokens, completionTokens) {
  const totalTokens = (promptTokens || 0) + (completionTokens || 0);
  const dianUsed = totalTokens / TOKENS_PER_DIAN;
  quota.used5h += dianUsed;
  quota.used7d += dianUsed;
  saveQuota();
  return dianUsed;
}

/* 读控制台手动同步配额：真实值快照，带 5h/7d 窗口自动重置；读不到/格式不对返回 null */
function readConsoleQuota() {
  try {
    const cs = JSON.parse(fs.readFileSync(CONSOLE_QUOTA_FILE, 'utf8'));
    if (!cs || cs.used5h == null || cs.used7d == null) return null;
    const q = { used5h: +cs.used5h || 0, used7d: +cs.used7d || 0, lastReset5h: cs.lastReset5h || 0, lastReset7d: cs.lastReset7d || 0 };
    if (q.lastReset5h && Date.now() - q.lastReset5h > 5 * 3600e3) q.used5h = 0;
    if (q.lastReset7d && Date.now() - q.lastReset7d > 7 * 86400e3) q.used7d = 0;
    return q;
  } catch { return null; }
}

function isInternQuotaExhausted() {
  /* 5 小时或 7 天任一超限 → 切 OpenRouter
     ★ 判定取「控制台手动同步值」与「网关本地估算」的较大者：控制台是真实值，
       本地估算可能滞后（限时不扣墨点模型不记账），取大者防真实额度耗尽后仍走扣墨点模型 */
  const cs = readConsoleQuota();
  const u5 = Math.max(quota.used5h, cs ? cs.used5h : 0);
  const u7 = Math.max(quota.used7d, cs ? cs.used7d : 0);
  return u5 >= QUINTA_5H_LIMIT || u7 >= QUINTA_7D_LIMIT;
}

/* ---------- key：env → 注册表 → gateway.key 文件（测试用） ---------- */
function getKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const o = execSync('reg query HKCU\\Environment /v OPENROUTER_API_KEY', { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const m = o.match(/REG_SZ\s+(\S+)/);
    if (m) return m[1];
  } catch {}
  try { return fs.readFileSync('D:/WorkBuddy/AILens/gateway.key', 'utf8').trim(); } catch {}
  return '';
}
const KEY = getKey();
/* 书生 Key：读 book.key（用户从书生·端砚控制台获取的独立 Key） */
function getBookKey() {
  try { return fs.readFileSync(BOOK_KEY_FILE, 'utf8').trim(); } catch {}
  if (process.env.INTERN_API_KEY) return process.env.INTERN_API_KEY;
  return '';
}
const BOOK_KEY = getBookKey();
const PRICEF = 'D:/WorkBuddy/AILens/gateway-prices.json';
const MODALITY_FILE = 'D:/WorkBuddy/AILens/gateway-modalities.json';   /* modelId → input_modalities（架构性事实，用于模态校验） */
/* ★ 必须声明在 loadPrices() 调用之前 —— 下面 loadPrices 里会往它写。
   曾因声明位置在文件后段（与 VISION_MODELS 放一起）导致 TDZ ReferenceError，
   而 loadPrices 整体裹在 try/catch 里 → 静默失败、连价格缓存都不写了。 */
const OR_MODALITY = {};   /* modelId → ['text','image',...] */
const prices = {}; /* modelId → { priceIn1M, priceOut1M } */
async function loadPrices() {
  try {
    if (fs.existsSync(PRICEF)) prices[loadedAt] = JSON.parse(fs.readFileSync(PRICEF, 'utf8'));
  } catch {}
  try {
    const r = await fetch(UPSTREAM_MODELS, { headers: { Authorization: 'Bearer ' + KEY } });
    const j = await r.json();
    const data = (j && j.data) || [];
    for (const m of data) {
      const p = m.pricing || {};
      const in1M = +(parseFloat(p.prompt || 0) * 1e6);
      const out1M = +(parseFloat(p.completion || 0) * 1e6);
      if (m.id && Number.isFinite(in1M)) prices[m.id] = { priceIn1M: in1M, priceOut1M: out1M, ctx: m.context_length || 0 };
      /* ★ 2026-10-02 21:40：顺手记下模态属性（架构性事实，不该靠模型名猜）。
         起因是带图请求被路由到纯文本模型后静默丢图 —— 有了这张表，路由才能做模态校验。
         实证价值：inclusionai/ling-3.0-flash 名字里没有 vl 但 in=['text']（纯文本），
         而 stealth/space-bunny-alpha 名字完全看不出是视觉的，in=['text','image','video']。 */
      if (m.id && m.architecture) {
        OR_MODALITY[m.id] = Array.isArray(m.architecture.input_modalities) ? m.architecture.input_modalities : [];
      }
    }
    fs.writeFileSync(PRICEF, JSON.stringify(prices), 'utf8');
    try { fs.writeFileSync(MODALITY_FILE, JSON.stringify(OR_MODALITY, null, 0), 'utf8'); } catch {}
  } catch (e) { /* 静默:价格缓存缺失不影响使用 */ }
}
/* ★ 视觉登记表自检：启动后校验「我以为能读图的模型，OpenRouter 到底说它 input_modalities 是什么」。
   放在文件末尾（此处）而不是 loadPrices 里 —— VISION_MODELS 在后段才声明，
   在 loadPrices 里引用它会 TDZ 报错并被 try/catch 静默吞掉，连价格都不写。
   价值：若哪天某个模型下线或改了模态，这里会留痕，而不是等到「用户说看不见图」才发现。 */
function auditVisionRegistry() {
  const rows = [];
  for (const v of VISION_MODELS) {
    const im = OR_MODALITY[v];
    rows.push({ model: v, input_modalities: im || '(未取到)', ctx: prices[v]?.ctx || 0 });
    if (im && !im.includes('image')) log({ t: new Date().toISOString(), visionRegistryMismatch: v, input_modalities: im });
  }
  for (const b of VISION_BLOCKLIST) {
    const im = OR_MODALITY[b];
    if (im && im.includes('image')) log({ t: new Date().toISOString(), visionBlocklistStale: b, input_modalities: im, note: '现已支持图，可从黑名单移除' });
  }
  log({ t: new Date().toISOString(), visionRegistryAudit: rows });
}
const loadedAt = Date.now();
await loadPrices();
/* 书生价格：从 intern-ai /models 拉（和 OpenRouter 价格合并） */
async function loadInternPrices() {
  if (!BOOK_KEY) return;
  try {
    const r = await fetch(INTERN_MODELS_URL, {
      headers: { Authorization: 'Bearer ' + BOOK_KEY },
      signal: AbortSignal.timeout(15000)
    });
    const j = await r.json();
    const data = (j && j.data) || [];
    for (const m of data) {
      const p = m.pricing || {};
      const in1M = +(parseFloat(p.prompt || 0) * 1e6);
      const out1M = +(parseFloat(p.completion || 0) * 1e6);
      if (m.id && Number.isFinite(in1M)) prices[m.id] = { priceIn1M: in1M, priceOut1M: out1M, ctx: m.context_length || 0 };
    }
  } catch { /* 书生价格缺失不影响使用 */ }
}
await loadInternPrices();

/* ---------- 路由规则（与 public/index.html「模型顾问」保持同步） ---------- */
const RULES = {
  /* ★ 手机/设备操作档（23:46 扩充）：原正则只有 adb/uiautomator/控件树 等工程词，
     真实手机操作指令（打开应用/点击/滑动/截图…）全落在 misc → ling（用户反馈太蠢） */
  adb   : /adb|uiautomator|控件树|模拟器|真机|\bdump\b|xml|mumu|取数|滚动去重|手机|安卓|android|点击|滑动|截图|截屏|打开应用|启动应用|包名|activity|长按|双击|解锁|通知栏|下拉|返回键|音量键|录屏|桌面|应用列表|坐标|\btap\b|\bswipe\b|打电话|发短信|微信|抖音/i,
  math  : /数学|定理|证明|推演|拓扑|习题|例题|测度|习题集/i,
  paper : /论文|文献|精读|综述|arxiv|知识骨架/i,
  board : /看板|工作台|排期|完成记录|台账|增量修订/i,
  resume: /简历|自我介绍|求职信|求职文书/i,
  envops: /环境|安装|装不上|venv|\bpip\b|winget|路径|权限|沙盒|排查|驱动/i,
  jd    : /\bjd\b|岗位|职位描述|招聘|任职要求|筛岗/i,
  apply : /投递|话术|打招呼|日报|进度表|\bhr\b|跟进|二次触达/i,
  code  : /python|sql|调试|语法|算法|刷题|debug/i,
  data  : /清洗|校对|格式化|规范化|csv|去重|批量整理|条目/i,
  site  : /部署|上线|线上验证|单文件|热更新|h5|移动端页面|网页构建/i,
  tool  : /写个脚本|从零写|小工具|批处理|\bbat\b|\.cmd|自动化脚本|帮我写/i,
  agent : /多步|编排|流水线|全流程|一键完成/i,
  misc  : /翻译|润色|改写|翻译润色|文本润色|文笔润色|语言润色|英文润色|中英|汉英|英中/i

  /* ★★ 2026-10-02 17:15 架构调整（用户指令：「所有任务都通过模型判断再选模型」）：
     RULES 整体**降级为「辅助信号」**，不再直接决定路由。
     之前它有两宗罪：
       1) 词典太宽（「总结/解释/续写/六级」这类通用需求也命中）→ 复杂工程请求被硬判 misc → cheap tier 跑 ling；
       2) 命中即 confident → LLM 语义分类**永远轮不到**，正则成了唯一裁判。
     现在流程：classifySmart 无条件走 classifyLLM 定类（模型读懂真实意图），
     RULES 只做两件事：① 把命中的候选标签作为 hint 塞进分类器 prompt；② LLM 失败/超时时的兜底。
     保留 adb ×3 加权与超长文本启发式，因为这两条是客观结构特征（真机操作 + 3 万字以上 dump），
     不会像「翻译/润色」那样误伤普通请求 —— 仅作为 hint，不作为裁决。 */
};
/* ENTRY 只保留「必须用特定强档模型」的映射。
   ★ adb 不再硬编码 qwen3.7-flash（10-01 修）：那会让 adb 任务绕过整个动态池，
   45 万 token 的 adb 请求实测 74s（qwen）而非 11s（nemotron）。改为 adbEntry() 按上下文长度动态选。
   ★★ 2026-10-02 18:50 strong 档换模型：原 nex-agi/nex-n2.5-pro 实测长思考 90 秒超时、
     短请求正文空（思考吃光预算），已不可用。改用 deepseek/deepseek-chat（实测 37s / 1086 字）。
     同时挂 deepseek/deepseek-v4-pro 作兜底位（1M 窗口，抗长上下文）。 */
const ENTRY = { strong: 'deepseek/deepseek-chat', strongAlt: 'deepseek/deepseek-v4-pro' };
/* adb（手机/设备操作）入口：需要视觉理解 + 精确推理；按真实 token 长度选模型，
   短请求走免费档，长上下文走长上下文池（nemotron 45万=11.8s vs qwen 45万=74s）。 */
/* adb（手机/设备操作）入口：需要视觉理解 + 精确推理；按上下文长度动态选。
   ★ 2026-10-02 21:40 修正：原来长上下文直接返回 LONGCTX_ACTIVE，而它当前实测是
     nvidia/nemotron-3-ultra-550b-a55b:free，architecture.input_modalities = ['text'] —— **纯文本**。
     adb 任务天然带截图（这正是它需要视觉的原因），所以长上下文的 adb 请求一直在丢图。
     → 改为走 visionEntry()：它按上下文长度在 VISION_MODELS 里选，且只认实测支持图的模型。 */
function adbEntry(realTok) {
  return visionEntry(realTok);
}

/* ★★★★ 视觉模型登记表（2026-10-02 21:40 新增，见「图片路由」注释）
   起因：用户发了张截图问「这个上下文是哪个模型的长度」，图**完全没被读到** ——
   我的上下文里那条附件被标成「this model does not accept multimodal input」。
   根因不是某个模型不行，而是**网关的路由决策里根本没有「图片」这个变量**：
     classifySmart(lastUserText(body)) 只取文本，image_url 分支被完全无视；
     estPromptTokens 把 base64 当普通字符串走字数估算，也不含视觉 token 成本。
   → 结果：带图请求的路由 = 纯文本请求的路由，纯文本模型拿到图直接丢弃（不报错，静默降级）。
   实测对照（同一张 1×1 红 PNG，唯一差别是文字措辞）：
     「这个上下文是哪个模型的长度」→ why=intern-free → Atria-Dawn-Preview（书生纯文本）→ 图丢失
     「这张图是什么颜色？」      → why=misc-vl     → ling-3.0-flash-vl（视觉）  → 图读到了
   **同一张图，因为文字不同就路由到不同模态的模型 —— 这就是「随机性」的真相。**

   下面这张表是 2026-10-02 从 OpenRouter /api/v1/models 实测拉取 architecture.input_modalities
   得到的**权威模态属性**（不是靠模型名字猜的 —— 名字带 vl/vision/omni 的不一定是真视觉，
   反之名字看不出来的也可能是真视觉，例如 stealth/space-bunny-alpha）。 */
const VISION_MODELS = [
  /* ---- 默认档：$0.021/M、4/4 实测通过、3.2s。便宜稳定，视觉请求的日常主力 ---- */
  'inclusionai/ling-3.0-flash-vl',             /* 262K，in=[text,image,video] */
  /* ---- 免费档（$0）：4/4 通过、最快（2.6s），但属试验模型 —— 21:45 实测 5 次里有 1 次
         返回了没有 choices 字段的畸形响应（重试即好）。放兜底位，不做首选：
         视觉请求本来就不该为省 $0.02 冒「整轮白等 + 图没读到」的风险。 ---- */
  'stealth/space-bunny-alpha',                 /* 1M，in=[text,image,video] */
  /* ---- 长上下文档（>20 万真实 token）：前面两个窗口只有 262K，接不住 ---- */
  'qwen/qwen3.7-flash',                        /* 1M，in=[text,image,video]，$0.03/M */
  /* ---- 强档：视觉推理硬任务（截图里的小字/表格/流程图） ---- */
  'deepseek/deepseek-v4-flash-vision-exp',     /* 1M，in=[text,image]，4/4、2.3s 最快 */
  'qwen/qwen3.8-omni-flash',                   /* 1M，全模态（含 audio） */
  'qwen/qwen3-vl-8b-instruct'                  /* 262K，纯视觉，$0.117/M */
];
/* 书生系里唯一真能读图的是 deepseek-v4-flash-vision，但 10-02 17:45 实测 HTTP 429 quota exceeded，
   已从 misc 路由里移除。所以**带图请求一律走 OpenRouter**，不走书生分支 —— 视觉优先于「不扣墨点」。 */
const VISION_BLOCKLIST = new Set([
  'nvidia/nemotron-3-ultra-550b-a55b:free',    /* 实测 in=['text']，1M 但纯文本，名字有欺骗性 */
  'inclusionai/ling-3.0-flash',                /* 实测 in=['text'] —— 和它的 -vl 同族但不支持图！ */
]);

/* ★ 请求里是否含图片：遍历 messages 找 image_url / input_image / image 类型的 part。
   兼容三种格式（OpenAI / Anthropic / 裸字符串 data URL），因为不同客户端发法不一样：
     - { type:'image_url', image_url:{url:'data:...'} }   OpenAI 标准，WorkBuddy 走这条
     - { type:'input_image', source:{...} }                 Anthropic 风格
     - { type:'image', source:{...} }                       裸 image
   ★ 只看**最后一条 user 消息**：历史里的旧图不代表本轮需要看图（多轮对话里每轮都重发全部历史图，
     若按全量判断会导致每轮都强升视觉档，哪怕这轮只是纯文字追问）。 */
function hasImageContent(body) {
  const ms = body.messages || [];
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (Array.isArray(c)) {
      for (const p of c) {
        if (!p || typeof p !== 'object') continue;
        const t = String(p.type || '').toLowerCase();
        if (t === 'image_url' || t === 'input_image' || t === 'image') return true;
      }
    }
    return false;   /* 最后一条 user 消息没有图 → 整轮按纯文本处理 */
  }
  return false;
}

/* ★ 视觉档入口：按上下文长度在 VISION_MODELS 里选。
   长上下文（>20 万真实 token）必须挑 1M 窗口的（ling-vl / qwen3-vl-8b 只有 262K，会超窗），
   短请求走列表里第一个健康且实测支持图的模型。
   双重保险：
     1) VISION_BLOCKLIST 排除已知纯文本模型；
     2) 用 OpenRouter 实测的 OR_MODALITY 再校验一次（表里没有 image 的一律不选）——
        元数据说自己支持图 ≠ 真能读图，所以这一层只做减法，实际能力靠 21:45 的实测基线。 */
function visionEntry(realTok) {
  const long = realTok > LONGCTX_MIN_TOKENS;
  const usable = VISION_MODELS.filter(m => !VISION_BLOCKLIST.has(m) && isHealthy(m));
  for (const m of usable) {
    const im = OR_MODALITY[m];
    if (im && !im.includes('image')) continue;      /* 元数据说没图 → 不选 */
    const ctx = prices[m]?.ctx || 0;
    if (!long || ctx >= 900000) return m;
  }
  /* 兜底：1M 窗口 + 实测 4/4 通过的模型（长上下文时也接得住） */
  return long ? 'qwen/qwen3.7-flash' : 'inclusionai/ling-3.0-flash-vl';
}
/* 兜底链：primary 失败依次尝试。★ 18:50 移除 nex-agi/nex-n2.5-pro —— 实测长思考 90s 超时，
   留在链里等于白等一轮。换成 deepseek/deepseek-v4-pro（1M 窗口，与 strongAlt 同族）。 */
const CHAIN = ['inclusionai/ling-3.0-flash-vl', 'deepseek/deepseek-v4-pro', 'qwen/qwen3.7-flash'];
/* ★★★ RESERVE_MODELS（2026-10-02，用户提问「其它高强度情景对应的模型不需要加？万一有需要强模型的任务呢」触发）
   上一版只有 EXTRA_MODELS 两个（space-bunny + deepseek-chat），漏了「强度 × 窗口」储备这件事。
   动态池只有 free（$0）和长上下文（1M 廉价）两个轴，**付费强模型不在任何池里** ——
   真遇到硬任务（数学推导、长论文分析、代码重构）时，除了 nex-n2.5-pro 之外没有别的选择。
   所以这里显式维护一个矩阵，全部数值取自 OpenRouter /api/v1/models 实测（2026-10-02），不是拍脑袋：

   【免费档$0】      space-bunny-alpha(1M 多模态) / nemotron-ultra(1M，当前 free 首选)
   【廉价档 ≤$0.11/M】 deepseek-v4-flash-0731(1M) / qwen3.7-flash(1M) / ling-3.0-flash-vl(262K)
                   nex-n2.5-pro(262K，强档主力) / nex-n2.5-mini(262K)
   【中档 $0.11~0.3/M】deepseek-v4.1-flash(1M) / qwen3.8-omni-flash(1M 多模态)
                   xiaomi/mimo-v2.6-flash(1.05M) / qwen3-coder-next(262K 代码向)
   【强档 >$0.3/M】   deepseek-v4-pro(1M) / deepseek/deepseek-chat / glm-5.2(1M) —— 旗舰系，当前 tierOf 会判 premium 故不进池
   选型原则：**同等窗口下按「便宜优先，只有强度不够才升档」**，避免一上来就烧旗舰的钱。
   注意：这些只是「能被客户端选到」的储备，实际 auto 路由选谁仍由 refreshFree + TASK_ENTRY 决定。 */
const RESERVE_MODELS = [
  /* 免费 */
  'stealth/space-bunny-alpha',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  /* 廉价（兜底与日常主力） */
  'deepseek/deepseek-v4-flash-0731',
  'qwen/qwen3.7-flash',
  'inclusionai/ling-3.0-flash-vl',
  'nex-agi/nex-n2.5-pro',   /* ⚠ 实测长思考 90s 超时、短请求正文空，只作可选别当主力（18:50） */
  'nex-agi/nex-n2.5-mini',
  /* 中档（需要更强推理但不想烧旗舰） */
  'deepseek/deepseek-v4.1-flash',
  'qwen/qwen3.8-omni-flash',
  'xiaomi/mimo-v2.6-flash',
  'qwen/qwen3-coder-next',
  /* 强档（硬任务兜底：数学推导 / 长论文 / 大规模重构） */
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-chat',
  'z-ai/glm-5.2',
];
/* ★★★ 档位重定（2026-10-02 18:50，依据当天实测重定，不是拍脑袋）：
   原配置有两个致命错配，用「解释一下测度空间里可测集的证明思路」+effort=high 实测暴露：
     1. math/paper 走 THINK_ON → intern-s2 → **跑满 300 秒超时**，请求全废
        （intern-s2 适合 7-15s 的短思考，扛不住真数学推导；它 850~2700 个 reasoning token 才吐正文）
     2. strong 档主力 ENTRY.strong = nex-agi/nex-n2.5-pro → 长思考 **90 秒超时**；
        短请求虽 6-14s 但**正文空**（思考吃光预算）
   实测可用（同一道 math 题）：
     deepseek/deepseek-chat        37s / 1086 字 ✓
     meta-llama/llama-3.3-70b      15s / 1372 字 ✓
   → ① 深度思考只留给 math/paper（真需要长推导的），board/resume/jd/apply 是结构化任务，
        没必要烧思考预算 —— 原配置让 4 个低需求任务白开 thinking_mode。
     ② strong 档换 deepseek/deepseek-chat，不再用会超时的 nex-n2.5-pro。
     ③ math/paper 排除出书生分支（见 STRONG_OR），否则又被 intern-s2 接手。 */
const TASK_ENTRY = { resume:'cheap', jd:'cheap', apply:'cheap', adb:'adb', math:'strong', paper:'strong', board:'cheap', tool:'cheap', agent:'cheap', envops:'cheap', code:'cheap', data:'cheap', site:'cheap', misc:'cheap' };
/* 只有这两类真需要长推导，开深度思考 */
const THINK_ON = new Set(['math', 'paper']);
/* ★ 需要 OpenRouter 强档（不能走书生）的任务：书生的 intern-s2 处理它们会 300s 超时 */
const STRONG_OR = new Set(['math', 'paper']);
/* 书生科研端点真实模型集合（2026-09-30 实测 /models）——不能用 intern 前缀判断（聚合平台含 deepseek/glm/kimi 等） */
const INTERN_MODELS = new Set(['intern-s2', 'deepseek-v4-flash-0731', 'deepseek-v4-flash-vision', 'deepseek-v4-pro-0813', 'glm-5.3', 'kimi-k2.6', 'minimax-m3', 'qwen3.8-27b', 'Agents-A1', 'Atria-Dawn-Preview']);
/* ★ 书生·端砚「限时不扣墨点」模型（2026-09-30 用户确认）：当前限时活动期间不消耗墨点额度，
   作为书生侧优先免费主力，且不受配额耗尽逻辑拦截。活动结束把本集合清空即可恢复墨点计费。
   ⚠★ 2026-10-02 17:45 用户提示「deepseek-v4-flash-vision 没额度」后实测：
     deepseek-v4-flash-vision → **HTTP 429 quota exceeded，完全不可用**（misc 曾硬编码选它，已改走 ling-3.0-flash-vl）。
     另外三个「免费」模型用**难题**测（用一句话说明什么是拓扑学）：
       Atria-Dawn-Preview → 76.8s（850 reasoning token）、intern-s2 → 65.0s（2709 token）、
       Agents-A1 → 32s 且 finish=length **正文空**（2048 token 全被思考吃掉）。
     但改用**真实请求形态**（system + 8 轮历史 + 「你好，简单回一句」）复测：
       Atria **7.2s**、intern-s2 **15.3s** —— 都在客户端超时内，短请求完全可用。
     → **这三个是强制深度推理型，慢不慢取决于任务难度，不是模型本身慢。**
     → 用难题探针给短请求场景下结论会严重误判（我第一版就误判了）。探测延迟必须用**贴近生产的请求形态**。
     → INTERN_NOQUOTA 只应理解为「不消耗墨点额度」，不等于「输出稳定」：Agents-A1 思考吃光正文是真风险。 */
const INTERN_NOQUOTA = new Set(['intern-s2', 'Atria-Dawn-Preview', 'Agents-A1', 'deepseek-v4-pro-0813']);

/* ---- 免费档动态探测：:free 池会变（上下架/转收费），每 6h 校验一次 ----
   ★ 2026-10-01 重构：候选名单不再硬编码，改为「实时拉 /models 免费池 + 能力过滤 + 速度基准排序」自动生成。
   起因：09-30 路由方案里硬编码的 5 个候选已过时（实测免费池有 20 个 $0 模型，
   nvidia/nemotron-3-ultra-550b-a55b:free 这类 1M 窗口大模型当时完全不在名单里）。 */
const FREE_PREFS = [
  'qwen/qwen3.8-27b:free',                      /* 国产 Qwen，中文任务优先 */
  'inclusionai/ling-3.0-flash-sante:free',      /* 国产 Ling 免费档 */
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'cohere/north-mini-code:free'                 /* 代码向兜底 */
];

/* ★ 速度基准（毫秒/百万 prefill token，实测或公开评测；越小越快）。
   用于在多个同窗口免费模型间自动排序。null = 未实测，排最后。
   ★ 2026-10-01 实测（45 万 token 冷启动，见 memory 日志）：nemotron-ultra-550b 3.4s，
     而历史 qwen3.7-flash 40 万 = 55s、deepseek-0731 40 万 = 94s（超时）。
   550B 参数 + 1M 窗口 + 免费 + 数量级更快 → 长上下文首选。 */
const SPEED_BENCH = {
  'nvidia/nemotron-3-ultra-550b-a55b:free': 7500,    /* 45万 tok 冷启动实测 3.445s → 极快 */
  'qwen/qwen3.8-27b:free': 220000,
  'inclusionai/ling-3.0-flash-sante:free': 240000,
  'google/gemma-4-31b-it:free': 260000,
  'nvidia/nemotron-3-super-120b-a12b:free': 300000,
  'nvidia/nemotron-3.5-lightning:free': 320000,      /* 38万 tok 实测 142s */
  'qwen/qwen3.7-flash': 137500,                     /* 40万 tok 实测 55s */
  'deepseek/deepseek-v4-flash-0731': 235000,         /* 40万 tok 实测 94s → 超时 */
  'dots-studio/dots-3-note-preview:free': 280000,
  'poolside/laguna-s-2.1:free': 250000,
  'google/gemma-4-26b-a4b-it:free': 270000,
};

/* ★ 免费档能力过滤规则：自动挑选时排除这些模型
   - ctx < 200000：免费池里大量小窗口模型，长会话扛不住
   - 排除清单：仅 agentic harness 可用 / 非对话模型（嵌入·重排·音乐）/ 已知空回复 */
const FREE_MIN_CTX = 200000;
const FREE_BLOCKLIST = new Set([
  'thinkingmachines/inkling:free',            /* 403 仅 agentic harness */
  'thinkingmachines/inkling-small:free',      /* 同上 */
  'google/lyria-3-pro-preview',              /* 音乐生成，非对话 */
  'google/lyria-3-clip-preview',             /* 音乐生成 */
  'openrouter/auto',                         /* 路由型模型，会递归 */
  'openrouter/free',                         /* 路由型模型 */
  'typesafe/jev-router',                     /* 第三方路由，行为不可控 */
]);
/* 注：stealth/space-bunny-alpha 不在黑名单。
   2026-10-01 我曾用 max_tokens=100 探针测得「回复为空」，据此误判为空回复并拉黑 ——
   实为探针参数错误：该模型是强制推理模型（reasoning 必开），100 token 全被思考过程吃掉，
   正文没空间输出。用户实际使用完全正常。任何强制推理模型探针都要给足 max_tokens（≥1024）。 */

/* ★ 通用排除规则（长上下文档也适用）——
   教训：只按 ctx 筛选会把天价模型选进来。演练实测长上下文候选里混进了
   gpt-6.1-sol-pro($2/1M)、claude-sonnet-5.5($2/1M)、fireworks/ember-1($3/1M)、
   glm-5.3-prime($2.8/1M)、qwen3.8-max-prime($4/1M)。
   真正的长上下文模型应该是「flash/lightning/free 这类廉价档」，而不是旗舰。
   名称信号：opus/sonnet/pro/max/prime/flagship/premium/ultra。 */
const NON_CHEAP_MODEL = /(opus|sonnet|\bpro\b|max|prime|flagship|premium|gpt-6|gpt-5|gemini.*(pro|ultra))/i;
const NON_CHEAP_CTX = /(opus|sonnet|max|prime)/i;

/* 长上下文档：prompt 超过 20 万 est 时切换 —— 排序按「速度」不按价格：客户端 ~60s 超时，慢模型=不可用
   实测（16:15-16:35 探针）：qwen3.7-flash 27.5万 tok 7-50s（历史实测）；deepseek-0731 25万=89s、37.5万=66s（太慢）；
   nemotron 38万 tok 142s（更慢）。deepseek 便宜 3 倍但超时=白搭，故 qwen 优先 */
const LONGCTX_PREFS = [
  'qwen/qwen3.7-flash',                           /* 1M ctx，$0.03/1M 输入 —— 快（21:33 曾删，21:36 实测 deepseek-0731 太慢，恢复） */
  'deepseek/deepseek-v4-flash-0731',              /* 1.05M ctx，$0.01/1M 输入 —— 便宜但 prefill 慢，第二顺位 */
  'nvidia/nemotron-3.5-lightning:free'            /* 1M 免费，大上下文慢（38万 tok 实测 142s），最后兜底 */
];
/* 书生长上下文模型（免费墨点）—— 优先于 OpenRouter。
   deepseek-v4-flash-0731：与 OpenRouter 同名模型（1.05M 窗口），书生侧免费墨点 */
const INTERN_LONGCTX = 'deepseek-v4-flash-0731';
const LONGCTX_MIN_TOKENS = 200000;   /* 估算 prompt 超过此值 → 切长上下文模型（估算偏保守，留余量） */
let FREE_ACTIVE = FREE_PREFS[0];
let LONGCTX_ACTIVE = LONGCTX_PREFS[0];
/* ★ 动态池快照（供 /route-pool 端点观测，运维用） */
let freePoolSnapshot = [...FREE_PREFS];
let longCtxFallbacks = [...LONGCTX_PREFS];
let freeCheckedAt = 0;

/* ---------- ★ WorkBuddy 内置三档的服务端黑盒路由 id（2026-10-02） ----------
   这三个 id 在 WorkBuddy 里只有 credits 倍率和文案，客户端不选模型、由 WorkBuddy 服务端决定。
   若它们带着自定义端点配置发到本网关，一律归一化回 auto 走本网关的任务分类（见 POST 入口别名归一化）。*/
const TIER_IDS = new Set(['fast-model', 'balanced-model', 'deep-model']);

const MODEL_HEALTH = new Map(); /* modelId → {fails, lastFail} */
const HEALTH_MAX_FAILS = 2;      /* 连续失败 2 次 → 状态不佳 */
const HEALTH_COOLDOWN = 5 * 60 * 1000; /* 冷静期 5 分钟，期间跳过该模型 */
function isHealthy(m) {
  const h = MODEL_HEALTH.get(m);
  if (!h) return true;
  if (h.fails >= HEALTH_MAX_FAILS && Date.now() - h.lastFail < HEALTH_COOLDOWN) return false;
  return true;
}
function recordSuccess(m) { MODEL_HEALTH.delete(m); }
function recordFail(m) {
  const h = MODEL_HEALTH.get(m) || { fails: 0, lastFail: 0 };
  h.fails++;
  h.lastFail = Date.now();
  MODEL_HEALTH.set(m, h);
}
/* ---- 上下文预警 & 压缩信号 ----
   当本轮对话 token/ratio > WARN_RATIO 时，在 [DONE] 前插入一条 _compress signal data chunk。
   下游监听器可据此自动触发压缩 / 分片操作。
   信号格式：data: {"_compress":true,"model":"...","prompt_tokens":N,"completion_tokens":N,"total_tokens":N,"ratio":0.XX} */
const COMPRESS_WARN_RATIO = 0.80;    /* 超过 80% → emit signal */
const COMPRESS_CRITICAL_RATIO = 0.92; /* 超过 92% → emit URGENT signal */
let lastUsageRecord = {};            /* 最近一轮 usage 快照（供外部查询） */
function emitCompressSignal(res, servedModel, usage) {
  if (!usage) return;
  const total = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
  const ctx = modelCtx({ id: servedModel });
  if (!ctx || !total || total < ctx * COMPRESS_WARN_RATIO) return;
  const ratio = +(total / ctx).toFixed(3);
  let level = ratio >= COMPRESS_CRITICAL_RATIO ? 'URGENT' : 'WARN';
  const sigChunk = 'data: ' + JSON.stringify({
    _compress: true,
    _level: level,
    model: servedModel,
    context_length: ctx,
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: total,
    ratio: ratio
  }) + '\n\n';
  lastUsageRecord[servedModel] = { t: new Date().toISOString(), ...usage, ratio };
  res.write(sigChunk);
}

/* 下架判定阈值：连续 N 次刷新（每次 6h）不在列表里才标 delisted，避免网络抖动误杀 */
const DELIST_THRESHOLD = 3;

/**
 * ★★★ 动态路由池 v2（2026-10-01）
 * 用户要求：模型池随实际情况动态变化 —— 转收费/下架/过时自动处理，不靠人盯。
 *
 * 设计：
 *  1) 每次刷新从 OpenRouter 实时 /models 重建候选，不依赖硬编码名单。
 *  2) 三档自动分类（价格驱动，不写死任何模型 ID）：
 *       free    = prompt & completion 均为 $0
 *       cheap   = ≤ $0.1/1M（长会话可用档）
 *       premium = > $0.1/1M 或名称命中旗舰正则 → 直接排除
 *  3) 模型档案 config/model-registry.json 跨进程持久化，记录每个模型的状态变迁：
 *       seen → free / paid / delisted（下架）/ revived（回归）
 *     - 转收费：从 free 档移出，进 cheap 档（若仍值得用：价格达标 + 有速度基准）
 *     - 下架：连续 N 次刷新不在列表里 → 标记 delisted → 从所有池清除
 *  4) 排序依据 SPEED_BENCH（实测 ms/1M prefill token）。客户端 ~60s 超时是硬约束，
 *     慢模型 = 白搭，所以长上下文档档纯按速度排。
 */
function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch { return { models: {}, updatedAt: null }; }
}
function saveRegistry(reg) {
  try {
    fs.writeFileSync(REGISTRY_FILE + '.tmp', JSON.stringify(reg, null, 2));
    fs.renameSync(REGISTRY_FILE + '.tmp', REGISTRY_FILE);   /* 原子写，防半截文件 */
  } catch (e) { log({ t: new Date().toISOString(), registryWriteFailed: String(e.message || e) }); }
}

/* 档位判定（纯价格 + 名称规则，无硬编码模型）
   ★ 价格单位陷阱：OpenRouter pricing 是「每 token 单价」，$0.1/1M tokens = 0.0000001。
   我曾写成 p <= 0.0001（=$100/1M），实际会把 $3/1M 的模型当廉价档收进池子 —— 三个数量级之差。 */
const PRICE_PER_M = 1000000;
const CHEAP_MAX_USD_PER_M = 0.1;          /* 廉价档上限 $0.1/1M */
function tierOf(m) {
  if (FREE_BLOCKLIST.has(m.id)) return 'blocked';
  /* ★ 排除规则必须放在价格分档「之前」：否则 `p===0` 的免费滚动别名会先被判成 free 而绕过排除。 */
  /* 路由型（openrouter/auto 之类）→ blocked，防递归。 */
  if (/^(openrouter|typesafe)\//.test(m.id)) return 'blocked';
  /* `~` 前缀 = OpenRouter 滚动别名（如 ~deepseek/...-latest）：指向的底层模型随时会换，
     缓存失效 + 质量漂移，历史教训（09-30 23:42）已确认不可用于生产路由 → 一律排除。 */
  if (m.id.startsWith('~')) return 'blocked';
  const p = parseFloat(m.pricing?.prompt);
  const pc = parseFloat(m.pricing?.completion);
  if (p === 0 && pc === 0) return 'free';
  /* 名称命中旗舰档 → premium（不进免费/廉价池） */
  if (NON_CHEAP_MODEL.test(m.id) || NON_CHEAP_CTX.test(m.id)) return 'premium';
  const usdPerM = p * PRICE_PER_M;
  if (Number.isFinite(usdPerM) && usdPerM <= CHEAP_MAX_USD_PER_M) return 'cheap';
  return 'premium';
}

async function refreshFree() {
  try {
    const r = await fetch(UPSTREAM_MODELS, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const all = (j.data || []).filter(m => m && m.id);
    const info = new Map(all.map(m => [m.id, m]));

    /* ---------- 1) 更新模型档案：状态变迁追踪 ---------- */
    const reg = loadRegistry();
    reg.updatedAt = new Date().toISOString();
    const seenNow = new Set();
    const changes = [];
    for (const m of all) {
      seenNow.add(m.id);
      const tier = tierOf(m);
      const prev = reg.models[m.id];
      const price = parseFloat(m.pricing?.prompt);
      const ctx = m.context_length || 0;
      if (!prev) {
        reg.models[m.id] = { tier, firstSeen: Date.now(), lastSeen: Date.now(), price, ctx };
        continue;
      }
      prev.lastSeen = Date.now();
      prev.ctx = ctx;
      prev.price = price;
      /* 状态变迁：free ↔ paid */
      if (prev.tier !== tier) {
        const from = prev.tier, to = tier;
        prev.tier = tier;
        prev.lastTransition = Date.now();
        /* 只有从 free 转收费才值得记一笔（用户关心的场景） */
        if (from === 'free' && to !== 'free') changes.push({ id: m.id, change: 'free->paid', newPrice: price, newTier: to });
        else if (from !== 'free' && to === 'free') changes.push({ id: m.id, change: 'paid->free' });
        else changes.push({ id: m.id, change: `${from}->${to}` });
      }
    }
    /* 下架检测：档案里有、但这次列表里没有的 → 记 missedRuns，达阈值标 delisted */
    for (const [id, rec] of Object.entries(reg.models)) {
      if (seenNow.has(id)) {
        rec.missedRuns = 0;
        if (rec.tier === 'delisted') {
          rec.tier = tierOf(info.get(id) || { id, pricing: {} });
          rec.lastTransition = Date.now();
          changes.push({ id, change: 'revived', backTo: rec.tier });
        }
        continue;
      }
      rec.missedRuns = (rec.missedRuns || 0) + 1;
      if (rec.missedRuns >= DELIST_THRESHOLD && rec.tier !== 'delisted') {
        rec.tier = 'delisted';
        rec.delistedAt = Date.now();
        rec.lastTransition = Date.now();
        changes.push({ id, change: 'delisted', missedRuns: rec.missedRuns });
      }
    }
    saveRegistry(reg);
    for (const c of changes) log({ t: new Date().toISOString(), modelRegistryChange: c });
    /* 清理档案：只保留近 90 天见过的，避免文件无限膨胀 */
    const cutoff90 = Date.now() - 90 * 86400e3;
    for (const [id, rec] of Object.entries(reg.models)) {
      if ((rec.lastSeen || 0) < cutoff90 && rec.tier === 'delisted') delete reg.models[id];
    }
    saveRegistry(reg);

    /* ---------- 2) 免费档候选（短请求用） ---------- */
    const usable = all.filter(m => tierOf(m) !== 'blocked' && tierOf(m) !== 'premium' && (m.context_length || 0) >= FREE_MIN_CTX);
    /* 打分：速度基准越低越好；国产小幅加权只作用于短请求档（中文日常任务友好）。
       长会话以英文代码/技术文档为主，不加国产加权，否则会选出慢模型。 */
    const scoreShort = m => {
      const sp = SPEED_BENCH[m.id] ?? 400000;            /* 未实测的排后 */
      const domestic = /inclusionai|qwen|stealth/.test(m.id) ? 15000 : 0;
      return sp + domestic;
    };
    usable.sort((a, b) => scoreShort(a) - scoreShort(b));
    const freeOnly = usable.filter(m => tierOf(m) === 'free');
    if (freeOnly.length) {
      if (freeOnly[0].id !== FREE_ACTIVE) {
        log({ t: new Date().toISOString(), freeModelSwitch: `${FREE_ACTIVE} -> ${freeOnly[0].id}`, freePoolSize: freeOnly.length });
        FREE_ACTIVE = freeOnly[0].id;
      }
      freePoolSnapshot = freeOnly.map(m => m.id).slice(0, 12);
    }
    /* 当前 FREE_ACTIVE 若已转收费/下架 → 立即让位（转收费的进 cheap 池见 longctx） */
    if (FREE_ACTIVE && !freeOnly.find(m => m.id === FREE_ACTIVE)) {
      const cur = info.get(FREE_ACTIVE);
      const ct = cur ? tierOf(cur) : 'delisted';
      log({ t: new Date().toISOString(), freeModelDropped: FREE_ACTIVE, reason: ct });
      FREE_ACTIVE = freeOnly[0]?.id || FREE_PREFS[0];
    }

    /* ---------- 3) 长上下文档候选（付费档，量大场景） ----------
       教训：只按 ctx 筛选会把旗舰模型选进来（gpt-6.1-sol-pro / claude-sonnet-5.5 都是 1M 但 $2/1M）。
       必须限价 + 排除旗舰名。长会话按纯速度排序。 */
    const longCands = all.filter(m => {
      const t = tierOf(m);
      if (t === 'blocked' || t === 'premium') return false;
      return (m.context_length || 0) >= 900000;
    });
    longCands.sort((a, b) => (SPEED_BENCH[a.id] ?? 400000) - (SPEED_BENCH[b.id] ?? 400000));
    let newLong = longCands.map(m => m.id);
    /* 安全网：过滤太严导致候选为空时，放宽到「窗口 ≥ 90 万 + 有实测速度」，宁可慢也不能没有。 */
    if (!newLong.length) {
      newLong = all.filter(m => tierOf(m) !== 'blocked' && (m.context_length || 0) >= 900000 && SPEED_BENCH[m.id])
        .sort((a, b) => SPEED_BENCH[a.id] - SPEED_BENCH[b.id]).map(m => m.id);
      if (newLong.length) log({ t: new Date().toISOString(), longctxRelaxed: true, relaxedTo: newLong.slice(0, 3) });
    }
    if (newLong.length && newLong[0] !== LONGCTX_ACTIVE) {
      log({ t: new Date().toISOString(), longctxSwitch: `${LONGCTX_ACTIVE} -> ${newLong[0]}`, longPoolSize: newLong.length });
      LONGCTX_ACTIVE = newLong[0];
      longCtxFallbacks = newLong.slice(0, 4);           /* 前 4 顺位做兜底链（跨免费/廉价两档） */
    }

    freeCheckedAt = Date.now();
  } catch (e) {
    log({ t: new Date().toISOString(), refreshPoolFailed: String(e.message || e) });
  }
}
setInterval(refreshFree, 6 * 3600e3);
refreshFree();

/* 估算 prompt token 数：CJK 字符 ≈ 1 token/字；其它（含 JSON 标点，token 密度高）≈ 1 token/3 字符 */
function estPromptTokens(body) {
  let all = '', cjk = 0;
  const walk = v => {
    if (typeof v === 'string') all += v;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  (body.messages || []).forEach(walk);
  if (body.tools) walk(body.tools);
  for (let i = 0; i < all.length; i++) if (all.charCodeAt(i) > 0x2e80) cjk++;
  return Math.round(cjk + (all.length - cjk) / 3);
}

/* ---- ★ 真实 token 校准（21:33 实测：est 公式对工具定义 JSON 虚高 8.5 倍，est 89万↔真实 10.5万）----
   每轮从 usage 记录 lastRealPrompt（真实值）+ 该轮 est；下轮判定用「上轮真实 + 增量×0.75」
   （增量系数 0.75 来自实测：Δest=1774 ↔ Δreal=1328，新增中文对话比基座 JSON 密度高） */
/* 校准样本池：[{est, real}]，取 est 最接近的样本比例换算（请求结构不同则比例不同，
   必须配对同量级样本；增量估算跨量级会完全失真——21:22 教训） */
const CALIB = [];
/* ★★★ 大请求必须当大请求（10-01 实测抓出，这是第三次栽在 est 校准上）：
   实测经过：est=56.7 万的大请求被判成小请求 → 没进长上下文分支 → 走 qwen → 74s（而非 nemotron 11.8s）。
   根因不是"跨量级借样本比例"，而是**用小样本的比例去套大请求必然低估**（小请求里工具定义 JSON 占比畸高，
   真实对话正文密度远高于此）。
   规则（大请求方向单一，必须保守）：
     1) 有同量级样本 → 用它。
     2) 无同量级样本 → **按「1:1 直接当真实值」处理**（real = est），宁可高估。
        高估的后果＝提前切长上下文模型＝快；低估的后果＝当短请求用 qwen＝74s 超时。方向不对称。
     3) 池为空 → 同样按 1:1，不再用 0.15 兜底（0.15 会让任何大请求判成小请求）。 */
const CALIB_DECADES = [1e4, 1e5, 1e6];
function calibBucket(est) {
  for (let i = 0; i < CALIB_DECADES.length; i++) if (est < CALIB_DECADES[i]) return i;
  return CALIB_DECADES.length - 1;
}
function realEstimate(estTok) {
  const bucket = calibBucket(estTok);
  const inBucket = CALIB.filter(s => calibBucket(s.est) === bucket);
  if (inBucket.length) {
    let best = inBucket[0];
    for (const s of inBucket) { if (Math.abs(s.est - estTok) < Math.abs(best.est - estTok)) best = s; }
    return Math.round(estTok * best.real / best.est);
  }
  return estTok;   /* ★ 无同量级样本 → 1:1 当真实值（保守：宁可高估走快模型） */
}
function noteRealPrompt(realTokens, estTok) {
  /* ★ 只收大样本：token 缩放非线性——小请求里 JSON 框架固定开销占比畸高（est=4↔real=22，
     比例 5.5），会把大会话判成天文数字（23:25 实测：960621×5.5=528万 → 误拒） */
  if (!(realTokens > 0 && estTok > 50000)) return;
  /* 按量级桶配对更新，避免同桶内被不同结构的小样本覆盖 */
  const bucket = calibBucket(estTok);
  const i = CALIB.findIndex(s => calibBucket(s.est) === bucket && Math.abs(s.est - estTok) < estTok * 0.3);
  if (i >= 0) CALIB[i] = { est: estTok, real: realTokens };
  else { CALIB.push({ est: estTok, real: realTokens }); if (CALIB.length > 12) CALIB.shift(); }
}

/* ---- ★★ 语义分类器 —— 现在是**唯一的路由裁决者**（2026-10-02 用户指令）----
   让 ling 专门干它擅长的事：读懂请求真实意图 → 输出一个标签（分类比实际操作简单得多，ling 够用且免费快）。
   正则词典降级为 hint，只影响分类器的判断参考，不直接决定路由。

   ★★★ 2026-10-02 17:35 实测修正（这条差点让整个改造白做，务必记住）：
   我原以为「加严 prompt + max_tokens:8」就够了。实测 8 条请求 **7 条失败**：
   ling-3.0-flash-vl 是**推理型模型**，收到「只输出一个标签」仍会先写「1. 分析用户请求…」，
   8 个 token 全被思考过程吃掉 → finish_reason=length → content 是散文 → 标签解析失败 → null。
   而 null 会**静默退回正则**，也就是说我以为「已经改成模型裁决」，实际绝大多数请求仍是正则说话，
   只是日志里看不见（probe 探针当时看起来准，是碰巧那几次模型直接吐了标签）。
   教训：**分类器输出不稳定时，「失败→兜底」会把改造效果完全掩盖，必须统计成功率而不是看单次结果。**

   修法（实测 10/10，中位 1.4s）：① 用 **assistant 预填**（末尾追加 `{role:'assistant',content:'标签：'}`）
   把模型直接置于「已答完」的续写位置，它没机会再展开思考；② max_tokens 8 → 64 留余量；
   ③ 解析改为「在输出里找第一个合法标签」而非整串严格相等（容忍前后废话）。

   ★★ 2026-10-02 17:50 加「分类模型轮换」——用户提问「书生端点没额度，能起作用？」引出的连锁改造：
   分类器**必须自给自足**，因为 (a) 它是整个路由的入口，它挂了下面所有分档都失去意义；
   (b) 讽刺之处：连「选模型的模型」自己都不可靠 —— 实测同一个 key 下：
       gpt-4o-mini / gemini-2.5-flash / gpt-4.1-mini 全部 **403 地区限制**、
       claude-3.5-haiku / nemotron-70b **404 下架**、mistral-small-3.1 **400**。
   所以不能只押一个模型，改成多模型轮换 + 单模型失败计数冷却。

   选型实测（15 条回归集，`tools/bench-classifier.mjs` 可复现）：
       meta-llama/llama-3.3-70b-instruct   解析100% 准确87% 中位1015ms  ← 主选（无地区限制+输出最稳）
       inclusionai/ling-3.0-flash-sante:free 解析 93% 准确87% 中位1211ms ← 备选（免费档）
       deepseek/deepseek-chat              解析100% 准确80% 中位1511ms  ← 次备选
   按此顺序试，连续失败 3 次的模型冷却 10 分钟。 */
const CLASSIFY_MODELS = [
  'meta-llama/llama-3.3-70b-instruct',
  'inclusionai/ling-3.0-flash-sante:free',
  'deepseek/deepseek-chat',
];
const CLASSIFY_KEYS = ['adb', 'math', 'paper', 'board', 'resume', 'jd', 'apply', 'envops', 'code', 'data', 'site', 'tool', 'agent', 'misc'];
/* 每个分类模型的独立健康度：连续失败 3 次 → 冷却 10 分钟（单个模型挂掉不影响整体分类） */
const clsModel = {};   /* { [model]: { fails, ok, fail, disabledUntil } } */
function clsModelStat(m) {
  if (!clsModel[m]) clsModel[m] = { fails: 0, ok: 0, fail: 0, disabledUntil: 0 };
  return clsModel[m];
}
const CLASSIFY_SYS =
  '你是任务分类器。根据用户请求判断属于哪一类，只输出一个英文标签，不要解释。\n' +
  '看用户真正想达成什么，按主要目标归类，混杂意图取主要那个。\n' +
  '标签集：adb(手机/模拟器点击滑动截图/控件树/包名) math(数学定理证明习题) paper(论文文献精读综述) ' +
  'board(看板工作台排期台账) resume(简历求职文书) jd(岗位JD分析) apply(投递话术跟进) ' +
  'envops(环境安装配置权限排查) code(代码调试算法刷题) data(数据清洗校对) site(网页部署上线) ' +
  'tool(写脚本小工具) agent(多步编排流水线) misc(纯翻译润色或无法归类)\n' +
  '注意：只是提到「翻译/润色」这个词不等于要翻译（例：「为什么这句被判成翻译润色」→ 按真实主题归类）；' +
  'misc 只用于真正的语言转换或实在归不进去的请求。';
/* 单个分类模型的一次调用；返回 {tag, raw} —— raw 是模型原始输出，
   ★ 2026-10-03：解析失败时也返回 raw，调用方据此写日志（原来解析失败就返回 null，
   「能调通但输出不可解析」这条路径完全不记日志 → 只能靠探针事后猜，日志里查不到原因）。 */
async function classifyOnce(model, text, hintLine) {
  const r = await fetch(UPSTREAM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'HTTP-Referer': 'https://localhost:8765', 'X-Title': 'AILens Classifier' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: CLASSIFY_SYS },
        { role: 'user', content: hintLine + '用户请求：' + String(text || '').slice(0, 1200) },
        { role: 'assistant', content: '标签：' }      /* ★ 预填：堵住推理展开，见上方实测记录 */
      ],
      max_tokens: 64, temperature: 0
    }),
    signal: AbortSignal.timeout(6000)
  });
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  const ch = (j && j.choices && j.choices[0]) || {};
  const raw = String((ch.message && ch.message.content) || '').toLowerCase();
  const reasoning = String((ch.message && ch.message.reasoning) || '');
  /* 宽松解析：找第一个出现的合法标签（容忍模型在标签前后带废话） */
  return { tag: CLASSIFY_KEYS.find(k => raw.includes(k)) || null, raw: raw.slice(0, 80), reasoning: reasoning.slice(0, 120), finish: ch.finish_reason || null };
}
/* 依次尝试各分类模型：单个失败换下一个，全失败返回 null（交由正则兜底） */
async function classifyLLM(text, hint, ua) {
  /* hint：正则扫到的候选，仅供参考 —— 模型可以无视（历史上正是它把请求带偏的） */
  const hintLine = (hint && hint.length) ? ('参考候选（可能不准，可无视）：' + hint.join(', ') + '\n') : '';
  const now = Date.now();
  for (const m of CLASSIFY_MODELS) {
    const st = clsModelStat(m);
    if (now < st.disabledUntil) continue;              /* 冷却中 → 跳过 */
    try {
      const out = await classifyOnce(m, text, hintLine);
      if (out.tag) { st.fails = 0; st.ok++; return out.tag; }
      st.fails++; st.fail++;                       /* 能调通但输出不可解析 → 也算不稳定 */
      /* ★★ 新增：这条路径原来什么都不记，只有计数 → 失败原因在日志里彻底不可见。
         现在把模型原始输出 + reasoning + finish_reason 落盘，才能判断是
         「思考吃掉预算」「模型加了前缀」「返回空」还是「返回了别的语言」。 */
      try { log({ t: new Date().toISOString(), classifyUnparsed: true, model: m, ua, finish: out.finish, raw: out.raw, reasoning: out.reasoning, text: String(text || '').slice(0, 60) }); } catch {}
    } catch (e) {
      st.fails++; st.fail++;
      if (e.status) { try { log({ t: new Date().toISOString(), classifyModelHTTP: e.status, model: m, ua }); } catch {} }
      /* 非 HTTP 异常（如 AbortSignal 超时）原来也不记 —— 超时恰恰是最常见的失败原因，必须留痕 */
      else { try { log({ t: new Date().toISOString(), classifyModelError: String(e.message || e), model: m, ua }); } catch {} }
    }
    if (st.fails >= 3) {
      st.disabledUntil = Date.now() + 10 * 60e3;    /* 连续失败 3 次 → 冷却 10 分钟 */
      try { log({ t: new Date().toISOString(), classifyModelCooldown: m, until: new Date(st.disabledUntil).toISOString(), ua }); } catch {}
    }
  }
  return null;
}
/* ★ 分类器健康度计数器（17:40 加）：「模型分类失败→静默退回正则」这件事从外面完全看不见，
   日志不记、界面不显，所以我曾以为改造已经生效。必须有可查询的成功率才能验证改造是否真的在起作用。
   分类是每个请求都走的环节，成功率一旦掉下来 = 整条路由悄悄退化成旧逻辑。 */
const clsStat = { ok: 0, fail: 0, lastFailAt: 0, lastOkAt: 0 };
function clsHealth() {
  const tot = clsStat.ok + clsStat.fail;
  return { ...clsStat, total: tot, rate: tot ? +(clsStat.ok / tot * 100).toFixed(1) : null };
}
/* ★ 无条件走模型分类（不再有「正则 confident 就跳过模型」的捷径 —— 那是误判的根源）
   ★★ 2026-10-03 加 ua 透传：分类失败/冷却日志原来只有 text，看不出是谁触发的。
      Hermes（短探针）与 WorkBuddy（长任务）混在一起，排查时无法定位是哪个客户端把分类器打挂的。 */
async function classifySmart(s, ua) {
  const first = classify(s);                       /* 正则：仅用于生成 hint + 兜底 */
  const k = await classifyLLM(s, first.key !== 'misc' ? first.hits : [], ua);
  if (k) {
    clsStat.ok++; clsStat.lastOkAt = Date.now();
    try { log({ t: new Date().toISOString(), classifyLLM: k, regexWas: first.key, ua, text: String(s || '').slice(0, 60) }); } catch {}
    return { key: k, hits: ['llm语义分类'], regexWas: first.key };
  }
  /* ↓ 走到这里说明模型分类彻底失败，本次实际由正则裁决 —— 必须留痕，否则等于改造没生效 */
  clsStat.fail++; clsStat.lastFailAt = Date.now();
  try { log({ t: new Date().toISOString(), classifyLLM_FAIL: true, regexFallback: first.key, ua, text: String(s || '').slice(0, 60) }); } catch {}
  return first;
}

function classify(s) {
  s = String(s || '');
  const scores = [];
  for (const k in RULES) {
    const m = s.match(new RegExp(RULES[k].source, 'gi'));
    if (m && m.length) {
      /* ★ 手机/设备操作强特征加权 ×3：避免消息里混一个「解释/什么意思」就被 misc 抢走 → 路由给 ling */
      const w = (k === 'adb') ? m.length * 3 : m.length;
      scores.push({ key: k, n: w, hits: m.filter((v, i, a) => a.indexOf(v) === i).slice(0, 4) });
    }
  }
  if (s.length > 30000 && !scores.some(x => x.key === 'adb')) scores.push({ key: 'adb', n: 1, hits: ['超长文本（疑似 dump）'] });
  if (!scores.length) return { key: 'misc', hits: [], confident: false };   /* 无命中 → 低置信，交给第二层 */
  scores.sort((a, b) => b.n - a.n);
  /* ★ 置信度：top 与第二名差距 < 2 → 判定模糊，需第二层语义分类。
     ★★ 2026-10-02 17:05 修正：只有 misc 命中且无其他类别时，即使分数再高也判定低置信
        —— misc 是兜底类别，命中可能只是关键词碰巧（典型如「路由判定为翻译/润色」本身），
        让 LLM 按内容定类，避免把通用请求锁死在 misc → cheap tier。 */
  const onlyMisc = scores.length === 1 && scores[0].key === 'misc';
  const second = scores[1];
  const confident = !onlyMisc && !(second && (scores[0].n - second.n) < 2);
  return { key: scores[0].key, hits: scores[0].hits, confident };
}
function lastUserText(body) {
  const ms = body.messages || [];
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.map(p => (p && p.text) ? p.text : '').join(' ');
    }
  }
  return '';
}
function log(o) {
  try {
    fs.appendFileSync(LOGF, JSON.stringify(o) + '\n');
    if (fs.existsSync(LOGF) && fs.statSync(LOGF).size > 3e6) {
      const ls = fs.readFileSync(LOGF, 'utf8').trim().split('\n').slice(-800);
      fs.writeFileSync(LOGF, ls.join('\n') + '\n');
    }
  } catch {}
}
function appsRunning() {
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 8000, windowsHide: true }).toLowerCase();
    return APPS.some(a => out.includes('"' + a.toLowerCase() + '"'));
  } catch { return null; } /* 探测失败 → 视为未知，不做动作 */
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok');
  }
  /* ★ 分类器健康度（17:42 加）：/health 是纯文本 ok、外部探针在依赖它，不能改格式，所以另开 JSON 端点。
     用途：验证「路由真的改由模型裁决了」。如果 rate 掉下来甚至 total=0，
     说明请求全在走正则兜底 —— 那就是改造没生效，别被界面上的正常表现骗了。
     用法：curl http://127.0.0.1:9999/classify-health */
  if (req.method === 'GET' && req.url.split('?')[0] === '/classify-health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      classifier: clsHealth(),
      /* ★ 每个分类模型单独的成功/失败/冷却状态 —— 单个模型挂掉（如 403 地区限制 / 下架）
         不该让整体分类静默退化，这条能让你立刻看出「现在是谁在服务分类」 */
      classifierModels: CLASSIFY_MODELS.map(m => ({
        model: m, ...clsModelStat(m),
        cooling: clsModelStat(m).disabledUntil > Date.now(),
        disabledUntil: clsModelStat(m).disabledUntil ? new Date(clsModelStat(m).disabledUntil).toISOString() : null
      })),
      lastServedModel, lastServedCtx,
      freeActive: typeof FREE_ACTIVE !== 'undefined' ? FREE_ACTIVE : null,
      longctxActive: typeof LONGCTX_ACTIVE !== 'undefined' ? LONGCTX_ACTIVE : null
    }));
  }
  /* ★ 压缩信号查询端点：外部工具轮询此接口，检查最近一轮对话是否触发 _compress */
  /* ★ 手动刷新路由池（2026-10-01，用户要求）：不等 6h 定时器，随时强制重拉+ 重建池。
     用法：curl -X POST http://127.0.0.1:9999/route-pool/refresh
     返回刷新后的 free/longctx 首选与候选，便于确认「换模型了没」。 */
  if (req.method === 'POST' && req.url.endsWith('/route-pool/refresh')) {
    const t0 = Date.now();
    try {
      await refreshFree();
      const reg = loadRegistry();
      const byTier = { free: 0, cheap: 0, premium: 0, delisted: 0, blocked: 0 };
      for (const rec of Object.values(reg.models || {})) if (byTier[rec.tier] != null) byTier[rec.tier]++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true, elapsedMs: Date.now() - t0,
        refreshedAt: freeCheckedAt ? new Date(freeCheckedAt).toISOString() : null,
        free: { active: FREE_ACTIVE, pool: freePoolSnapshot },
        longctx: { active: LONGCTX_ACTIVE, pool: longCtxFallbacks, minTokens: LONGCTX_MIN_TOKENS },
        registry: { byTier },
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
    }
  }

  /* ★ 动态路由池观测端点（2026-10-01）：查看实时候选名单 + 排序依据 + 健康状态
     用法：curl http://127.0.0.1:9999/route-pool */
  if (req.method === 'GET' && req.url.endsWith('/route-pool')) {
    const health = {};
    for (const [m, h] of MODEL_HEALTH) health[m] = { fails: h.fails, cooling: h.fails >= HEALTH_MAX_FAILS && Date.now() - h.lastFail < HEALTH_COOLDOWN };
    const reg = loadRegistry();
    /* 档案统计：各档位数量 + 转收费/下架历史 */
    const byTier = { free: 0, cheap: 0, premium: 0, delisted: 0, blocked: 0 };
    for (const rec of Object.values(reg.models || {})) if (byTier[rec.tier] != null) byTier[rec.tier]++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      refreshedAt: freeCheckedAt ? new Date(freeCheckedAt).toISOString() : null,
      free: { active: FREE_ACTIVE, pool: freePoolSnapshot },
      longctx: { active: LONGCTX_ACTIVE, pool: longCtxFallbacks, minTokens: LONGCTX_MIN_TOKENS },
      registry: { updatedAt: reg.updatedAt, byTier },
      health,
    }));
  }
  /* ★ 模型档案详情：某个模型的状态变迁史（firstSeen / 转收费时间 / 下架记录） */
  if (req.method === 'GET' && req.url.includes('/model-registry')) {
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    const reg = loadRegistry();
    if (id) {
      const rec = reg.models?.[id];
      if (!rec) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'not found' })); }
      return res.end(JSON.stringify({ ok: true, id, ...rec }));
    }
    /* 不带 id → 返回所有 delisted（已清除出池）和近期转收费的条目 */
    const out = Object.entries(reg.models || {})
      .filter(([, r]) => r.tier === 'delisted' || (r.lastTransition && Date.now() - r.lastTransition < 30 * 86400e3))
      .map(([id, r]) => ({ id, tier: r.tier, price: r.price, ctx: r.ctx, lastTransition: r.lastTransition }))
      .sort((a, b) => (b.lastTransition || 0) - (a.lastTransition || 0));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, changed: out }));
  }
  if (req.method === 'GET' && req.url.endsWith('/compress-status')) {
    const data = Object.values(lastUsageRecord).slice(-5).reverse();   /* 最近 5 条 usage + ratio */
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ timestamp: new Date().toISOString(), signals: data.filter(s => s.ratio) }));
  }
  /* ★ 2026-10-04：原来是 req.url.endsWith('/models') —— 通配到了 /api/v1/models。
     而 Hermes 判定「本地端点类型」的瀑布第一腿正是 GET /api/v1/models
     （hermes-agent/agent/model_metadata.py → detect_local_server_type），
     且它的判据是 lambda r: True —— 「只要 200 就算」。
     → 9999 被误判成 lm-studio → Hermes 改用 LM Studio 原生解析读 response.json().get("models")，
       而本网关返回的顶层键是 "data" → 读到空表 → AILens 分组在 Hermes 里变空/错标。
     实测依据：/api/v1/models 共 474 次调用，471 次 UA=python-httpx（Hermes 自己的探测），
     其余 3 次是 curl（我手动验的）→ 无任何真实客户端依赖它，可安全收紧。
     ★ 保留 /models（node 面板在用，4972 次）与 /v1/models（Agent/1.0、hermes-cli、httpx）。 */
  const _modelsPath = (() => { try { return new URL(req.url, 'http://x').pathname; } catch { return String(req.url).split('?')[0]; } })();
  if (req.method === 'GET' && (_modelsPath === '/models' || _modelsPath === '/v1/models')) { /* 只回网关可用的精简列表（避免客户端拉到 OpenRouter 全量目录） */
    try { fs.appendFileSync(LOGF, JSON.stringify({ t: new Date().toISOString(), modelsFetch: req.url, ua: (req.headers['user-agent'] || '').slice(0, 80) }) + '\n'); } catch {}
    const list = [
      /* ★ 2026-10-03 方案 B（用户拍板）：auto 条目的 name 动态显示「最近实际路由的模型」。
         起因：WorkBuddy 模型选择器显示的是 models.json 里的 name，那是手写死的静态字面量——
         实际路由到 Atria-Dawn-Preview 时仍显示「· Qwen3.7 Flash」，属误导性信息。
         这里只改**显示**，绝不碰 id：id 上线后一个字符都不许动（见 MEMORY 铁律 12），
         name 不参与请求反查，可安全动态变化。
         ⚠ 只在「这轮是 WorkBuddy 自己发的」时才显示真实模型：本网关被 WorkBuddy/Cherry/Hermes 共用，
         别人的流量会把名字带走（servedBy 机制存在的同一理由）。 */
      { id: 'auto', name: (/workbuddy/i.test(lastServedUa || '') && lastServedModel)
          ? `AILens网关（${prettyName(lastServedModel)}）`
          : 'AILens网关（自动路由）', owned_by: 'ailens-gateway' },
      /* ★★ 2026-10-01 用户拍板方案 B：OpenRouter 段改为**跟随路由池实时状态**，不再硬编码。
         起因：硬编码名单（5 个）与 auto 实际用的 free 池（8+ 个）严重脱节——
         `nvidia/nemotron-3-ultra-550b-a55b:free` 是 free 池第一顺位（实测 45 万 tok 冷启动 3.4s）
         却不在名单里，客户端手动选模型时根本看不到它。用户原话：
         「一直做的都是自动路由，谁需要用这破逼表选模型」→ 列表存在的意义就是反映网关真实可用的模型。
         数据来源：
           - freePoolSnapshot：每 6h 动态探测的免费池（已在 /route-pool 暴露），按速度基准排序
           - longCtxFallbacks：长上下文兜底链前 4 顺位
           - CHAIN：常备付费兜底（含 ENTRY.strong 的强档 nex-n2.5-pro —— 数学/论文/简历/board 走它）
           - RESERVE_MODELS：动态池覆盖不到的储备 —— 免费/廉价/中档/强档完整矩阵（见定义处注释）
         去重后输出，name 缺省用 id（价格/窗口仍走 prices / INTERN_CTX 缓存）。*/
      ...[...new Set([...freePoolSnapshot, ...longCtxFallbacks, ...CHAIN, ...RESERVE_MODELS])]
        .filter(id => id && !INTERN_MODELS.has(String(id)) && !FREE_BLOCKLIST.has(String(id)))
        .map(id => ({ id, name: prettyName(id), owned_by: 'openrouter' })),
      /* ★ 书生科研端砚（上海 AI 实验室聚合平台）—— 实测真实模型列表（2026-09-30），全部免费墨点计费 */
      { id: 'intern-s2', name: '书生-S2（科学深度思考·不扣墨点）', owned_by: 'intern-ai' },
      { id: 'Atria-Dawn-Preview', name: 'Atria-Dawn-Preview（书生·限时不扣墨点）', owned_by: 'intern-ai' },
      { id: 'Agents-A1', name: 'Agents-A1（书生·限时不扣墨点）', owned_by: 'intern-ai' },
      { id: 'deepseek-v4-flash-0731', name: 'DeepSeek-V4-Flash（书生·扣墨点）', owned_by: 'intern-ai' },
      /* ⚠ deepseek-v4-flash-vision 已从可选列表移除（2026-10-02 实测 HTTP 429 quota exceeded）。
         留着的话 Cherry 手动选它 → 白等一轮才报错。恢复条件：该模型 429 消失后重新加回。 */
      { id: 'deepseek-v4-pro-0813', name: 'DeepSeek-V4-Pro', owned_by: 'intern-ai' },
      /* ★★ 2026-10-04 撤下：glm-5.3（书生免费）。
         ★ 它是【书生模型】不是本地桥模型：LOCAL_MODELS（转 8787）是大小写敏感的
           {'GLM-5.3','GLM-5.3-Flash','GLM-5.2','GLM-5-Turbo'}，小写 glm-5.3 不在其中；
           而 INTERN_MODELS 含 'glm-5.3' → 按名直请求走书生，路由正确。
         ★ 撤下原因：与本地 zbridge(8787) 的 GLM-5.3 是【不同模型、同一个名字】，
           而 Hermes d.5 判重是「大小写不敏感精确匹配」（mid.lower() == target）→
           ailens 与 zbridge 同时声明它 → 硬失败
           "'glm-5.3' is declared by multiple configured providers (ailens, zbridge)"；
           且选择器里 ailens / zbridge 两组会各出现一个看着同名的 GLM（串组）。
         ★ 路由不受影响：按名直接请求 glm-5.3 仍走书生（INTERN_MODELS 未动），这里只是不再广告。
         ⚠ 副作用：连 9999 的其它客户端模型选择器里不再出现这一条。 */
      { id: 'kimi-k2.6', name: 'Kimi-K2.6（书生免费）', owned_by: 'intern-ai' },
      { id: 'minimax-m3', name: 'MiniMax-M3（书生免费）', owned_by: 'intern-ai' },
      { id: 'qwen3.8-27b', name: 'Qwen3.8-27B（书生免费）', owned_by: 'intern-ai' }
      /* ★★ 2026-10-04 撤下：这里原本（10-03 起）列过本地 zbridge(8787) 的 4 个 GLM ——
         GLM-5.3-Flash / GLM-5.3 / GLM-5.2 / GLM-5-Turbo（owned_by: 'zcode-bridge'）。
         撤下原因（用户 10-04 拍板原话「不要再串了」）：
           Hermes 已给 8787 单列了具名 providers.zbridge；只要 9999 还广告这些同名裸名，
           同一个 GLM 就会同时挂在 AILens 与 zbridge 两个分组下（串组）；
           且与 zbridge 的声明撞名会触发 Hermes d.5 硬失败
           （"'GLM-5.3-Flash' is declared by multiple configured providers"）。
         ★ 路由完全不受影响：LOCAL_MODELS 照常把 GLM 转发到 8787、失败退 OpenRouter，
           这里只是不再「在 /v1/models 里广告」。要经 9999 用 GLM 仍可直接按名请求。
         ⚠ 副作用：连 9999 的其它客户端（WorkBuddy/Cherry）模型选择器里不再出现这 4 条。 */
    ]
      /* ★ max_context_length = 各模型对应真实值：auto 跟随最近实际路由的模型，OR 模型取缓存，书生系取官方文档值 */
      .map(m => {
        const ctx = modelCtx(m);
        return { object: 'model', ...m, context_length: ctx, context_window: ctx, max_model_len: ctx, max_context_length: ctx };
      });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: list }));
  }
  /* ★ /v1/model-context/:modelId —— 返回单个模型的真实上下文长度
   * 供前端动态更新 models.json 的 maxInputTokens，解决「写死值不随路由变」问题。
   * modelId 支持 auto（取最近实际路由的模型）、具体模型 id、custom-local:* 前缀。 */
  if (req.method === 'GET' && new URL(req.url, 'http://x').pathname === '/v1/model-context') {
    const u = new URL(req.url, 'http://x');
    const modelId = u.searchParams.get('model');
    if (!modelId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"missing model parameter"}}');
    }
    let targetId = modelId.replace(/^custom-local-/, '').replace(/^custom-local:/, '');
    /* auto / ailens-auto / 三档 id → 取最近实际路由的模型，与 POST 入口归一化口径一致。
       ★ 2026-10-02 修正：原来只查 lastUsageRecord（仅在压缩信号触发时写），
       平时是空对象 → 永远回落成字面量 'auto'，外部拿不到真实模型名。
       现在改为 lastUsageRecord 优先、lastServedModel 兜底（noteServed 每轮都写）。*/
    let realId = null;
    if (targetId === 'auto' || targetId === 'ailens-auto' || targetId.startsWith('ailens-auto·') || targetId.startsWith('ailens-auto@') || TIER_IDS.has(targetId)) {
      const rec = Object.values(lastUsageRecord).sort((a,b)=> (b.t||'').localeCompare(a.t||''))[0];
      realId = rec?.model || lastServedModel || null;
      targetId = realId || 'auto';
    }
    const ctx = modelCtx({ id: targetId });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    /* servedAt 让调用方判断新鲜度（例如「对话结束后把 name 还原成基础名」）。
       servedByWorkBuddy ★ 20:05 新增：告诉调用方这轮是哪个客户端发的。
       本机 WorkBuddy / Cherry / Hermes 共用本网关，外部同步器若不区分，
       会被其他客户端的流量带着反复改 models.json 的 id → 触发 WorkBuddy 热重载。*/
    return res.end(JSON.stringify({ ok: true, model: targetId, context_length: ctx,
      servedAt: lastServedAt || null,       servedBy: lastServedUa || null,
      /* ★ 注意正则拼写：WorkBuddy 中间是「buddy」，写成 workbudbuddy（多一个 d）永远匹配不上，
         表现为「明明是 WorkBuddy 的流量，servedByWorkBuddy 却恒为 false」→ 界面模型名永不更新。
         20:22 实测踩到：servedBy='WorkBuddy/5.6.2' 但判定 false。 */
      servedByWorkBuddy: /workbuddy/i.test(lastServedUa) }));
  }
  if (req.method !== 'POST') { res.writeHead(404); return res.end('{"error":{"message":"gateway: not found"}}'); }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = null;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
  if (!body || !Array.isArray(body.messages)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end('{"error":{"message":"gateway: invalid request body"}}');
  }

  let model = body.model || 'auto';

  /* ★ 别名归一化（2026-10-02）：WorkBuddy 会把自定义 id 前缀成 custom-local:xxx 发过来，
     且它的内置三档（fast-model/balanced-model/deep-model）也可能被送来。
     这些都不是上游真实模型名，直接透传会被 OpenRouter 拒（400 model not found）。
     统一归一化回 'auto'，走网关自己的任务分类路由。
     —— 改名 ailens-auto 的动因：models.json 里 id='auto' 会触发 WorkBuddy 的
        replaceAutoWithTierModels()，把内置三档用你的自定义端点配置覆盖，
        导致「快速/均衡/极致」三个服务端黑盒档位被劫持到本网关（网关不认它们）。 */
  {
    const raw = String(model);
    const norm = raw.replace(/^custom-local:/, '')
                     .replace(/^custom-local-(.+)$/, '$1')
                     .trim();
    if (norm === 'ailens-auto' || norm === 'auto' || norm.startsWith('ailens-auto·') || norm.startsWith('ailens-auto@')) {
      /* ★ 前缀匹配（2026-10-02 16:56）：外部同步脚本会把真实模型名挂在 id 后面
         （ailens-auto·Ling-3.0-Flash-Vl），这样 WorkBuddy 的会话指示器能显示实际模型。
         id 不再是固定值，所以不能只做全等匹配。 */
      model = 'auto';
    } else if (TIER_IDS.has(norm)) {
      /* 三档在本网关没有对应语义（原本是 WorkBuddy 服务端黑盒路由），
         归一化到 auto，由网关按任务分类分派 —— 比三个空壳档位更有意义。 */
      model = 'auto';
      log({ t: new Date().toISOString(), aliasTier: raw, normalized: 'auto', why: 'tier id 归一化' });
    }
  }
  body.model = model;

  const estTok = estPromptTokens(body);   /* 提升到顶层：usage 校准（noteRealPrompt）也要用 */
  let routed = null;

  if (model === 'auto') {
    const r = await classifySmart(lastUserText(body), (req.headers['user-agent'] || '').slice(0, 80));   /* ★ 语义分类定类（模型裁决）；正则仅作 hint/兜底。ua 透传：分类失败要能定位是谁触发的 */
    const tier = TASK_ENTRY[r.key] || 'cheap';
    /* ---- 多分支路由：按上下文体积 + 任务类型分级 ----
       tiny/normal：按任务分档（cheap→免费档 / strong→nex / misc→ling-VL 保视觉）
       long（真实>20万 tok）：切 1M 窗口免费模型
       huge（真实>95万 tok）：超过现有可用模型窗口 → 直接明确报错，不干等超时
       ★★ vision（本轮消息里带图）：**优先于以上所有分支**，见下方 VISION 段 */
    const realTok = realEstimate(estTok);   /* ★ 真实口径：est 公式对工具定义 JSON 虚高 8.5 倍，判定全部用校准值 */
    const hasImg = hasImageContent(body);   /* ★ 2026-10-02 21:40：本轮是否带图（只看最后一条 user 消息） */
    let primary, why;
    if (realTok > 950000) {   /* ★ 真实口径 1M×0.95；原 est 90万线把真实 10.5 万的会话误杀（est 虚高 8.5 倍） */
      why = 'over-window';
    } else if (hasImg) {
      /* ★★★ 带图请求 → 强制视觉档（2026-10-02 21:40 新增）
         为什么必须放在所有分支之前：原来「保视觉」只是 misc 分类的**副作用** —— 措辞不同、
         分类器判成 envops/agent/data，就会走到书生的 Atria-Dawn-Preview（in=['text'] 纯文本），
         图片被静默丢弃且不报错（用户表现为「模型看不见图」）。
         视觉是**硬约束**（不满足就是错的），不是「锦上添花的偏好」，所以必须在路由层强制，
         不能指望分类器恰好判成 misc。
         代价：绕过了书生的免费额度（视觉模型在 OpenRouter，$0~0.03/M）。
         取舍理由：看不见图的请求 100% 无价值，省这点钱没有意义。 */
      primary = visionEntry(realTok);
      why = 'vision-forced';
      log({ t: new Date().toISOString(), visionForced: true, model: primary, taskClass: r.key,
             realTok, why_pick: realTok > LONGCTX_MIN_TOKENS ? '长上下文→1M视觉模型' : '短请求→最便宜视觉模型' });
    } else if (realTok > LONGCTX_MIN_TOKENS) {
      /* ★ 长上下文：优先书生 deepseek-v4-pro-0813（16:35 实测 83.3万 tok 冷启动 17.4s，全场最快）。
         ★★ 2026-10-08 修：该模型现已 **HTTP 429 quota exceeded**（历史 128 次兜底失败里 126 次是 429），
            而旧代码无条件选它 → 每个长上下文请求都白等一轮失败再兜底。
            加健康度前置检查：不健康就直接走 1M 免费池，别再试死的。 */
      if (BOOK_KEY && !isInternQuotaExhausted() && isHealthy('deepseek-v4-pro-0813')) {
        primary = 'deepseek-v4-pro-0813'; why = 'longctx-pro';
      } else {
        primary = LONGCTX_ACTIVE; why = 'longctx-1M';
      }
    } else if (r.key === 'misc') {
      /* 纯语言转换（翻译/润色）→ 便宜快的 ling-vl（$0.021/M、262K 窗）。
         ★ 2026-10-08：原挂在「书生优先」块下，但它本来就是 OpenRouter 模型，挪出来避免误导（misc 不扣墨点）。 */
      primary = 'inclusionai/ling-3.0-flash-vl'; why = 'misc-vl';
    } else if (tier === 'cheap') {
      /* ★★ 2026-10-08 换档（A）：普通任务（envops/agent/code/board/tool/site/data）**不再走书生 Atria-Dawn-Preview**。
         依据（616 次真实流量实测 + 直连探针）：
           Atria 是强制深度推理型，`thinking_mode` 开关**实测无效**（false 80.2s/826tok vs true 88.2s/910tok）；
           中位 ~30s、p90 ~100s、**6.0% 撞满 150s 超时且超时后正文零产出**（日志无 usage）。
           OpenRouter 免费池对照：ling-vl 中位 7.2s/p90 18.5s/超时 0、qwen3.7-flash 中位 13.1s/超时 2 ——
           **同样 $0 成本，全面更快更稳**。
         代价：失去「书生端点」这层；但免费池有 6h 动态探测 + 健康度冷却兜底，且失败会走下方端点兜底链。
         （旧的「书生优先」分支已删：其中 THINK_ON→intern-s2 是死代码 —— STRONG_OR 与 THINK_ON 同为
           math/paper，进这个分支的请求必然 false。） */
      primary = FREE_ACTIVE; why = 'free-tier';
    } else {
      /* ★ 强档（math/paper 走这里）与 adb：长上下文 → 长上下文池，短请求 → 强档模型。
         math/paper 走的是 deepseek/deepseek-chat（18:50 实测 37s 出正文，nex-n2.5-pro 会 90s 超时）。 */
      primary = (r.key === 'adb' ? adbEntry(realTok) : null) || ENTRY[tier] || ENTRY.strongAlt;
      why = tier + '-dyn';
    }
    routed = { key: r.key, hits: r.hits, why, estTok };
    if (!primary) {
      /* 超窗：给客户端明确错误，别让它干等超时 */
      const msg = '对话上下文约 ' + Math.round(estTok / 10000) + ' 万 tokens，已超过可用模型的最大窗口（约 100 万）。请开新对话或压缩上下文后重试。';
      if (body.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.end('data: ' + JSON.stringify({ error: { message: msg, code: 400 } }) + '\n\ndata: [DONE]\n\n');
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: msg, code: 400 } }));
      }
      log({ t: new Date().toISOString(), routed, rejected: 'over-window', estTok });
      return;
    }
    body.model = primary;
    /* ★ 手动模式（mode=manual）：按 manual.tasks 逐任务覆盖模型/端点/思考，立即生效无需重启 */
    {
      let mc = null;
      try {
        const mf = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (mf.mode === 'manual' && mf.routing?.manual?.tasks?.[r.key]) mc = mf.routing.manual.tasks[r.key];
      } catch {}
      if (mc && mc.model) {
        primary = mc.model;
        body.model = primary;   /* ★ 修复（16:20）：原实现只改 primary/model 变量，body.model 仍是自动路由值 → 上游按 body.model 选端点，manual 覆盖从未真正生效 */
        why = (why || 'auto') + '+manual';
        if (mc.thinking === true || mc.thinking === 'true') body.thinking_mode = true;
        else if (mc.thinking === false || mc.thinking === 'false') body.thinking_mode = false;
        log({ t: new Date().toISOString(), manual: true, endpoint: mc.endpoint, model: primary, reason: 'manual route override' });
      }
    }
    /* 兜底链只给 OpenRouter 用（书生不认 models 数组字段） */
    if (INTERN_MODELS.has(String(primary))) {
      delete body.models;
    } else if (hasImg) {
      /* ★★ 2026-10-02 21:40：带图请求的兜底链**必须全是视觉模型**。
         原来的通用兜底链（LONGCTX_ACTIVE / FREE_ACTIVE / CHAIN）里混着纯文本模型
         （nemotron-3-ultra:free 实测 in=['text']、deepseek-v4-pro 无视觉能力），
         一旦 primary 失败退到它们，图就又丢了 —— 而且是「重试后才丢」，
         表现为「有时能看图有时不能」，比稳定失败更难排查。
         → 带图时兜底链改用 VISION_MODELS，视觉约束贯穿整条链。 */
      const vchain = VISION_MODELS.filter(m => m !== primary && !VISION_BLOCKLIST.has(m) && isHealthy(m));
      body.models = [primary, ...vchain].slice(0, 3);
    } else {
      body.models = [primary, ...[LONGCTX_ACTIVE, FREE_ACTIVE, ...longCtxFallbacks, ...CHAIN].filter(x => x && x !== primary)].slice(0, 3);
    }
    model = primary;
    /* ★ 模型健康检查：状态不佳的模型跳过，直接切兜底链。
       ★ 跳过目标按上下文体积分流：长上下文（>20万 est）优先动态长上下文池（1M 窗），
         短请求才优先便宜的免费档；两者都来自 refreshFree 的实时排序，不再硬编码。 */
    if (!isHealthy(primary)) {
      const pool = hasImg
        /* 带图：只在视觉模型里挑（跳到纯文本模型 = 图丢，等于没修） */
        ? VISION_MODELS.filter(c => c !== primary && !VISION_BLOCKLIST.has(c))
        : (realEstimate(estTok) > LONGCTX_MIN_TOKENS
        ? [LONGCTX_ACTIVE, ...longCtxFallbacks, ...CHAIN]
        : [FREE_ACTIVE, ...CHAIN, LONGCTX_ACTIVE]);   /* ★ 真实口径分流（23:28 教训：未校准时真实 10.8 万的请求被误判长上下文） */
      const candidates = pool.filter(c => c && c !== primary && isHealthy(c));
      const skipTo = candidates[0] || (hasImg ? visionEntry(realEstimate(estTok)) : LONGCTX_ACTIVE);
      log({ t: new Date().toISOString(), skip: 'unhealthy-model', model: primary, skipTo, fails: MODEL_HEALTH.get(primary)?.fails, skipMsg: '已跳过（连续失败' + (MODEL_HEALTH.get(primary)?.fails || 0) + '次，切' + skipTo + '）' });
      primary = skipTo;
      body.model = primary;
      model = primary;   /* 同步更新 model 变量，日志里 model 字段才显示真实服务的模型 */
      why = (why || 'auto') + '-skip-sick';
    }

    /* reasoning.effort 控制（OpenRouter 统一接口）——仅 OpenRouter 请求；书生用 thinking_mode（后面单独处理）
       ★ 18:50 与 THINK_ON 对齐：board/resume/jd/apply 既然已降为 cheap 档（结构化任务，不需要长推导），
         就不该再烧 medium 思考预算。原表让这 4 类低需求任务白开 thinking。 */
    const REASONING_EFFORT = {
      math: 'high', paper: 'high',
      board: 'low', resume: 'low', jd: 'low', apply: 'low',
      code: 'low', data: 'low', tool: 'low', envops: 'low', site: 'low',
      adb: 'low', agent: 'low', misc: 'none'
    };
    const tk = (routed && routed.key) || classify(lastUserText(body)).key;
    const effort = REASONING_EFFORT[tk] || 'none';
    if (!INTERN_MODELS.has(String(primary)) && effort !== 'none' && body.reasoning === undefined) {
      body.reasoning = { effort };
    }
  }
  /* model 非 auto → 原样透传（手动指定优先） */

  /* ---- 上行请求：intern 开头模型直走书生（额度用完自动切 OpenRouter）；其余先试 OpenRouter，5xx/网络失败且有书生 Key → fallback ---- */
  const t0 = Date.now();
  const ac = new AbortController();   /* 客户端断开 → 中止上游，省 token */
  let isInternModel = INTERN_MODELS.has(String(body.model || ''));
  /* ★ 2026-10-03：本地 zcode-bridge 端点。GLM 系列直走 8787，失败退 OpenRouter。
     单独一个 flag（而不是塞进 INTERN_MODELS）—— 那是个 Set，只决定「书生 vs OpenRouter」二选一，
     塞进去会让 GLM 走错上游。 */
  const isLocalModel = LOCAL_MODELS.has(String(body.model || ''));
  let upstreamLabel = isLocalModel ? 'zcode-bridge' : isInternModel ? 'intern-ai' : 'openrouter';
  let degradedFrom = null;   /* 记录「用户点的模型 → 实际服务的模型」，用于回响应头如实告知 */

  /* 书生额度检查：如果模型是 intern 开头但额度用完 → 强制切 OpenRouter */
  if (isInternModel && BOOK_KEY && isInternQuotaExhausted()) {
    log({ t: new Date().toISOString(), quotaExhausted: true, used5h: quota.used5h.toFixed(2), used7d: quota.used7d.toFixed(2), fallback: 'intern→openrouter', reason: 'quota exhausted (5h=' + quota.used5h.toFixed(2) + '/' + QUINTA_5H_LIMIT + ', 7d=' + quota.used7d.toFixed(2) + '/' + QUINTA_7D_LIMIT + ')', model: body.model });
    isInternModel = false;
    upstreamLabel = 'openrouter';
  }

  /* 思考模式自动选择（书生 thinking_mode）：科学/求职开深度思考，杂活关闭省 token */
  if (isInternModel && body.thinking_mode === undefined) {
    const tk = (routed && routed.key) || classify(lastUserText(body)).key;
    body.thinking_mode = THINK_ON.has(tk);
  }

  if (body.stream === true && !body.stream_options && !isInternModel) body.stream_options = { include_usage: true };   /* OpenRouter 特有：让流里最后一块带 usage（书生不认这字段） */
  const streamBody = JSON.stringify(body);

  async function doFetch(upstream, key, label) {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
      'HTTP-Referer': 'https://localhost:8765',
      'X-Title': 'AILens Gateway' + (label !== 'openrouter' ? ' [' + label + ']' : '')
    };
    /* ★ 2026-10-03：三个上游各自的 chat/completions 端点。
       本地 zcode-bridge 不校验 key，但仍发一个占位值（有些服务端会因缺 Authorization 报 401）。
       ⚠ 本地端点超时给到 300s：实测 zcode-bridge 单请求要 16-25 秒（冷启动更久），
         150s 在并发排队时不够 → 会误判失败并静默退到 OpenRouter，
         表现为「我选了 GLM-5.3-Flash，实际服务的是 ling-vl」（用户明确指定的模型被换掉）。
         流式请求尤其要注意：首字节慢不代表整体失败。 */
    const url = label === 'openrouter' ? UPSTREAM
      : label === 'intern-ai' ? INTERN_BASE + '/chat/completions'
      : LOCAL_BASE + '/chat/completions';
    /* ★★ 2026-10-08（B）：书生端点单独用更短预算。
       依据：Atria 实测简单问题就要 47-88s 且尾部会无限思考；150s 预算 = 撞上失控时要干等 150 秒才放弃。
       压到 90s → 最坏等待从 150s 降到 90s，超时后由端点兜底链接管（切 OpenRouter，通常几秒出结果）。
       OpenRouter / 本地端点维持原预算（耗时分布正常，不需要提前放弃）。 */
    const budget = label === 'zcode-bridge' ? 300000 : label === 'intern-ai' ? 90000 : 150000;
    return await fetch(url, {
      method: 'POST', headers, body: streamBody,
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(budget)])
    });
  }
  /* ★★ 2026-10-07 新增：探测上游是否把「错误」包在 HTTP 200 里返回。
     实测形态（OpenRouter 的 models 兜底数组把候选试完全失败时）：
       - stream  ：HTTP 200 + SSE 块里 "choices":[] + "error":{"code":503,"message":"Upstream error from Nvidia..."}（737ms 实测复现）
       - 非 stream：HTTP 200 + body 顶层 {"id":"gen-...","error":{"message":...,"code":503,...}}
     为什么必须探测：原有兜底条件是 upRes.status >= 400，200 时永不触发 →
     错误体被当「成功」透传，客户端显示 429/503 且重试一直报，日志里却全是 200（10-07 用户投诉）。
     返回 { res, err }：res 始终是「可继续正常消费」的响应对象（已读的字节会接回）。
     ★ 绝不能直接把 body 读掉：下游还要 for-await 它 —— 读掉 = 正常回复变空。 */
  async function peekErrorEnvelope(resp, isStream) {
    if (!resp || !resp.ok || !resp.body || typeof resp.body[Symbol.asyncIterator] !== 'function') return { res: resp, err: null };
    const it = resp.body[Symbol.asyncIterator]();
    const pre = [];                    /* 已缓冲的 chunk —— 判定为正常时要原样还给下游 */
    let acc = '';
    let err = null;
    try {
      if (isStream) {
        /* ★ 只在「完整的 data: 行」上下判断 —— 半行 JSON.parse 必然失败，
           拿半行判定会在碎片化传输时 100% 漏检（回归测试 chunkSize=8 就抓到了这个错）。
           上限 64 块 / 128KB：正常流通常第一两块就出结论，纯注释流才会走到上限。 */
        let n = 0;
        let decided = false;
        while (n < 64 && acc.length < 131072 && !decided) {
          const nx = await it.next();
          if (nx.done) break;
          pre.push(nx.value); n++;
          acc += Buffer.from(nx.value).toString('utf8');
          const lines = acc.split('\n');
          for (let li = 0; li < lines.length - 1; li++) {   /* 末段可能是不完整的行，跳过 */
            const l = lines[li].trim();
            if (!l.startsWith('data:')) continue;
            const payload = l.slice(5).trim();
            if (!payload || payload === '[DONE]') { decided = true; break; }
            try {
              const j = JSON.parse(payload);
              if (j && j.error) { err = String((j.error && j.error.message) || (j.error && j.error.code) || 'upstream error'); decided = true; break; }
              if (Array.isArray(j.choices) && j.choices.length > 0) { decided = true; break; }   /* 正常内容块 → 收手 */
            } catch { /* 不完整的 data 行（SSE 被切开）→ 继续读下一块 */ }
          }
        }
      } else {
        /* ★★ 2026-10-08 修：必须用上面拿到的迭代器 `it`，**不能**再写 `for await (const c of resp.body)`。
           因为 `resp.body[Symbol.asyncIterator]()` 已经**锁定了 ReadableStream**，直接用 body 再迭代会抛
           `ERR_INVALID_STATE: ReadableStream is locked` → 被下面 catch 吞掉 → err 静默保持 null（检测失效）。
           ★ 这个 bug 昨天的回归测试没抓到：测试用的是「异步生成器」当 body（不锁定、可重复迭代），
             而真实 undici Response 是 ReadableStream（锁定）。→ 测试必须用真实 ReadableStream 构造。 */
        for await (const c of it) pre.push(c);
        const txt = Buffer.concat(pre).toString('utf8');
        const i = txt.indexOf('{');
        if (i >= 0) {
          try { const j = JSON.parse(txt.slice(i)); if (j && j.error) err = String((j.error && j.error.message) || (j.error && j.error.code) || 'upstream error'); } catch {}
        }
      }
    } catch (e) { err = null; }        /* 读取异常 → 交回下游原有路径处理，不吞 */
    /* 命中即丢弃剩余上游响应，省带宽/token。
       ★ 必须用 it.return() 释放锁：直接 resp.body.cancel() 会抛
         ERR_INVALID_STATE「ReadableStream is locked」（迭代器已持有锁），
         且它以 Promise 拒绝形式抛出 → try/catch 接不住 → Node 22 默认当致命未处理拒绝干掉整个网关。 */
    if (err) { try { if (it.return) await it.return(); } catch {} }
    const mkBody = async function* () { for (const c of pre) yield c; for await (const c of it) yield c; };
    return { res: { ok: resp.ok, status: resp.status, headers: resp.headers, body: err ? null : mkBody() }, err };
  }
  let upRes = null;
  /* ★★ 本地端点（GLM 系列，2026-10-03）：先试本地，失败才退 OpenRouter 兜底。
     ★ 关键设计：退上游时**必须换回 auto 语义**，不能静默换一个不相干的模型。
       用户在客户端明确点了 GLM-5.3-Flash，结果拿到 ling-vl 的回答 = 需求没被满足，
       而且界面显示的模型名也会对不上（比直接报错更难排查）。
       → 兜底走「网关自选的 auto 路由」，并在响应里如实告知降级（下方加 X-AILens-Degraded 头）。 */
  if (isLocalModel) {
    try { upRes = await doFetch(LOCAL_BASE, 'local', 'zcode-bridge'); } catch (e) { upRes = { status: 0, ok: false, error: e }; }
    if (!upRes.ok || upRes.status >= 400) {
      recordFail(body.model);
      const whyLocal = upRes.status ? 'HTTP ' + upRes.status
        : ('fetch failed' + (upRes.error?.cause?.code ? ' (' + upRes.error.cause.code + ')' : '')
           + (upRes.error?.cause?.message ? ' ' + upRes.error.cause.message : ''));
      log({ t: new Date().toISOString(), fallback: 'local→openrouter', reason: whyLocal, model: body.model, note: '本地 GLM 不可用，降级走 auto 路由' });
      degradedFrom = body.model;
      /* 降级：把 model 换成一个真实存在的上游模型，而不是保留 GLM-*（OpenRouter 不认这个名字） */
      const fbModel = LONGCTX_ACTIVE || FREE_ACTIVE;
      body.model = fbModel;
      body.models = [fbModel, ...CHAIN.filter(x => x && x !== fbModel)].slice(0, 3);
      const fbBody = JSON.stringify(body);
      try {
        upRes = await fetch(UPSTREAM, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'HTTP-Referer': 'https://localhost:8765', 'X-Title': 'AILens Gateway [local-fallback]' },
          body: fbBody, signal: AbortSignal.any([ac.signal, AbortSignal.timeout(150000)])
        });
        upstreamLabel = 'openrouter';
        if (upRes.ok) noteServed(fbModel, req.headers['user-agent']);
      } catch (e) { upRes = { status: 0, ok: false, error: e }; }
    } else {
      noteServed(body.model, req.headers['user-agent']);
    }
  } else
  try { upRes = await doFetch(UPSTREAM, isInternModel ? BOOK_KEY : KEY, upstreamLabel); } catch (e) { upRes = { status: 0, ok: false, error: e }; }
  /* ★★ 2026-10-07：端点兜底抽成函数。现在有两条触发路径（状态码失败 / HTTP 200 包裹错误信封），
     各写一遍必然分叉 —— 本项目已有先例（modelCtx 与 noteServed 口径不一致，见《网关说明书》3.1）。 */
  async function fallbackToOpenRouter(reason) {
    /* ★ 书生失败（网络/4xx/5xx）→ fallback OpenRouter */
    recordFail(body.model);
    log({ t: new Date().toISOString(), fallback: 'intern→openrouter', reason, model: body.model });
    const tk = (routed && routed.key) || classify(lastUserText(body)).key;
    const tier = TASK_ENTRY[tk] || 'cheap';
    body.model = tier === 'cheap' ? (tk === 'misc' ? 'inclusionai/ling-3.0-flash-vl' : FREE_ACTIVE) : ENTRY[tier];
    body.models = [body.model, ...[LONGCTX_ACTIVE, FREE_ACTIVE, ...longCtxFallbacks, ...CHAIN].filter(x => x && x !== body.model)].slice(0, 3);
    if (body.thinking_mode !== undefined) delete body.thinking_mode;   /* OpenRouter 不认书生字段 */
    const fbBody = JSON.stringify(body);
    try {
      upRes = await fetch(UPSTREAM, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'HTTP-Referer': 'https://localhost:8765', 'X-Title': 'AILens Gateway' },
        body: fbBody,
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(150000)])
      });
      upstreamLabel = 'openrouter';
    } catch (e) { upRes = { status: 0, ok: false, error: e }; }
  }
  /* 本次请求是否已用掉端点兜底（防 ping-pong：两个端点互相踢球） */
  let endpointFallbackUsed = false;
  if (isInternModel && (!upRes.ok || upRes.status >= 400) && KEY) {
    endpointFallbackUsed = true;
    await fallbackToOpenRouter(upRes.status ? 'HTTP ' + upRes.status : String(upRes.error && upRes.error.message));
  }
  async function fallbackToIntern(reason) {
    /* ★ OpenRouter 失败（预算上限/429/5xx/网络）→ fallback 书生 */
    recordFail(body.model);
    log({ t: new Date().toISOString(), fallback: 'openrouter→intern', reason, model: body.model });
    const tk = (routed && routed.key) || classify(lastUserText(body)).key;
    const estTok = estPromptTokens(body);
    let internModel = null;
    if (realEstimate(estTok) > LONGCTX_MIN_TOKENS) internModel = 'deepseek-v4-pro-0813';   /* 长上下文兜底也用 pro（17.4s@83万 tok，最快）；真实口径判定 */
    else if (THINK_ON.has(tk)) internModel = 'intern-s2';                    /* 深度思考（不扣墨点） */
    /* ★ 2026-10-02 17:55：misc 原先兜底到 deepseek-v4-flash-vision，但该模型已实测 429 quota exceeded
       —— 「OpenRouter 挂了才退书生」这条最后的退路自己也是死的。改用 Atria-Dawn-Preview（实测短请求 7.2s 可用）。 */
    else internModel = 'Atria-Dawn-Preview';                                 /* 常规杂活 / misc（不扣墨点，即时免费） */
    if (internModel && INTERN_MODELS.has(internModel)) {
      body.model = internModel;
      body.thinking_mode = THINK_ON.has(tk);
      delete body.models;        /* 书生不认 models 数组 */
      delete body.reasoning;     /* 书生不认 reasoning */
      delete body.stream_options;/* 书生不认 stream_options */
      const fbBody = JSON.stringify(body);
      try {
        upRes = await fetch(INTERN_BASE + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BOOK_KEY, 'HTTP-Referer': 'https://localhost:8765', 'X-Title': 'AILens Gateway [intern-fallback]' },
          body: fbBody,
          signal: AbortSignal.any([ac.signal, AbortSignal.timeout(90000)])   /* ★ 2026-10-08（B）：与 doFetch 的书生预算对齐（原 150000） */
        });
        upstreamLabel = 'intern-ai';
      } catch (e) { upRes = { status: 0, ok: false, error: e }; }
    }
  }
  if (!isInternModel && (!upRes.ok || upRes.status >= 400) && BOOK_KEY && !isInternQuotaExhausted()) {
    endpointFallbackUsed = true;
    await fallbackToIntern(upRes.status ? 'HTTP ' + upRes.status : String(upRes.error && upRes.error.message));
  }
  /* ★★ 2026-10-07 新增：HTTP 200 但 body 是「错误信封」→ 反向端点兜底一次。
     起因见 peekErrorEnvelope 注释。原行为：错误被当成功透传（客户端反复报错、日志全 200）。 */
  if (upRes && upRes.ok) {
    const env = await peekErrorEnvelope(upRes, body.stream === true);
    upRes = env.res;
    if (env.err) {
      recordFail(body.model);
      log({ t: new Date().toISOString(), errorEnvelope: true, reason: env.err, model: body.model, endpoint: upstreamLabel });
      const canFbOr = upstreamLabel === 'intern-ai' && KEY;
      const canFbIn = upstreamLabel !== 'intern-ai' && BOOK_KEY && !isInternQuotaExhausted();
      if (!endpointFallbackUsed && (canFbOr || canFbIn)) {
        endpointFallbackUsed = true;
        if (canFbOr) await fallbackToOpenRouter('200-wrapped error: ' + env.err);
        else await fallbackToIntern('200-wrapped error: ' + env.err);
        const env2 = await peekErrorEnvelope(upRes, body.stream === true);
        upRes = env2.res;
        if (env2.err) {
          recordFail(body.model);
          log({ t: new Date().toISOString(), errorEnvelope: true, reason: env2.err, model: body.model, endpoint: upstreamLabel, afterEndpointFallback: true });
        }
      }
      /* 兜底没救回来 → 如实返回 502（旧行为是 200 + 错误体透传，客户端只会反复重试） */
      if (!upRes || !upRes.ok || !upRes.body) {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end('{"error":{"message":"gateway: upstream error envelope (HTTP 200): ' + String(env.err).replace(/"/g, "'") + '"}}');
        }
        try { res.end(); } catch {}
        return;
      }
    }
  }
  /* 模型健康记录（按最终结果） */
  if (upRes && upRes.ok && upRes.status < 400) recordSuccess(body.model);
  else recordFail(body.model);

  if (!upRes || !upRes.ok) {
    const msg = 'gateway upstream error: ' + (upRes && upRes.error ? String(upRes.error.message) : upstreamLabel + ' HTTP ' + (upRes && upRes.status));
    res.writeHead(502, { 'Content-Type': 'application/json' });
    return res.end('{"error":{"message":"' + msg.replace(/"/g, "'") + '"}}');
  }

    /* ---- 流式直通：WorkBuddy/Cherry 的 stream 请求逐块转发，首 token 秒到 + 增量解析 usage ---- */
    if (body.stream === true && upRes.body) {
    res.writeHead(upRes.status, {
      'Content-Type': upRes.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      /* ★ 2026-10-03 降级透明化：本地 GLM 不可用而退回上游时，如实告知客户端
         「你点的模型没被服务，实际是哪个」。没有这个头，客户端只看到 200 + 别的模型的回答，
         根本不知道自己的选择被静默替换了。
         ★ 2026-10-03 15:00 修：JSON.stringify 的裸 JSON 不能直接做 header 值
           （Node 校验 "Invalid character in header content" → unhandled 异常 → 响应中断），
           改用 encodeURIComponent 包一层。 */
      ...(degradedFrom ? { 'X-AILens-Degraded': encodeURIComponent(JSON.stringify({ requested: degradedFrom, served: body.model, reason: '本地端点不可用' })) } : {})
    });
    res.on('close', () => { try { ac.abort(); } catch {} });   /* 客户端 60s 超时断开 → 停止上游 */
    let tail = '';
    let streamUsage = null;       /* 流内增量解析到的 usage（streamed response） */
    let servedModelFromStream = model;
    let wroteAny = false;         /* ★ 2026-10-08（C）：是否已向客户端写出过任何字节 */
    let wroteBody = false;        /* ★ 2026-10-08（C）：是否写出过「正文」（reasoning_content 不算有效产出） */
    try {
      for await (const c of upRes.body) {
        res.write(c);
        wroteAny = true;
        const text = Buffer.from(c).toString('utf8');
        tail = (tail + text).slice(-6144);
        /* ★ 增量解析：实时检查 data: 行是否包含 usage */
        const lines = text.split('\n');
        for (let li = 0; li < lines.length; li++) {
          const l = lines[li].trim();
          if (!l.startsWith('data:')) continue;
          const payload = l.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            if (j.usage && !streamUsage) { streamUsage = j.usage; break; }
            if (j.model && j.model !== servedModelFromStream) servedModelFromStream = j.model;
            /* ★ C：识别正文增量 —— delta.content 非空才算「模型真的答了」，
               reasoning_content（思考过程）不算，否则「只有思考没正文」会被误判为已产出。 */
            const d = j.choices && j.choices[0] && j.choices[0].delta;
            if (!wroteBody && d && d.content) wroteBody = true;
          } catch {}
        }
      }
    } catch (e) {
      /* ★★ 2026-10-08（C）：上游超时/中断时**必须给客户端一个明确的结束**。
         旧行为只有 `res.end()` —— 客户端收到一个既没有 [DONE]、也没有 error 的半截 SSE 流，
         界面就一直显示「思考中/停不下来」（用户报告「无限思考」的直接来源之一）。
         现在补发一个 error 事件 + [DONE]：客户端能立刻知道「失败了，可重试」，而不是干等。 */
      const isTimeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError'
        || /timeout|abort|aborted/i.test(String((e && e.message) || '')));
      const why = isTimeout ? 'upstream timeout' : ('interrupted: ' + String((e && e.message) || e));
      /* ★★ 2026-10-08（B）超时兜底：中断若发生在「还没吐出正文」时（模型光想不答 —— Atria 的典型失控），
         补一次 OpenRouter 兜底并把结果**接进同一条流**，客户端最终能拿到回复，
         而不是白等 90 秒只收到一个错误。
         为什么必须在这里做：Atria 失控是「先返回 200、再一直吐 reasoning_content」，
         超时发生在流中途、响应头早已发出 → 路由层的 fallbackToOpenRouter 对它无能为力。 */
      let rescued = false;
      if (isTimeout && !wroteBody && KEY) {
        try {
          const fb = { ...body };
          delete fb.thinking_mode;      /* 书生字段，OpenRouter 不认 */
          delete fb.reasoning;
          fb.model = FREE_ACTIVE;
          fb.models = [FREE_ACTIVE, ...CHAIN.filter(x => x && x !== FREE_ACTIVE)].slice(0, 3);
          fb.stream = true;
          fb.stream_options = { include_usage: true };
          const r2 = await fetch(UPSTREAM, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'HTTP-Referer': 'https://localhost:8765', 'X-Title': 'AILens Gateway [timeout-rescue]' },
            body: JSON.stringify(fb),
            signal: AbortSignal.any([ac.signal, AbortSignal.timeout(90000)])
          });
          if (r2.ok && r2.body) {
            for await (const c of r2.body) { try { res.write(c); wroteAny = true; } catch {} }
            rescued = true;
            log({ t: new Date().toISOString(), timeoutRescue: true, from: servedModelFromStream || model, to: FREE_ACTIVE, ms: Date.now() - t0 });
          }
        } catch (e2) {
          log({ t: new Date().toISOString(), timeoutRescueFail: String((e2 && e2.message) || e2), ms: Date.now() - t0 });
        }
      }
      if (!rescued) try {
        res.write('data: ' + JSON.stringify({
          error: {
            message: 'gateway: ' + why + '（' + (servedModelFromStream || model) + ' 未在预算内完成，已中断，请重试）',
            code: 504
          }
        }) + '\n\ndata: [DONE]\n\n');
      } catch {}
      log({ t: new Date().toISOString(), streamAborted: why, model: servedModelFromStream || model, ms: Date.now() - t0, wroteAny, wroteBody, rescued });
      try { res.end(); } catch {}
    }
    /* ★ 压缩信号：在 [DONE] 之前注入 _compress event（如果 res.end() 已触发则跳过） */
    const shouldSignal = streamUsage && isHealthy(servedModelFromStream || model);
    const ctx = modelCtx({ id: servedModelFromStream || model });
    if (shouldSignal && ctx) {
      const total = (streamUsage.prompt_tokens || 0) + (streamUsage.completion_tokens || 0);
      const ratio = +(total / ctx).toFixed(3);
      if (ratio >= COMPRESS_WARN_RATIO) {
        let level = ratio >= COMPRESS_CRITICAL_RATIO ? 'URGENT' : 'WARN';
        const sigChunk = 'data: ' + JSON.stringify({
          _compress: true, _level: level,
          model: servedModelFromStream || model,
          context_length: ctx,
          prompt_tokens: streamUsage.prompt_tokens, completion_tokens: streamUsage.completion_tokens,
          total_tokens: total, ratio: ratio
        }) + '\n\n';
        lastUsageRecord[servedModelFromStream || model] = { t: new Date().toISOString(), ...streamUsage, ratio };
        try { res.write(sigChunk); } catch {}   /* 如果客户端已 close 会被静默丢弃 */
      }
    }
    try { res.end(); } catch {}
    let usage = streamUsage || null;
    let servedModel = servedModelFromStream || model;
    /* 备用：从 tail 中逆向提取 usage（防增量解析漏抓） */
    if (!usage) {
      const lines = tail.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (!l.startsWith('data:')) continue;
        const payload = l.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j.usage && !usage) usage = j.usage;
          if (j.model) servedModel = j.model;
          if (usage) break;
        } catch {}
      }
    }
    let costCny = null;
    noteServed(servedModel || model, req.headers['user-agent']);
    if (usage) {
      noteRealPrompt(usage.prompt_tokens, estTok);   /* ★ 真实 token 校准基准 */
      const p = prices[servedModel] || prices[model] || null;
      if (p) {
        const usd = (usage.prompt_tokens || 0) / 1e6 * (p.priceIn1M || 0) + (usage.completion_tokens || 0) / 1e6 * (p.priceOut1M || 0);
        costCny = usd * 6.7;
      }
      /* 书生用量记录：1 墨点 = 500 万 tokens */
      if (upstreamLabel === 'intern-ai' && BOOK_KEY && !INTERN_NOQUOTA.has(body.model)) {
        const dianUsed = recordInternUsage(usage.prompt_tokens, usage.completion_tokens);
        log({ t: new Date().toISOString(), quotaUpdate: true, dianUsed: dianUsed.toFixed(4), used5h: quota.used5h.toFixed(2), used7d: quota.used7d.toFixed(2) });
      }
    }
    const logRow = { t: new Date().toISOString(), auto: !!routed, routed, model: servedModel, status: upRes.status, ms: Date.now() - t0, streamed: true, provider: upstreamLabel };
    /* ★ 记录来源 App（12-53 加）：此前只有 /models 记 ua，聊天请求不记 → 日志无法区分 Cherry / WorkBuddy */
    const ua0 = (req.headers['user-agent'] || '').slice(0, 60);
    if (ua0) logRow.ua = ua0;
    if (usage) logRow.usage = usage;
    if (costCny != null) logRow.cost_cny = Math.round(costCny * 100) / 100;
    if (!usage) logRow.tailEnd = tail.slice(-400).slice(0, 400);   /* 诊断：没抓到 usage 时记录流尾，定位上游到底回了什么 */
    log(logRow);
    return;
  }
  /* 缓冲 response body 到内存,解析 usage + cost,然后发给客户端 */
  let bodyBuf = null;
  let usage = null;
  let costCny = null;
  try {
    if (upRes.body) {
      const chunks = [];
      for await (const c of upRes.body) chunks.push(c);
      bodyBuf = Buffer.concat(chunks);
      try {
        const j = JSON.parse(bodyBuf.toString('utf8'));
        usage = j.usage || null;
        const servedModel = (j && j.model) || model;
        noteServed(servedModel, req.headers['user-agent']);
        if (usage) noteRealPrompt(usage.prompt_tokens, estTok);   /* ★ 真实 token 校准基准（非流式路径） */
        const p = prices[servedModel] || prices[model] || null;
        if (p && usage) {
          const inTok = (usage.prompt_tokens || 0) / 1e6;
          const outTok = (usage.completion_tokens || 0) / 1e6;
          const usd = inTok * (p.priceIn1M || 0) + outTok * (p.priceOut1M || 0);
          costCny = usd * 6.7;
        }
        /* ★ 非流式：压缩信号通过 HTTP header 注入 */
        if (usage) {
          const total = usage.prompt_tokens + usage.completion_tokens;
          const ctx = modelCtx({ id: servedModel });
          if (ctx && total >= ctx * COMPRESS_WARN_RATIO) {
            const ratio = +(total / ctx).toFixed(3);
            res.setHeader('X-Context-Compress', JSON.stringify({ _compress: true, ratio, total, context_length: ctx, model: servedModel }));
          }
        }
      } catch {}
    }
  } catch (e) {
    /* 上游流中途断掉（ECONNRESET / terminated 等）→ 返回 502，不拖垮整个进程 */
    const code = (e && e.cause && e.cause.code) || (e && e.code) || '';
    try { log({ t: new Date().toISOString(), streamError: code || String(e && e.message || e), model, ms: Date.now() - t0 }); } catch {}
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end('{"error":{"message":"gateway: upstream connection reset (' + code + '), retry"}}');
    }
    try { res.end(); } catch {}
    return;
  }
  const logRow = { t: new Date().toISOString(), auto: !!routed, routed, model, status: upRes.status, ms: Date.now() - t0, provider: upstreamLabel };
  /* ★ 记录来源 App（12-53 加） */
  const uaBuf = (req.headers['user-agent'] || '').slice(0, 60);
  if (uaBuf) logRow.ua = uaBuf;
  if (usage) {
    logRow.usage = usage;
    /* 书生用量记录 */
    if (upstreamLabel === 'intern-ai' && BOOK_KEY && !INTERN_NOQUOTA.has(body.model)) {
      const dianUsed = recordInternUsage(usage.prompt_tokens, usage.completion_tokens);
      log({ t: new Date().toISOString(), quotaUpdate: true, dianUsed: dianUsed.toFixed(4), used5h: quota.used5h.toFixed(2), used7d: quota.used7d.toFixed(2) });
    }
  }
  if (costCny != null) logRow.cost_cny = Math.round(costCny * 100) / 100;
  log(logRow);
  res.writeHead(upRes.status, {
    'Content-Type': upRes.headers.get('content-type') || 'application/json',
    ...(degradedFrom ? { 'X-AILens-Degraded': encodeURIComponent(JSON.stringify({ requested: degradedFrom, served: body.model, reason: '本地端点不可用' })) } : {})
  });
  if (bodyBuf) res.end(bodyBuf); else res.end();
});

/* ---------- 全局兜底：未捕获的流/网络错误只记日志，绝不杀进程 ---------- */
process.on('uncaughtException', e => {
  try { log({ t: new Date().toISOString(), uncaught: String((e && e.message) || e) }); } catch {}
});
process.on('unhandledRejection', e => {
  try { log({ t: new Date().toISOString(), unhandled: String((e && e.message) || e) }); } catch {}
});

server.on('error', e => {
  if (e && e.code === 'EADDRINUSE') { console.log('端口 9999 已被占用，网关已在运行，本实例退出。'); process.exit(0); }
  console.error('网关启动失败:', e && e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  try { fs.writeFileSync(PIDF, String(process.pid)); } catch {}
  log({ t: new Date().toISOString(), started: true, keyLoaded: !!KEY });
  auditVisionRegistry();   /* 视觉登记表自检：日志里能看到每个模型实际的 input_modalities */
  /* ★ 启动时顺手拉起「WorkBuddy 上下文同步」—— 网关活它就活，网关挂它跟着挂（2026-10-02） */
  startWorkBuddyCtxSync();
});

/* ---------- 内置：把网关 auto 真实上下文同步进 WorkBuddy models.json（跟随网关生命周期） ----------
   ★★ 2026-10-02 20:05 重大修正：这个内置版与 tools/sync-ctx-to-workbuddy.mjs（独立版）
      同时在写同一个文件，两个 Node 进程每 10s 交替全量重写 → 竞态。
      实测后果（用户报「WorkBuddy 找不到网关、模型自动跳到快速档」）：
        1) id 在两个模型名之间每 10 秒来回翻转（独立版按 servedAt 跟随最近路由写 id，
           而 servedAt 被不同客户端轮流覆盖 → Hermes 和 WorkBuddy 交替抢占）；
        2) 两版对同一文件 JSON.stringify 的时机不同步，产生出带尾随空格的脏值
           （实测 models.json 里出现过 id="ailens-auto·Atria-Dawn-Preview "）；
        3) WorkBuddy 的 fs.watch 每次都判定「配置变了」→ 触发热同步重载 → 会话被重置。
      ★★ 2026-10-08 合并为「唯一写者」：原独立脚本 tools/sync-ctx-to-workbuddy.mjs 的「写 name」
      职责已并入本函数，该脚本归档到 _归档_20261008/，看门狗不再兜它。
      理由：用户铁律「同一份配置只允许一个进程写」—— 两个进程各自「读全量 → 改 → 整文件写回」，
      即便约定各写各的字段，整文件回写仍会互相覆盖（10-02 事故的教训，只是一直没根治）。
      ★ 合并前先做了隔离实测（确认本函数真的在跑，不是靠独立脚本撑着）：
        把独立脚本移走 + 杀掉其进程 + 人为写坏 maxInputTokens=424242 → 12 秒内被本函数改回 1000000，
        且独立脚本日志零增长 ⇒ 本函数确实在跑。
      ★ 合并后仍必须遵守的三条老规矩：
        ① 数值字段只写整数，绝不写 null（null 会让整条配置被验证器静默丢弃 → 模型集体消失）；
        ② 写前 trim 掉 id/name 的首尾空白（脏值会让 WorkBuddy 每次 fs.watch 都判定「配置变了」→ 热重载）；
        ③ 只改目标条目的字段，其余内容（含 enc:v1 加密 key）原样保留。 */
let _wbSyncTimer = null;
function startWorkBuddyCtxSync() {
  if (_wbSyncTimer) return;
  const MODELS_FILE = (process.env.USERPROFILE || process.env.HOME || '.').replace(/\\/g, '/') + '/.workbuddy/models.json';
  const BACKUP_FILE = MODELS_FILE + '.bak_syncctx';
  const MARKER = '9999';
  const BASE_ID = 'ailens-auto';                 /* ★ 身份，恒定不变；改动它 = 换条目 = WorkBuddy 报 400 */
  const BASE_NAME = 'AILens网关（自动路由）';     /* name 的固定前缀，实际模型名追加在后面 */
  const MAX_NAME_LEN = 60;                       /* name 太长会挤爆模型选择器 */
  let lastWritten = undefined;

  /* 把网关返回的模型 id 变成人话（与归档脚本里的实现逐字一致）：
       nvidia/nemotron-3-ultra-550b-a55b:free → Nemotron 3 Ultra 550b A55b */
  function prettyModel(id) {
    if (!id) return '';
    let s = String(id);
    const slash = s.lastIndexOf('/');
    if (slash >= 0) s = s.slice(slash + 1);
    s = s.replace(/:free$/i, '').replace(/[-_]+/g, ' ').trim();
    return s.replace(/\b\w/g, c => c.toUpperCase());
  }
  function buildName(pretty) {
    if (!pretty) return BASE_NAME;
    return ('AILens网关（' + pretty + '）').slice(0, MAX_NAME_LEN);
  }

  async function tick() {
    try {
      const r = await fetch('http://127.0.0.1:9999/v1/model-context?model=auto', { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      if (!j || !j.ok) return;
      /* ★ 同时比对磁盘现值：仅靠内存 lastWritten 会漏判（外部改过）→ 重复写 → 触发无谓热同步 */
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')); } catch { return; }
      if (!Array.isArray(cfg)) return;
      const entry = cfg.find(e => String(e.url || '').includes(MARKER));
      if (!entry) return;

      /* ① maxInputTokens ← 网关 auto 当前实际路由模型的上下文长度（整数，绝不写 null/float） */
      const ctx = Number.isFinite(j.context_length) ? Math.trunc(j.context_length) : null;
      /* ② name ← 「AILens网关（<真实模型名>）」；这一轮不是 WorkBuddy 发起的就还原基础名。
         name 只在选择器里显示、不参与请求、不加前缀 —— 所以改它安全；id 才是不许动的身份。 */
      const wantName = buildName(j.servedByWorkBuddy === true ? prettyModel(j.model) : '');

      /* ③ 顺手清理首尾空白（历史脏值会让 WorkBuddy 每次 fs.watch 都判定配置变化） */
      let cleaned = false;
      for (const f of ['id', 'name']) {
        if (typeof entry[f] === 'string') { const t = entry[f].trim(); if (t !== entry[f]) { entry[f] = t; cleaned = true; } }
      }
      const ctxChanged  = ctx !== null && entry.maxInputTokens !== ctx;
      const nameChanged = entry.name !== wantName;
      const idChanged   = entry.id !== BASE_ID;          /* ★ 兜住任何把 id 改花的意外 */
      if (!ctxChanged && !nameChanged && !idChanged && !cleaned) return;   /* 磁盘已是目标值 → 不写 */

      if (!fs.existsSync(BACKUP_FILE)) fs.copyFileSync(MODELS_FILE, BACKUP_FILE);
      if (ctxChanged)  entry.maxInputTokens = ctx;
      if (nameChanged) entry.name = wantName;
      if (idChanged)   entry.id = BASE_ID;
      fs.writeFileSync(MODELS_FILE, JSON.stringify(cfg, null, 2));
      lastWritten = ctx;
      /* 走 log() 落 gateway-log.jsonl —— 网关是 detached 启动、stdout 被丢弃，console.log 看不到 */
      log({ t: new Date().toISOString(), wbSync: {
        ...(ctxChanged ? { ctx } : {}),
        ...(nameChanged ? { name: wantName } : {}),
        ...(idChanged ? { idFixed: BASE_ID } : {}),
        ...(cleaned ? { cleanedWs: true } : {}),
        routed: j.model || null
      } });
    } catch (e) { /* 网关未就绪/文件锁定 → 静默下轮重试 */ }
  }
  tick();
  _wbSyncTimer = setInterval(tick, 10000);
}

function stopWorkBuddyCtxSync() {
  if (_wbSyncTimer) { clearInterval(_wbSyncTimer); _wbSyncTimer = null; }
}

/* ---------- 自杀：两个 App 都关超过 2 分钟 → 退出，等计划任务下次拉起 ---------- */
let idle = 0;
setInterval(() => {
  const any = appsRunning();
  if (any === null) return;             /* 探测失败不动 */
  idle = any ? 0 : idle + 1;
  if (idle >= 4) { stopWorkBuddyCtxSync(); try { fs.unlinkSync(PIDF); } catch {} log({ t: new Date().toISOString(), stopped: 'apps closed' }); process.exit(0); }
}, 30000);
