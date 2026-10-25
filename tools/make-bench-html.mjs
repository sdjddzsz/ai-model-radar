import fs from 'fs';
const src = 'D:/WorkBuddy/AILens/bench-results.json';
const out = 'D:/WorkBuddy/output/模型实测排名_20261002.html';
const rows = JSON.parse(fs.readFileSync(src, 'utf8'));

const TIER_COLOR = { 强: '#0a7d3f', 中上: '#1a6fb5', 中: '#8a6d1a', 弱: '#a8510a', 零: '#a01c1c', 未测: '#666' };
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const tr = rows.map(r => {
  const pct = r.scorePct == null ? '未测' : r.scorePct + '%';
  const ins = (r.answeredTotal ?? 0) < 6;
  const note = ins ? `<span class="warn">⚠ 样本不足（仅答 ${r.answeredTotal}/10）</span>` : '';
  return `      <tr>
        <td class="pct">${pct}</td>
        <td><span class="tier" style="background:${TIER_COLOR[r.tier.tier] || '#666'}">${esc(r.tier.tier)}</span></td>
        <td>${r.mathPct ?? '-'}</td>
        <td>${r.codePct ?? '-'}</td>
        <td class="${ins ? 'lo' : ''}">${r.answeredTotal ?? 0}/10</td>
        <td>${r.avgMs}ms</td>
        <td class="model">${esc(r.model)} ${note}</td>
      </tr>`;
}).join('\n');

const n = rows.length;
const ins = rows.filter(r => (r.answeredTotal ?? 0) < 6).length;
const strong = rows.filter(r => r.tier.tier === '强').length;

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>模型能力实测排名 ${new Date().toISOString().slice(0, 10)}</title>
<style>
  body{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;margin:32px;background:#fff;color:#1a1a1a}
  h1{font-size:20px;margin:0 0 4px}
  .meta{color:#666;font-size:13px;margin-bottom:18px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{padding:7px 10px;border-bottom:1px solid #e5e5e5;text-align:left}
  th{background:#f6f6f6;font-weight:600;font-size:12px;color:#555}
  td.num{font-variant-numeric:tabular-nums}
  .pct{font-weight:700;font-variant-numeric:tabular-nums}
  .tier{color:#fff;padding:2px 8px;border-radius:10px;font-size:12px}
  .model{font-family:ui-monospace,Consolas,monospace;font-size:12px}
  .warn{color:#a01c1c;font-size:11px;margin-left:6px}
  .lo{color:#a01c1c;font-weight:600}
  tbody tr:hover{background:#fafafa}
  .note{margin-top:18px;font-size:12px;color:#666;line-height:1.7}
</style></head><body>
<h1>模型能力实测排名 · ${n} 个模型</h1>
<div class="meta">题库：数学推导 5 题 + 代码理解/重构 5 题（标准答案均经 Python 独立验算）· 满分档 ${strong} 个 · 样本不足 ${ins} 个（限流导致，非能力结论）</div>
<table>
  <thead><tr><th>分数</th><th>档位</th><th>数学%</th><th>代码%</th><th>实答</th><th>平均速度</th><th>模型</th></tr></thead>
  <tbody>
${tr}
  </tbody>
</table>
<div class="note">
  <b>口径说明：</b>分数 = 数学校准% 与代码校准% 的平均；分母用<b>实际作答</b>题数（限流/超时跳过的不计入），
  因此限流不会把模型误判成 0 分。实答 &lt; 6 题的按规则压档并标注「样本不足」，不进强档判定。<br>
  <b>档位：</b>强=≥90（论文级推导/大型重构）· 中上=≥70 · 中=≥50 · 弱=≥30 · 零=&lt;30。
</div>
</body></html>`;

fs.mkdirSync('D:/WorkBuddy/output', { recursive: true });
fs.writeFileSync(out, html, 'utf8');
console.log('written:', out, '| rows:', n, '| 强:', strong, '| 样本不足:', ins);
