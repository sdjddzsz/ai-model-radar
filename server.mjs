/**
 * AI 模型雷达 · 本地数据服务
 * 零依赖（Node 22+ 自带 fetch）。服务端抓数据绕过浏览器跨域限制，带磁盘缓存与失败降级。
 * 启动：node server.mjs   然后浏览器打开 http://localhost:8765
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'public');
const CACHE = path.join(__dirname, 'cache');
fs.mkdirSync(CACHE, { recursive: true });

const PORT = Number(process.env.PORT || 8765);
const UA = { 'User-Agent': 'Mozilla/5.0 AILens/1.0', 'Accept': 'application/json,text/html' };

/* ============================ 通用：带缓存抓取 ============================ */
function cachePath(name) { return path.join(CACHE, name + '.json'); }

async function grabJSON(name, url, ttlMs, parse) {
  const file = cachePath(name);
  if (fs.existsSync(file)) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < ttlMs) {
      try { return { ok: true, cached: true, ageMs: age, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
      catch (e) { /* 缓存坏了就走抓取 */ }
    }
  }
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const raw = await r.json();
    const data = parse ? parse(raw) : raw;
    fs.writeFileSync(file, JSON.stringify(data));
    return { ok: true, cached: false, ageMs: 0, data };
  } catch (e) {
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { ok: true, cached: true, stale: true, ageMs: Date.now() - fs.statSync(file).mtimeMs, data, error: String(e.message || e) };
      } catch (e2) { /* fallthrough */ }
    }
    return { ok: false, error: String(e.message || e) };
  }
}

/* ============================ 厂商与开源判定 ============================ */
const VENDOR = {
  'openai': 'OpenAI', 'anthropic': 'Anthropic', 'google': 'Google', 'x-ai': 'xAI',
  'meta-llama': 'Meta', 'deepseek': 'DeepSeek', 'deepseek-ai': 'DeepSeek', 'qwen': '阿里 Qwen',
  'moonshotai': '月之暗面 Kimi', 'mistralai': 'Mistral', 'z-ai': '智谱 GLM', 'zai-org': '智谱 GLM',
  'minimax': 'MiniMax', 'microsoft': '微软', 'amazon': 'Amazon', 'perplexity': 'Perplexity',
  'cohere': 'Cohere', 'nvidia': 'NVIDIA', 'thudm': '智谱·清华', 'baidu': '百度', 'bytedance': '字节跳动',
  'stepfun': '阶跃星辰', 'ai21': 'AI21', 'inception': 'Inception', 'liquid': 'Liquid AI',
  'nousresearch': 'Nous Research', 'openrouter': 'OpenRouter', 'internal': '内部',
  'google-deepmind': 'Google DeepMind', 'tngtech': 'TNG', 'arcee-ai': 'Arcee', 'allenai': 'Ai2',
  'sentientagi': 'Sentient', 'rekaai': 'Reka', 'sao10k': 'Sao10K', 'undi95': 'Undi95',
  'aion-labs': 'Aion', 'featherless': 'Featherless', 'cognitivecomputations': 'Dolphin'
};

const OPEN_EXTRA = /^(openai\/gpt-oss|google\/gemma|meta-llama\/|deepseek-ai\/|deepseek\/|qwen\/|moonshotai\/kimi-k2|z-ai\/|zai-org\/|thudm\/|mistralai\/(mistral|mixtral|mathstral|devstral|magistral|codestral-mamba|voxtral)|nvidia\/|microsoft\/phi|allenai\/|nousresearch\/|bigcode\/|arcee-ai\/|tngtech\/|internlm\/|01-ai\/|tiiuae\/|xai\/grok-)/i;

const CLOSED_VENDOR = /^(openai|anthropic|google|x-ai|perplexity|amazon|cohere|ai21|inception|liquid|stepfun|baidu|bytedance)\//i;

/* ============================ 厂商网络接口速查（防遗忘） ============================ */
/* 常驻下发到前端：聚合/路由类厂商的 API 地址、是否需 Key、免费模型获取方式。
   OpenRouter 无需 Key 即可列免费模型；其余厂商需填入自己的 Key 才能调其 /models。 */
