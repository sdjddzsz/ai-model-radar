/* 回归测试：peekErrorEnvelope（2026-10-07 新增的「HTTP 200 包裹错误信封」探测）
   做法：从 llm-gateway.mjs 里按大括号配对**抽出真实函数源码**再 eval —— 测的是线上那份代码，不是副本。
   判据（两条都必须过）：
     ① 命中：流式/非流式两种信封形态都要被识别出 err
     ② 不误伤：正常响应必须 err=null，且「接回」后的字节与原始字节完全一致（不能丢正文）
   跑法：node tools/test-error-envelope.mjs */
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', 'llm-gateway.mjs'), 'utf8');
const anchor = 'async function peekErrorEnvelope(';
const i = SRC.indexOf(anchor);
if (i < 0) { console.error('找不到 peekErrorEnvelope，源码结构变了'); process.exit(1); }
/* 用紧随其后的哨兵行定位结尾 —— 不能按大括号配对：函数体里有正则字面量 /"choices"\s*:\s*\[\s*\{/，
   里面的 { 会被误当成开括号导致提取越界（第一次就踩了）。 */
const tail = SRC.indexOf('\n  let upRes = null;', i);
if (tail < 0) { console.error('找不到函数结尾哨兵，源码结构变了'); process.exit(1); }
const fnSrc = SRC.slice(i, tail).trimEnd();
const peekErrorEnvelope = eval('(' + fnSrc + ')');
console.log('已从源码抽出 ' + fnSrc.split('\n').length + ' 行真实实现\n');

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + name + (extra ? '  ' + extra : '')); ok ? pass++ : fail++; };

/* 把一段文本包成「像 Response」的对象。
   ★★ 2026-10-08 改：body 必须用**真实 ReadableStream**，不能再用异步生成器。
   起因：生成器的 [Symbol.asyncIterator]() 不锁定、可重复迭代 → 掩盖了真 bug
   （「先取迭代器、再用 body 迭代」→ ERR_INVALID_STATE: ReadableStream is locked → err 静默为 null）。
   换成真实流后，凡是有锁定语义错误的实现都会被这套测试直接抓出来。 */
function fakeResp(text, { chunkSize = 64, ok = true, status = 200, ctype = 'text/event-stream' } = {}) {
  const buf = Buffer.from(text, 'utf8');
  const parts = [];
  for (let o = 0; o < buf.length; o += chunkSize) parts.push(buf.subarray(o, o + chunkSize));
  let idx = 0;
  return {
    ok, status, headers: new Headers({ 'content-type': ctype }),
    body: new ReadableStream({
      pull(c) { if (idx >= parts.length) c.close(); else c.enqueue(new Uint8Array(parts[idx++])); }
    })
  };
}
async function drain(res) { const out = []; if (!res.body) return null; for await (const c of res.body) out.push(Buffer.from(c)); return Buffer.concat(out).toString('utf8'); }

/* ---- 构造样本：形态抄自 2026-10-07 实测复现 ---- */
const SSE_OK = ': OPENROUTER PROCESSING\n\ndata: {"id":"gen-1","object":"chat.completion.chunk","model":"m","provider":"Nvidia","choices":[{"index":0,"delta":{"content":"你好","role":"assistant"},"finish_reason":null}]}\n\ndata: {"id":"gen-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const SSE_ENV = 'data: {"id":"gen-x","object":"chat.completion.chunk","created":1,"model":"nvidia/nemotron-3-ultra-550b-a55b:free","provider":"Nvidia","choices":[],"error":{"code":503,"message":"Upstream error from Nvidia: Service temporarily overloaded"}}\n\n';
const SSE_ENV_AFTER_COMMENTS = ': OPENROUTER PROCESSING\n\n: OPENROUTER PROCESSING\n\n' + SSE_ENV;
const JSON_OK = '{"id":"gen-2","object":"chat.completion","model":"m","choices":[{"index":0,"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}';
const JSON_ENV = '\n         \n\n         \n{"id":"gen-y","error":{"message":"Upstream error from Nvidia: Service temporarily overloaded","code":503,"metadata":{"error_type":"provider_overloaded"}}}';

