/* 分类器选型基准：找「输入短、输出极短、不乱思考、调用稳定」的 OpenRouter 模型。
   用法：node tools/bench-classifier.mjs  （不带参数跑内置回归集） */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

let KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
  try { KEY = execSync('reg query HKCU\\Environment /v OPENROUTER_API_KEY', { encoding: 'utf8' }).match(/REG_SZ\s+(\S+)/)[1]; }
  catch { KEY = fs.readFileSync('D:/WorkBuddy/AILens/gateway.key', 'utf8').trim(); }
}
const URL_ = 'https://openrouter.ai/api/v1/chat/completions';

const SYS =
  '你是任务分类器。根据用户请求判断属于哪一类，只输出一个英文标签，不要解释。\n' +
  '看用户真正想达成什么，按主要目标归类，混杂意图取主要那个。\n' +
  '标签集：adb(手机/模拟器点击滑动截图/控件树/包名) math(数学定理证明习题) paper(论文文献精读综述) ' +
  'board(看板工作台排期台账) resume(简历求职文书) jd(岗位JD分析) apply(投递话术跟进) ' +
  'envops(环境安装配置权限排查) code(代码调试算法刷题) data(数据清洗校对) site(网页部署上线) ' +
  'tool(写脚本小工具) agent(多步编排流水线) misc(纯翻译润色或无法归类)\n' +
  '注意：只是提到「翻译/润色」这个词不等于要翻译（例：「为什么这句被判成翻译润色」→ 按真实主题归类）；' +
  'misc 只用于真正的语言转换或实在归不进去的请求。';

/* 回归集：EXPECT 是人工标注的正确标签（按 TASK_ENTRY 的语义，不是按关键词） */
const CASES = [
  ['帮我看看这段python脚本为什么报语法错误', 'code'],
  ['把这个中文段落翻译成英文', 'misc'],
  ['总结一下今天的工作台进度', 'board'],
  ['解释一下测度空间里可测集的证明思路', 'math'],
  ['在小米模拟器上打开设置应用并截图', 'adb'],
  ['帮我看下这个网关上次的日志为什么分类错了', 'envops'],
  ['分析一下这段拓扑教材的内容', 'paper'],
  ['把这几段 CSV 的重复条目清洗掉', 'data'],
  ['简历里的自我评价帮我改一版', 'resume'],
  ['帮我把这个网页部署上线', 'site'],
  ['这段 JD 里要求的技术栈我们缺哪些', 'jd'],
  ['帮我写个批处理脚本把这些文件改名', 'tool'],
  ['帮我看下这个学期的六级什么时候报名', 'misc'],
  ['投递进度表该更新了', 'apply'],
  ['openrouter 上有哪些便宜的 coding 模型', 'misc'],
];

const CANDIDATES = [
  'inclusionai/ling-3.0-flash-sante:free',
  'meta-llama/llama-3.3-70b-instruct',
  'google/gemini-2.5-flash',
  'openai/gpt-4o-mini',
  'mistralai/mistral-small-3.1-24b-instruct',
  'qwen/qwen3-8b',
  'nvidia/llama-3.1-nemotron-70b-instruct',
  'deepseek/deepseek-chat',
];

const PREFILL = { role: 'assistant', content: '标签：' };

async function bench(model) {
  const lat = [];
  let parse = 0, correct = 0, reasoningUsed = 0, truncated = 0;
  const errs = {};   /* ★ 按状态码归类：403 地区限制 / 404 下架 / 429 限流 结论完全不同，
                       混成「报错 N 次」会误判好模型不可用 —— 这是 10-01 探针教训的复刻 */
  for (const [q, want] of CASES) {
    const t0 = Date.now();
    try {
      const r = await fetch(URL_, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'HTTP-Referer': 'https://localhost:8765', 'X-Title': 'AILens bench' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: SYS }, { role: 'user', content: '用户请求：' + q }, PREFILL],
          max_tokens: 64, temperature: 0
        }),
        signal: AbortSignal.timeout(25000)
      });
      const j = await r.json();
      lat.push(Date.now() - t0);
      if (!r.ok) { const k = r.status + ':' + String(j?.error?.message || '').slice(0, 45); errs[k] = (errs[k] || 0) + 1; continue; }
      const ch = j.choices?.[0];
      const raw = String(ch?.message?.content || '').toLowerCase();
      if ((ch?.message?.reasoning_content || '').trim()) reasoningUsed++;
      if (ch?.finish_reason === 'length') truncated++;
      const KEYS = ['adb', 'math', 'paper', 'board', 'resume', 'jd', 'apply', 'envops', 'code', 'data', 'site', 'tool', 'agent', 'misc'];
      const hit = KEYS.find(k => raw.includes(k));
      if (hit) { parse++; if (hit === want) correct++; }
      else if (!errs && process.env.VERBOSE) console.log('   [' + model + '] 未解析: ' + JSON.stringify(raw.slice(0, 40)));
    } catch (e) { const k = 'NET:' + e.message.slice(0, 45); errs[k] = (errs[k] || 0) + 1; }
  }
  lat.sort((a, b) => a - b);
  const n = CASES.length;
  const errTotal = Object.values(errs).reduce((a, b) => a + b, 0);
  return {
    model, parse: (parse / n * 100).toFixed(0) + '%', correct: (correct / n * 100).toFixed(0) + '%',
    med: (lat[Math.floor(lat.length / 2)] ?? '-') + 'ms', max: (lat[lat.length - 1] ?? '-') + 'ms',
    think: reasoningUsed, trunc: truncated, err: errTotal,
    why: Object.entries(errs).map(([k, v]) => v + '×' + k).join(' | ')
  };
}

console.log('候选模型 = ' + CASES.length + ' 条回归集\n');
const rows = [];
for (const m of CANDIDATES) rows.push(await bench(m));
console.log('模型'.padEnd(42) + '可解析  准确率  中位延迟  最大延迟  乱思考  截断  报错  错误详情');
for (const r of rows) {
  console.log(
    r.model.padEnd(42) +
    r.parse.padStart(5) + r.correct.padStart(8) + r.med.padStart(10) + r.max.padStart(9) +
    String(r.think).padStart(8) + String(r.trunc).padStart(6) + String(r.err).padStart(6) +
    '  ' + r.why
  );
}