const VENDOR_ENDPOINTS = [
  { key:'openrouter', name:'OpenRouter',
    site:'https://openrouter.ai/', keyUrl:'https://openrouter.ai/settings/keys',
    endpoint:'https://openrouter.ai/api/v1',
    modelsUrl:'https://openrouter.ai/api/v1/models',
    needKey:false,
    note:'聚合路由 / OpenAI 兼容。免费模型 ID 以 :free 结尾，无需 Key 即可列出免费模型。',
    freeHint:'本雷达已自动拉取并展示其免费模型（见下方列表）。' },
  { key:'together', name:'Together AI',
    site:'https://www.together.ai/', keyUrl:'https://api.together.ai/settings/api-keys',
    endpoint:'https://api.together.xyz/v1',
    modelsUrl:'https://api.together.xyz/v1/models',
    needKey:true,
    note:'需 API Key。免费模型 ID 多含 -Free。',
    freeHint:'填入你的 Together Key 后，在对应平台 /models 过滤含 -Free 的模型即可。' },
  { key:'groq', name:'Groq',
    site:'https://groq.com/', keyUrl:'https://console.groq.com/keys',
    endpoint:'https://api.groq.com/openai/v1',
    modelsUrl:'https://api.groq.com/openai/v1/models',
    needKey:true,
    note:'需 API Key。免费模型 ID 多含 -free。',
    freeHint:'在 Groq Console 申请 Key，调 /openai/v1/models 过滤含 -free 的模型。' },
  { key:'hf', name:'HuggingFace Router',
    site:'https://huggingface.co/', keyUrl:'https://huggingface.co/settings/tokens',
    endpoint:'https://router.huggingface.co/v1',
    modelsUrl:'https://router.huggingface.co/v1/models',
    needKey:true,
    note:'需 API Key。HuggingFace 推理路由，按 token 计费。',
    freeHint:'在 HF 设置里生成 Key，调 /v1/models 查看可用模型（无免费档，按量付费）。' },
  { key:'gemini', name:'Google Gemini',
    site:'https://ai.google.dev/', keyUrl:'https://aistudio.google.com/apikey',
    endpoint:'https://generativelanguage.googleapis.com/v1beta',
    modelsUrl:'https://generativelanguage.googleapis.com/v1beta/models',
    needKey:true,
    note:'需 API Key（拼在 ?key= 后）。免费层含特定模型（如 gemini-flash 免费额度）。',
    freeHint:'在 Google AI Studio 申请 Key，调 /v1beta/models 过滤含 free 或免费配额的模型。' },
  { key:'deepinfra', name:'DeepInfra',
    site:'https://deepinfra.com/', keyUrl:'https://deepinfra.com/dash/keys',
    endpoint:'https://api.deepinfra.com/v1/openai',
    modelsUrl:'https://api.deepinfra.com/v1/openai/models',
    needKey:true,
    note:'需 API Key；OpenAI 兼容格式。',
    freeHint:'在 DeepInfra 控制台申请 Key，调 /v1/openai/models 查看模型与价格。' },
  { key:'fireworks', name:'Fireworks',
    site:'https://fireworks.ai/', keyUrl:'https://fireworks.ai/account/api-keys',
    endpoint:'https://api.fireworks.ai/inference/v1',
    modelsUrl:'https://api.fireworks.ai/inference/v1/models',
    needKey:true,
    note:'需 API Key；OpenAI 兼容格式。',
    freeHint:'在 Fireworks 控制台申请 Key，调 /inference/v1/models 查看模型与价格。' }
];

function vendorOf(id) { return VENDOR[id.split('/')[0]] || id.split('/')[0]; }

/* ============================ 模型归一化 ============================ */
function normModels(raw) {
  const list = (raw && raw.data) || [];
  // ⚠️ OpenRouter 的「路由型」模型（openrouter/auto、/fusion 等）自己没有固定单价：
  // 它们的 pricing.prompt 是哨兵值 -1000000，代表"价格随它最终给你挑的那个模型浮动"。
  // 拿这种值去算钱会得到负数 → 任何"最便宜排序"都会把它们顶到第一，所以直接剔除。
  const priced = list.filter(m => {
    const p = m.pricing || {};
    return !(Number(p.prompt || 0) < 0 || Number(p.completion || 0) < 0);
  });
  return priced.map(m => {
    const id = m.id || '';
    const price = m.pricing || {};
    const inP = Number(price.prompt || 0), outP = Number(price.completion || 0);
    const isFree = inP === 0 && outP === 0;
    // 缓存命中（cache hit）价：命中已算过的前缀时按这个价收，通常只有输入价的几十分之一。
    // 厂商没单独标注时置 null，前端按"不打折"保守估算。
    const cacheRead = Number(price.input_cache_read || 0);
    const reqFee = Number(price.request || 0);
    const hf = m.hugging_face_id || '';
    let open;
    if (hf) open = true;
    else if (OPEN_EXTRA.test(id)) open = true;
    else if (CLOSED_VENDOR.test(id)) open = false;
    else open = null; // 未知

    const arch = m.architecture || {};
    const modalities = arch.input_modalities || [];
    const outMods = arch.output_modalities || [];
    const params = m.supported_parameters || [];

    return {
      id, name: m.name || id, vendor: vendorOf(id), vendorKey: id.split('/')[0],
      provider: 'openrouter',   // 数据来源（路由/聚合提供商），用于"按提供商"分组
      created: m.created ? m.created * 1000 : null,
      context: m.context_length || 0,
      priceIn1M: +(inP * 1e6).toFixed(3), priceOut1M: +(outP * 1e6).toFixed(3),
      priceCache1M: cacheRead ? +(cacheRead * 1e6).toFixed(3) : null,
      reqFee: reqFee ? +reqFee.toFixed(6) : 0,
      free: isFree,
      open,
      hf,
      input_modalities: modalities, output_modalities: outMods,
      vision: modalities.includes('image'),
      audio: modalities.includes('audio') || outMods.includes('audio'),
      image_out: outMods.includes('image'),
      reasoning: params.includes('reasoning'),
      tools: params.includes('tools'),
      knowledge: m.knowledge_cutoff || null,
      desc: (m.description || '').slice(0, 1400),
      params: params
    };
  });
}

