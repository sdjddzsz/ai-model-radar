/* 长上下文活体验证（2026-10-08）
   目的：确认「HTTP 200 包裹错误信封」在**非流式**路径上也能被识别（修 ReadableStream 锁定 bug 后的端到端验证）。
   期望：prompt 估算 > 200k tok → why = longctx-1M（因为 longctx-pro 的 deepseek-v4-pro-0813 已被 isHealthy 判死）
        且客户端拿到的是**真实正文**，不是 {"message":"Upstream error ... ","code":503} 这种信封。
   跑法：node tools/test-longctx-live.mjs */
const filler = '以下是一段用于占位的长文本，请忽略其中的具体语义，只需在最后回答一个问题。'.repeat(1);
let prompt = '';
while (prompt.length < 300000) prompt += filler + '（第' + prompt.length + '字符）';
prompt += '\n\n请用一句话回答：1+1 等于几？';

console.log('prompt 长度 = ' + prompt.length + ' 字符');

const t0 = Date.now();
const r = await fetch('http://127.0.0.1:9999/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: prompt }], max_tokens: 64 }),
  signal: AbortSignal.timeout(240000)
});
const txt = await r.text();
const ms = Date.now() - t0;
console.log('HTTP=' + r.status + '  ' + ms + 'ms  bytes=' + txt.length);
let j = null; try { j = JSON.parse(txt); } catch {}
const isEnvelope = !!(j && j.error) || /"error"\s*:\s*\{/.test(txt);
console.log('判为错误信封 = ' + isEnvelope);
console.log('model 字段 = ' + (j && j.model ? j.model : '(无)'));
const answered = !!(j && j.choices && j.choices[0] && j.choices[0].message && typeof j.choices[0].message.content === 'string' && j.choices[0].message.content.trim());
console.log('拿到正文 = ' + answered + (answered ? '  →  ' + j.choices[0].message.content.slice(0, 80).replace(/\n/g, ' ') : ''));
console.log('\n原始响应前 400 字符：\n' + txt.slice(0, 400));
process.exit(isEnvelope ? 1 : 0);