console.log('① 命中检测');
for (const [name, text, stream] of [['流式信封（首块即错误）', SSE_ENV, true], ['流式信封（前面有 : 注释行）', SSE_ENV_AFTER_COMMENTS, true], ['非流式信封（前面有空白）', JSON_ENV, false]]) {
  const r = await peekErrorEnvelope(fakeResp(text, { ctype: stream ? 'text/event-stream' : 'application/json' }), stream);
  check(name, !!r.err, 'err=' + JSON.stringify(r.err));
}
console.log('\n② 不误伤 + 字节不丢');
for (const [name, text, stream] of [['正常流式 SSE', SSE_OK, true], ['正常非流式 JSON', JSON_OK, false]]) {
  const r = await peekErrorEnvelope(fakeResp(text, { ctype: stream ? 'text/event-stream' : 'application/json' }), stream);
  const back = await drain(r.res);
  check(name + ' err=null', !r.err, 'err=' + JSON.stringify(r.err));
  check(name + ' 字节完整（缓冲后接回）', back === text, back === text ? '' : '长度 ' + (back ? back.length : 'null') + ' vs ' + text.length);
}
console.log('\n③ 分块边界：错误块被切成 8 字节的小块也要能认出来');
{
  const r = await peekErrorEnvelope(fakeResp(SSE_ENV, { chunkSize: 8, ctype: 'text/event-stream' }), true);
  check('碎片化流式信封', !!r.err, 'err=' + JSON.stringify(r.err));
}
console.log('\n④ 真实上游（活体，可能拿到正常流也可能拿到信封，两种都必须判对）');
{
  const KEY = fs.readFileSync(path.join(import.meta.dirname, '..', 'gateway.key'), 'utf8').trim();
  let hit = 0, normal = 0, bad = 0;
  for (let n = 1; n <= 5; n++) {
    const up = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'X-Title': 'envelope-test' },
      body: JSON.stringify({ model: 'nvidia/nemotron-3-ultra-550b-a55b:free', models: ['nvidia/nemotron-3-ultra-550b-a55b:free'], messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.timeout(30000)
    });
    const r = await peekErrorEnvelope(up, true);
    const back = await drain(r.res);
    if (r.err) {
      hit++;
      if (back !== null) { bad++; console.log('     #' + n + ' 信封命中但 body 未置空（不应发生）'); }
      else console.log('     #' + n + ' 信封命中 ✅ err=' + r.err.slice(0, 60));
    } else {
      normal++;
      const looksOK = back && back.includes('data:') && !/"error":\{/.test(back);
      if (!looksOK) { bad++; console.log('     #' + n + ' 判为正常但内容可疑: ' + String(back).slice(0, 120)); }
      else console.log('     #' + n + ' 正常流，正文接回 ' + back.length + ' 字节 ✅');
    }
  }
  check('活体 5 发全部判对', bad === 0, '命中信封 ' + hit + ' / 正常 ' + normal + ' / 误判 ' + bad);
}

console.log('\n⑤ 变异测试：把源码改回「错写法」，本测试必须能抓出来（否则说明测试是假绿）');
{
  /* 把非流式分支的 `of it` 换回 `of resp.body`（就是 10-08 那个真 bug 的写法）。 */
  const BAD = 'for await (const c of resp.body) pre.push(c);';
  if (!fnSrc.includes('for await (const c of it) pre.push(c);')) {
    check('变异测试可执行（源码里能找到目标行）', false, '找不到 `for await (const c of it) pre.push(c);`，源码结构变了');
  } else {
    const mutated = fnSrc.replace('for await (const c of it) pre.push(c);', BAD);
    const badFn = eval('(' + mutated + ')');
    /* 变异后：真实 ReadableStream 会抛 ERR_INVALID_STATE → 被 catch 吞掉 → err 应为 null（=检测失效） */
    const rEnv = await badFn(fakeResp(JSON_ENV, { chunkSize: 64, ctype: 'application/json' }), false);
    check('变异版本确实漏检非流式信封（证明这条路径被真覆盖）', !rEnv.err, 'err=' + JSON.stringify(rEnv.err));
    /* 反向确认变异是"精准"的：流式那条路径不该被这次替换影响，仍应命中 */
    const rStream = await badFn(fakeResp(SSE_ENV, { chunkSize: 64, ctype: 'text/event-stream' }), true);
    check('变异版本仍能命中流式信封（说明只破坏了非流式那一条路径）', !!rStream.err, 'err=' + JSON.stringify(rStream.err));
  }
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