/* ============================ 客户端 × 模型（内置知识库） ============================ */
const FAMS = ['OpenAI GPT', 'Anthropic Claude', 'Google Gemini', 'Meta Llama', '阿里 Qwen', 'DeepSeek', 'Mistral', 'xAI Grok', '本地开源(GGUF)', 'OpenRouter 全量'];
//              ✅=原生/官方   ✅A=API直连   🔧=自定义API可接   ❌=不支持
const CLIENTS = [
  { n: 'ChatGPT 官方', icon: '🟢', type: '官方客户端', plat: '网页 / Win / Mac / iOS / Android', pay: '免费 + Plus($20/月) + Pro',
    row: ['✅', '❌', '❌', '❌', '❌', '❌', '❌', '❌', '❌', '❌'],
    best: '只想用 GPT、要图像/语音/联网搜索等全家桶功能', tip: '独家功能最多（Canvas、语音、Agent），但锁死 OpenAI 一家。' },
  { n: 'Claude Desktop', icon: '🟣', type: '官方客户端', plat: 'Win / Mac / 网页', pay: '免费 + Pro($20/月) + Max',
    row: ['❌', '✅', '❌', '❌', '❌', '❌', '❌', '❌', '❌', '❌'],
    best: '写长文、改代码、要用 Artifacts 和 MCP 工具', tip: 'MCP 生态最好，Claude Code 也是这条线。' },
  { n: 'Gemini 官方', icon: '🔵', type: '官方客户端', plat: '网页 / App / 集成在谷歌全家桶', pay: '免费 + AI Pro / Ultra',
    row: ['❌', '❌', '✅', '❌', '❌', '❌', '❌', '❌', '❌', '❌'],
    best: '超长上下文、多模态、和 Google 文档/搜索联动', tip: '上下文长度在主流模型里最激进。' },
  { n: 'DeepSeek 官方', icon: '🐳', type: '官方客户端', plat: '网页 / App', pay: '免费（API 另算）',
    row: ['❌', '❌', '❌', '❌', '❌', '✅', '❌', '❌', '❌', '❌'],
    best: '中文写作、数学推理、白嫖高强度模型', tip: '国产开源模型里口碑最稳，网页版免费。' },
  { n: 'Kimi / 通义 / 豆包 官方', icon: '🇨🇳', type: '官方客户端', plat: '网页 / App', pay: '免费为主',
    row: ['❌', '❌', '❌', '❌', '✅', '✅', '❌', '❌', '❌', '❌'],
    best: '中文场景、长文档总结、日常白嫖', tip: '各自只服务自家模型，选一个顺手的就行。' },
  { n: 'Cherry Studio', icon: '🍒', type: '第三方聚合', plat: 'Win / Mac / Linux', pay: '开源免费',
    row: ['🔧', '🔧', '🔧', '✅A', '✅A', '✅A', '✅A', '✅A', '✅A', '✅'],
    best: '一个客户端切换所有模型，界面体验最好', tip: '支持 OpenRouter / 各家 API / Ollama 本地，知识库、翻译、 agents 都有。当前最推荐的全能款。' },
  { n: 'Chatbox', icon: '📦', type: '第三方聚合', plat: '全平台（含手机）', pay: '开源免费 + 会员',
    row: ['🔧', '🔧', '🔧', '✅A', '✅A', '✅A', '✅A', '✅A', '✅A', '✅'],
    best: '轻量、上手最快、手机端也有', tip: '配置一次 API Key 就能用，比 Cherry 更轻。' },
  { n: 'LobeChat', icon: '🗣️', type: '第三方聚合', plat: '网页（可自部署）', pay: '开源免费',
    row: ['🔧', '🔧', '🔧', '✅A', '✅A', '✅A', '✅A', '✅A', '🔧', '✅'],
    best: '要自部署、要插件市场和角色商店', tip: '插件生态丰富，可部署在自己服务器。' },
  { n: 'Open WebUI', icon: '🌐', type: '自部署 / 本地', plat: '网页（Docker 自部署）', pay: '开源免费',
    row: ['🔧', '🔧', '🔧', '✅A', '✅A', '✅A', '✅A', '✅A', '✅A', '✅'],
    best: '本地 Ollama + 团队内部部署', tip: '和 Ollama 是绝配，网页版 ChatGPT 的观感。' },
  { n: 'LM Studio', icon: '🖥️', type: '本地运行', plat: 'Win / Mac / Linux', pay: '免费',
    row: ['❌', '❌', '❌', '✅', '✅', '✅', '✅', '❌', '✅', '❌'],
    best: '图形界面跑本地开源模型，会自动按显存推荐', tip: '下载 GGUF 就能跑，还能开本地 API 服务给别的客户端用。' },
  { n: 'Ollama', icon: '🦙', type: '本地运行', plat: 'Win / Mac / Linux（命令行为主）', pay: '开源免费',
    row: ['❌', '❌', '❌', '✅', '✅', '✅', '✅', '❌', '✅', '❌'],
    best: '命令行党、要给别的程序提供本地模型服务', tip: '一行 `ollama run qwen3` 就跑，Open WebUI 的最佳搭档。' },
  { n: 'SillyTavern', icon: '🎭', type: '角色扮演专用', plat: 'Win / Mac / Linux / 安卓', pay: '开源免费',
    row: ['🔧', '🔧', '🔧', '✅A', '✅A', '✅A', '✅A', '✅A', '✅A', '✅'],
    best: '角色扮演、长对话记忆、酒馆卡', tip: 'RP 玩家标配，对上下文管理和角色卡支持最细。' },
  { n: 'Cursor', icon: '⌨️', type: 'IDE 编程', plat: 'Win / Mac / Linux', pay: '免费额度 + Pro($20/月)',
    row: ['✅', '✅', '✅', '✅', '✅', '✅', '✅', '✅', '✅', '✅'],
    best: 'AI 编程、整个仓库级别的理解和改写', tip: '可以配自己的 API Key，也支持本地模型。' },
  { n: 'OpenRouter 网页', icon: '🛰️', type: '聚合平台', plat: '网页', pay: '按 token 计费，部分免费',
    row: ['✅A', '✅A', '✅A', '✅A', '✅A', '✅A', '✅A', '✅A', '✅A', '✅'],
    best: '一个 Key 用 400+ 模型，比价、免费额度试用', tip: '它的 API 就是 OpenAI 兼容格式，任何支持自定义接口的客户端都能接。' },
  { n: 'WorkBuddy 智能体', icon: '🤖', type: '智能体 / Agent', plat: '桌面端（Windows / Mac）', pay: '内置额度 + 可配自己的 API Key',
    row: ['✅A', '✅A', '✅A', '✅A', '✅A', '✅A', '✅A', '✅A', '🔧', '✅'],
    best: '不挑模型直接下需求：写文档、做表格、做网页、查数据、定时任务，智能体自动调度模型和工具', tip: '智能体负责帮你路由/调用模型（也支持配自己的各家 API Key），附带文件系统、浏览器、桌面组件等工具能力，按内置额度或 token 计费。' },
  { n: 'OpenClaw（Claw 类）', icon: '🦞', type: '智能体 / Agent', plat: '本机部署（Win / Mac / Linux）', pay: '开源免费（模型 API 另算）',
    row: ['🔧', '🔧', '🔧', '🔧', '✅A', '✅A', '🔧', '🔧', '✅A', '✅'],
    best: '想要开源、跑在自己电脑上的全天候智能体，能接微信 / Telegram 等消息渠道', tip: 'OpenClaw 一类的开源智能体框架：本体免费，模型走你自己的 API Key（各家官方 API 或 OpenRouter），也支持接 Ollama 本地模型。' }
];

