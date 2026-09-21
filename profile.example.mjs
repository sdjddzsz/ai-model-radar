/**
 * 任务画像 · 通用示例
 *
 * 「🧭 使用方案」页的数据来源：描述你平时拿大模型干什么，雷达据此结合实时价格算出
 *   每个任务该用谁、备胎是谁、一个月花多少钱。
 *
 * ── 怎么换成你自己的 ────────────────────────────────────
 * 1. 复制本文件为 `profile.local.mjs`（该文件名已在 .gitignore 中，不会被提交）
 * 2. 改成你自己的任务列表
 * 3. 重启服务 —— 服务端优先加载 profile.local.mjs，找不到才用本文件
 * ────────────────────────────────────────────────────────
 *
 * 字段说明：
 *   needCtx      该任务通常需要多大的上下文窗口（tokens）
 *   need         硬性能力要求：tools=能否调工具 / reasoning=是否需要推理 / vision=是否要读图
 *   callsPerDay  日均调用次数        inputTok / outputTok  单次输入输出 token 数
 *   cacheHit     预计缓存命中率（系统提示重复越多越高，会显著影响成本）
 *   privacy      high=隐私内容，不会路由到免费第三方端点
 *   priceWeight  省钱权重（0~1），越高越倾向便宜模型
 */
export default {
  generated: '2026-09-21',
  sources: ['通用示例数据 —— 复制成 profile.local.mjs 后可替换为你自己的任务画像'],
  profile: {
    langMix: '按自己情况写：例如「中文为主」「中英各半」',
    peakPattern: '按自己情况写：例如「白天连续长会话 → 系统提示重复 → 缓存命中率高」',
    budget: '按自己情况写：例如「预算敏感，优先免费额度」',
    privacy: '按自己情况写：例如「合同与客户资料属隐私，不走免费端点」'
  },
  tasks: [
    { key:'batch', icon:'🔍', name:'批量文本抽取 / 信息归类', freq:'高频·批量',
      evidence:['示例：需要整理成表格的一批文本或截图'],
      needCtx:32000, need:{ tools:true, reasoning:false, vision:true },
      callsPerDay:20, inputTok:4000, outputTok:800, cacheHit:0.35,
      privacy:'low', cnStrong:false, priceWeight:0.9,
      note:'典型脏活：量大、结构固定、容错高。丢给最便宜的模型就行，用旗舰纯属浪费。' },

    { key:'chat', icon:'💬', name:'日常问答 / 概念解释', freq:'高频',
      evidence:['示例：每天的大量短提问'],
      needCtx:8000, need:{ tools:false, reasoning:false, vision:false },
      callsPerDay:12, inputTok:800, outputTok:600, cacheHit:0.1,
      privacy:'low', cnStrong:false, priceWeight:0.95,
      note:'占调用次数大头，单次便宜但胜在量大 —— 应该整个路由到最便宜的一档。' },

    { key:'agent', icon:'🤖', name:'长流程 Agent / 多步编排', freq:'高频',
      evidence:['示例：需要连续调用多个工具才完成的任务'],
      needCtx:200000, need:{ tools:true, reasoning:true, vision:true },
      callsPerDay:15, inputTok:20000, outputTok:3000, cacheHit:0.7,
      privacy:'mid', cnStrong:false, priceWeight:0.4,
      note:'系统提示和工具定义每轮重复发送 → 缓存命中率能到 70%。这时选「缓存命中价低」的厂商比选「标价低」的更省钱。' },

    { key:'paper', icon:'📚', name:'长文档精读 / 深度讲解', freq:'中频',
      evidence:['示例：几十页 PDF、需要逐节讲解的资料'],
      needCtx:128000, need:{ tools:false, reasoning:true, vision:false },
      callsPerDay:4, inputTok:12000, outputTok:3000, cacheHit:0.5,
      privacy:'low', cnStrong:false, priceWeight:0.3,
      note:'真正需要「强推理 + 长上下文」的任务，理解错了代价最大，别在这上面省钱。' },

    { key:'code', icon:'🧮', name:'代码答疑与调试', freq:'中频',
      evidence:['示例：练习代码、报错排查'],
      needCtx:32000, need:{ tools:true, reasoning:true, vision:false },
      callsPerDay:10, inputTok:2000, outputTok:1500, cacheHit:0.3,
      privacy:'low', cnStrong:false, priceWeight:0.55,
      note:'要能正确产出 function calling 的 JSON；代码能力比文笔重要。' },

    { key:'tool', icon:'🧰', name:'小工具 / 整段程序生成', freq:'中频',
      evidence:['示例：一次性生成的页面或脚本'],
      needCtx:64000, need:{ tools:true, reasoning:true, vision:false },
      callsPerDay:6, inputTok:8000, outputTok:4000, cacheHit:0.4,
      privacy:'low', cnStrong:false, priceWeight:0.5,
      note:'要整文件改写 → 吃上下文、吃输出。模型一弱就写出跑不起来的代码，建议给到中上档。' },

    { key:'write', icon:'📄', name:'文书改写 / 润色', freq:'高频',
      evidence:['示例：需要改写的文稿'],
      needCtx:32000, need:{ tools:false, reasoning:false, vision:false },
      callsPerDay:6, inputTok:2500, outputTok:1200, cacheHit:0.2,
      privacy:'high', cnStrong:true, priceWeight:0.45,
      note:'标记为 high 隐私后不会被路由到免费端点（免费端点可能留存 prompt）。' },

    { key:'data', icon:'📊', name:'数据清洗 / 表格归纳', freq:'中频·批量',
      evidence:['示例：待整理的导出数据'],
      needCtx:32000, need:{ tools:true, reasoning:false, vision:false },
      callsPerDay:8, inputTok:5000, outputTok:1000, cacheHit:0.3,
      privacy:'low', cnStrong:false, priceWeight:0.85,
      note:'结构化输出为主，便宜模型完全够。' },

    { key:'trans', icon:'🌐', name:'翻译 / 外语材料', freq:'中频',
      evidence:['示例：需要翻译或改写的材料'],
      needCtx:16000, need:{ tools:false, reasoning:false, vision:false },
      callsPerDay:5, inputTok:1500, outputTok:1000, cacheHit:0.1,
      privacy:'low', cnStrong:false, priceWeight:0.9,
      note:'轻量任务，交给小模型或直接白嫖 App 免费额度。' },

    { key:'conv', icon:'🗂', name:'文档格式转换', freq:'低频',
      evidence:['示例：md / html / pdf 互转'],
      needCtx:8000, need:{ tools:true, reasoning:false, vision:false },
      callsPerDay:3, inputTok:1000, outputTok:300, cacheHit:0,
      privacy:'mid', cnStrong:true, priceWeight:1.0,
      note:'几乎不需要模型 —— 转换是脚本活。真要模型介入也只是排版微调，最小档即可。' }
  ]
};