const COMBO = [
  { tag: '全能首选', title: 'Cherry Studio + OpenRouter', why: '一个客户端切换 400+ 模型，比价方便，还能接本地 Ollama。想"全都试一遍"就从这开始。' },
  { tag: '写代码', title: 'Cursor / Claude Code + Claude 或 GPT', why: '编程场景跑分和口碑最稳的两家；Cursor 能配自己的 Key，也能接本地模型。' },
  { tag: '零成本跑开源', title: 'LM Studio（图形界面）或 Ollama（命令行）+ Qwen / DeepSeek / Llama', why: 'LM Studio 会按你的显存自动推荐能跑的模型；模型去 HF 搜 GGUF 版本。' },
  { tag: '白嫖最强', title: 'Chatbox + OpenRouter 免费模型', why: 'OpenRouter 上带 :free 后缀的模型不要钱（有速率限制），配 Chatbox 手机上也能用。' },
  { tag: '中文写作 / 数学', title: 'DeepSeek / Kimi 官方 App', why: '免费、无需配置、中文场景口碑好；DeepSeek 的推理模式数学和代码强。' },
  { tag: '长文档 / 多模态', title: 'Gemini 官方', why: '上下文长度最大、能直接吃 PDF/图片/视频，和谷歌文档联动。' },
  { tag: '角色扮演', title: 'SillyTavern + DeepSeek / 开源微调模型', why: '酒馆卡生态 + 强角色扮演模型，上下文管理最细。' },
  { tag: '团队内部部署', title: 'Open WebUI + Ollama', why: 'Docker 一键起，网页观感像 ChatGPT，数据不出内网。' },
  { tag: '智能体代办', title: 'WorkBuddy 等智能体 + 多模型 API', why: '不用自己挑模型，直接说需求，智能体负责调度模型和工具；想指定模型或省钱就配上自己的 API Key。' }
];

/* ============================ 数据聚合 ============================ */
const RSS = [
  { src: 'OpenAI 官方', url: 'https://openai.com/news/rss.xml' },
  { src: 'The Verge · AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  { src: 'TechCrunch', url: 'https://techcrunch.com/feed/' },
  { src: 'Hacker News', url: 'https://hnrss.org/newest?q=LLM' }
];

const GH_REPOS = ['QwenLM/Qwen3', 'meta-llama/llama-models', 'deepseek-ai/DeepSeek-V3',
  'google-deepmind/gemma', 'mistralai/mistral-common', 'moonshotai/Kimi-K2', 'zai-org/GLM-4.5'];

/* 模型家族：用于从资讯标题统计"哪家最近动作多" */
const FAMILIES = [
  { key: 'OpenAI / GPT', re: /\b(gpt-?\d|openai|chatgpt|o[3-6]\b)/i },
  { key: 'Anthropic / Claude', re: /\b(claude|anthropic|sonnet|opus|haiku)\b/i },
  { key: 'Google / Gemini', re: /\b(gemini|deepmind|bard|google ai)\b/i },
  { key: 'Meta / Llama', re: /\b(llama|meta ai)\b/i },
  { key: '阿里 / Qwen', re: /\b(qwen|tongyi)\b/i },
  { key: 'DeepSeek', re: /\bdeepseek\b/i },
  { key: 'xAI / Grok', re: /\b(grok|\bxai\b)/i },
  { key: '月之暗面 / Kimi', re: /\b(kimi|moonshot)\b/i },
  { key: '智谱 / GLM', re: /\b(glm|zhipu)\b/i },
  { key: 'Mistral', re: /\bmistral\b/i },
  { key: 'Google / Gemma', re: /\bgemma\b/i },
  { key: 'MiniMax', re: /\bminimax\b/i },
  { key: '阶跃 / Step', re: /\b(stepfun|step-\d)/i },
  { key: '字节 / 豆包', re: /\b(doubao|bytedance|seed-\d)/i },
  { key: '微软 / Phi', re: /\b(phi-?\d|microsoft ai)\b/i },
  { key: 'Amazon / Nova', re: /\b(amazon nova|bedrock)\b/i }
];
/* 出现这些词 = 有"发布/预告"动作，而不只是被顺带提到 */
const SIGNAL = /\b(launch|announc|releas|unveil|preview|debut|rollout|teas|rumor|ship|upcoming|open[- ]?sourc)/i;

async function gather(force) {
  const out = {};
  const jobs = [];

  jobs.push(grabJSON('openrouter', 'https://openrouter.ai/api/v1/models', force ? 0 : 6 * 3600e3)
    .then(r => { out.models = r.ok ? { ok: true, stale: !!r.stale, cached: r.cached, data: normModels(r.data) } : { ok: false, error: r.error }; }));

  // HF 热度榜一次拿 100 条：前 18 做热度榜，再从中筛"最近三周冒头的"做新模型榜
  jobs.push(grabJSON('hf-trending', 'https://hf-mirror.com/api/models?sort=trendingScore&direction=-1&limit=100', force ? 0 : 3 * 3600e3)
    .then(r => {
      const all = (r.ok && Array.isArray(r.data)) ? r.data : [];
      out.hfTrend = { ...r, data: all.slice(0, 18) };
      const cut = Date.now() - 21 * 86400e3;
      const fresh = all.filter(m => m.createdAt && Date.parse(m.createdAt) >= cut)
                       .sort((a, b) => (b.trendingScore || 0) - (a.trendingScore || 0))
                       .slice(0, 15);
      out.hfNew = { ok: fresh.length > 0, stale: !!r.stale, data: fresh };
    }));

  // 汇率 USD→CNY（人民币价格换算用）
  jobs.push(grabJSON('usdcny', 'https://open.er-api.com/v6/latest/USD', force ? 0 : 12 * 3600e3)
    .then(r => {
      const cny = (r.ok && r.data && r.data.rates && r.data.rates.CNY) || null;
      out.rate = { ok: !!cny, stale: !!r.stale, usdCny: cny ? +cny.toFixed(4) : 6.7, updated: cny ? (r.data.time_last_update_utc || null) : null };
    }));

  jobs.push((async () => {
    // rss2json 免费接口不能并发（会被限流），必须串行抓
    const feeds = [];
    for (const f of RSS) {
      const r = await grabJSON('rss-' + f.src, 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(f.url), force ? 0 : 3600e3);
      feeds.push({ src: f.src, ...r });
      await new Promise(res => setTimeout(res, 700));
    }
    const items = [];
    feeds.forEach(f => {
      if (f.ok && f.data && f.data.items) f.data.items.forEach(it => items.push({
        title: it.title, link: it.link, date: it.pubDate ? new Date(it.pubDate).getTime() : null, src: f.src
      }));
    });
    items.sort((a, b) => (b.date || 0) - (a.date || 0));
    // 按模型家族统计热度 + 识别"发布/预告"信号
    const trend = {};
    items.forEach(it => {
      FAMILIES.forEach(f => {
        if (!f.re.test(it.title)) return;
        if (!trend[f.key]) trend[f.key] = { model: f.key, signal: false, hits: [] };
        const t = trend[f.key];
        if (SIGNAL.test(it.title)) t.signal = true;
        if (t.hits.length < 6) t.hits.push({ title: it.title, link: it.link, date: it.date, src: it.src });
      });
    });
    const upcoming = Object.values(trend)
      .sort((a, b) => (b.signal - a.signal) || (b.hits.length - a.hits.length))
      .slice(0, 16);
    out.news = { ok: items.length > 0, stale: feeds.some(f => f.stale), items: items.slice(0, 40), upcoming };
  })());

  jobs.push((async () => {
    const rels = await Promise.all(GH_REPOS.map(async repo => {
      const r = await grabJSON('gh-' + repo.replace('/', '_'), 'https://api.github.com/repos/' + repo + '/releases?per_page=3', force ? 0 : 6 * 3600e3);
      if (!r.ok || !Array.isArray(r.data)) return [];
      return r.data.map(x => ({ repo, tag: x.tag_name, name: x.name, date: x.published_at ? new Date(x.published_at).getTime() : null, url: x.html_url, body: (x.body || '').slice(0, 300) }));
    }));
    const flat = rels.flat().filter(x => x.date).sort((a, b) => b.date - a.date);
    out.releases = { ok: true, items: flat.slice(0, 20) };
  })());

  await Promise.all(jobs);
  out.updated = Date.now();
  out.endpoints = VENDOR_ENDPOINTS;   // 厂商网络接口速查（防遗忘）
  return out;
}

/* ============================ 任务画像加载（驱动「使用方案」页） ============================ */
/* 加载顺序：profile.local.mjs（本机专属，不进 Git）→ profile.example.mjs（仓库自带的通用示例）。
   把自己的画像写成 profile.local.mjs 即可覆盖，代码无需改动。 */
let planCache = null;   // { file, mtimeMs, data }
/* 按文件 mtime 热加载：改完 profile.local.mjs 不用重启服务，下次请求就是新的。
   （ESM 的 import 缓存会记住整个进程，所以给 URL 带上 mtime 当版本号；
    只有文件真的被改过才会产生新模块，不会每请求都堆一个模块。） */
async function loadPlan() {
  for (const f of ['./profile.local.mjs', './profile.example.mjs']) {
    const file = path.join(__dirname, f.replace(/^\.\//, ''));
    if (!fs.existsSync(file)) continue;
    const mt = fs.statSync(file).mtimeMs;
    try {
      if (planCache && planCache.file === f && planCache.mtimeMs === mt) return planCache.data;
      const mod = await import(f + '?m=' + mt);
      planCache = { file: f, mtimeMs: mt, data: mod.default };
      return planCache.data;
    } catch (e) { /* 换下一个 */ }
  }
  return planCache ? planCache.data : null;
}

/* ============================ 自动更新（启动即刷 + 定时轮询） ============================ */
/* 三档行为，都可以用环境变量覆盖（在 .cmd 里 set 即可，不用改代码）：
     AILENS_START_REFRESH = stale | always | off   启动策略，默认 stale
     AILENS_STALE_MIN     = stale 模式下的"缓存还算新"分钟数，默认 10
     AILENS_AUTO_HOURS    = 常驻期间定时重抓的间隔小时数，默认 6；设 0 关闭定时
   stale（默认）＝缓存超过 10 分钟就重抓，10 分钟内重启不重复拉；
   always              ＝每次启动都全量重抓（最"新"，但每次开机都要等 5–20 秒）。 */
const START_REFRESH = (process.env.AILENS_START_REFRESH || 'stale').toLowerCase();
const STALE_MS = Math.max(0, Number(process.env.AILENS_STALE_MIN || 10)) * 60e3;
const AUTO_MS = Math.max(0, Number(process.env.AILENS_AUTO_HOURS || 6)) * 3600e3;

const auto = { lastAt: 0, nextAt: 0, runs: 0, running: false, lastError: null, start: START_REFRESH, intervalH: AUTO_MS ? AUTO_MS / 3600e3 : 0 };
let inflight = null;

/* 并发锁：全量抓一次要几秒到十几秒，这期间任何请求都复用同一次结果，不并发重抓。
   启动预热没跑完时浏览器进来的首次请求也会等到这一次完成 —— 打开即最新，且只抓一次。 */
function refresh(force) {
  if (inflight) return inflight;
  auto.running = true;
  inflight = gather(force)
    .then(d => {
      auto.lastAt = Date.now();
      auto.nextAt = AUTO_MS ? auto.lastAt + AUTO_MS : 0;
      auto.runs++; auto.lastError = null;
      return d;
    })
    .catch(e => { auto.lastError = String(e.message || e); throw e; })
    .finally(() => { auto.running = false; inflight = null; });
  return inflight;
}

/* 主缓存（模型价格表）的年龄 —— 用来判断启动时值不值得重抓 */
function cacheAge(name) {
  const f = cachePath(name);
  return fs.existsSync(f) ? Date.now() - fs.statSync(f).mtimeMs : Infinity;
}
const hhmm = t => new Date(t).toTimeString().slice(0, 5);

async function bootRefresh() {
  if (START_REFRESH === 'off') { console.log('自动更新：已关闭（AILENS_START_REFRESH=off）'); return; }
  const age = cacheAge('openrouter');
  if (START_REFRESH === 'stale' && age < STALE_MS) {
    console.log('自动更新：缓存仍是新的（' + Math.round(age / 60e3) + ' 分钟前抓过），本次启动不重复拉取。');
    console.log('           想每次启动都重抓 → 在启动命令里设 AILENS_START_REFRESH=always');
    return;
  }
  console.log('自动更新：正在拉取最新数据…（约 5–20 秒，期间打开面板会等这一次结果）');
  try {
    const d = await refresh(true);
    const n = (d.models && d.models.ok && d.models.data.length) || 0;
    const nw = (d.news && d.news.items) ? d.news.items.length : 0;
    console.log('自动更新：完成 ✓ 模型 ' + n + ' 个、资讯 ' + nw + ' 条');
  } catch (e) {
    console.log('自动更新：失败，自动降级到上次缓存 —— ' + (e.message || e));
  }
}

/* 常驻期间定时重抓：服务开着就会一直保持数据新鲜，不用手动点刷新 */
if (AUTO_MS) {
  setInterval(() => {
    console.log('[' + hhmm(Date.now()) + '] 定时自动更新（每 ' + auto.intervalH + ' 小时）…');
    refresh(true)
      .then(() => console.log('[' + hhmm(Date.now()) + '] 定时更新完成 ✓'))
      .catch(e => console.log('[' + hhmm(Date.now()) + '] 定时更新失败，继续用缓存 —— ' + (e.message || e)));
  }, AUTO_MS);
}

/* ============================ 画像：备份 / 还原 / 重算（界面按钮用） ============================ */
/* 只认 profile.local*.mjs，且只在 backups\ 目录里读写 —— 不做任意文件操作。 */
const BACKUP_DIR = path.join(__dirname, 'backups');
const PROFILE_FILE = path.join(__dirname, 'profile.local.mjs');
const SAFE_NAME = /^profile\.local[\w.\-]*\.mjs$/;
fs.mkdirSync(BACKUP_DIR, { recursive: true });

const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };

/* 复制后把时间改成"现在"：Windows 的 CopyFile 会沿用源文件的 mtime，
   否则多份备份显示成同一时刻，排序和「还原到哪一份」都会失真。 */
function copyAsNew(src, dst) {
  fs.copyFileSync(src, dst);
  const t = new Date();
  try { fs.utimesSync(dst, t, t); } catch (e) {}
}

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter(f => SAFE_NAME.test(f)).map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, mtime: st.mtimeMs, size: st.size };
    }).sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
}
function readBody(req) {
  return new Promise(r => {
    let s = '';
    req.on('data', c => { s += c; });
    req.on('end', () => { try { r(JSON.parse(s || '{}')); } catch (e) { r({}); } });
  });
}
function json(res, obj, code) {
  res.writeHead(code || 200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/* ============================ HTTP 服务 ============================ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p === '/api/all') {
    const force = u.searchParams.get('refresh') === '1';
    try {
      const data = await refresh(force);
      // 自动更新的状态一并返回，前端顶部据此显示「下次自动更新时间」
      data.auto = { start: auto.start, intervalH: auto.intervalH, lastAt: auto.lastAt || null, nextAt: auto.nextAt || null, running: auto.running, runs: auto.runs, lastError: auto.lastError };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  if (p === '/api/plan') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(await loadPlan()));
    return;
  }

  /* ---- 画像备份 / 还原 / 重算 ---- */
  if (p === '/api/profile/backups') {
    json(res, { ok: true, dir: BACKUP_DIR, backups: listBackups() });
    return;
  }

  if (p === '/api/profile/backup' && req.method === 'POST') {
    if (!fs.existsSync(PROFILE_FILE)) { json(res, { ok: false, error: '还没有 profile.local.mjs' }, 404); return; }
    try {
      const name = 'profile.local-' + stamp() + '.mjs';
      copyAsNew(PROFILE_FILE, path.join(BACKUP_DIR, name));
      json(res, { ok: true, name, backups: listBackups() });
    } catch (e) { json(res, { ok: false, error: String(e.message || e) }, 500); }
    return;
  }

  if (p === '/api/profile/restore' && req.method === 'POST') {
    const body = await readBody(req);
    const name = (body && body.name) || '';
    if (!SAFE_NAME.test(name)) { json(res, { ok: false, error: '备份文件名不合法' }, 400); return; }
    const src = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(src)) { json(res, { ok: false, error: '备份不存在：' + name }, 404); return; }
    try {
      // 还原前先把当前这份存档，免得还原错了再也回不去
      if (fs.existsSync(PROFILE_FILE)) copyAsNew(PROFILE_FILE, path.join(BACKUP_DIR, 'profile.local-autosave-' + stamp() + '.mjs'));
      copyAsNew(src, PROFILE_FILE);   // 顺带把 mtime 刷成现在，确保热加载一定触发
      json(res, { ok: true, restored: name, backups: listBackups() });
    } catch (e) { json(res, { ok: false, error: String(e.message || e) }, 500); }
    return;
  }

  if (p === '/api/profile/rescan' && req.method === 'POST') {
    const body = await readBody(req);
    const mode = (body && body.mode) === 'write' ? 'write' : 'dry';
    const args = [path.join(__dirname, 'profile-scan.mjs')];
    args.push(mode === 'dry' ? '--dry' : '--no-bak');         // 界面写入前已自行备份，不让脚本再盖 .bak
    try {
      const r = spawnSync(process.execPath, args, { cwd: __dirname, encoding: 'utf8', timeout: 90000 });
      json(res, { ok: r.status === 0, code: r.status, mode, out: (r.stdout || '') + (r.stderr || '') });
    } catch (e) { json(res, { ok: false, error: String(e.message || e) }, 500); }
    return;
  }

  if (p === '/api/clients') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ fams: FAMS, clients: CLIENTS, combo: COMBO }));
    return;
  }

  let file = p === '/' ? '/index.html' : p;
  const abs = path.join(ROOT, path.normalize(file).replace(/^([.][.][/\\])+/, ''));
  if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(abs, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream') });
    res.end(buf);
  });
});

/* 端口被占说明服务已经在跑了，直接退出（不要挪端口，否则浏览器会连到旧实例） */
let port = PORT;
function listen(p) {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.log('端口 ' + p + ' 已被占用，AI 模型雷达应该已经在运行了，本实例退出。');
      process.exit(0);
    }
    console.error('启动失败:', e.message);
    process.exit(1);
  });
  server.listen(p, () => {
    console.log('AI 模型雷达服务已启动 → http://localhost:' + p);
    if (AUTO_MS) console.log('定时自动更新：每 ' + auto.intervalH + ' 小时重抓一次（AILENS_AUTO_HOURS 可改）');
    console.log('（关闭本窗口即停止服务）');
    // 先监听、再抓：浏览器打开时若这次还没抓完，会复用同一次结果，不会并发抓两遍
    bootRefresh();
  });
}
listen(port);
