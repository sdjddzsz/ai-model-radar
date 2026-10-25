/**
 * 网关看门狗（单次执行，由计划任务 AILensGatewayWatch 每分钟调起）
 * Cherry / WorkBuddy 开着 && 网关 9999 没响应 → 后台拉起网关
 * 网关自己会在两个 App 都关 2 分钟后退出 —— 这里只负责"拉起"，不负责杀
 *
 * ★★ 2026-10-03 19:10 兼任 8765 主面板看门狗：
 *   起因：本来给 8765 单独建了 AILensPanelWatch 计划任务，但**每分钟闪一次控制台窗口**。
 *   试过两种隐藏方式都无效（Task Scheduler 的 Settings.Hidden=True 对交互式会话里的
 *   控制台程序不可靠；改成 powershell -WindowStyle Hidden + Start-Process 仍会闪）。
 *   ★ 结论：**不再新建任务**，把 8765 的探活/拉起并进本看门狗 ——
 *     它的入口 `wscript.exe → gateway-watch.vbs` 里 `Run(..., 0, False)` 的 0 = 隐藏窗口，
 *     那个任务实测从不闪。复用已验证的隐藏入口，比再想新花样可靠。
 *   AILensPanelWatch 任务已删除（改用本文件后它就是多余的第二条触发源，会继续闪）。
 */
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';

const NODE = process.execPath;
const GW = 'D:/WorkBuddy/AILens/llm-gateway.mjs';
const PANEL = 'D:/WorkBuddy/AILens/server.mjs';
const WATCH_LOG = 'D:/WorkBuddy/AILens/panel-watch.log';
const APPS = ['Cherry Studio.exe', 'WorkBuddy.exe'];

function appsRunning() {
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', timeout: 8000, windowsHide: true }).toLowerCase();
    return APPS.some(a => out.includes('"' + a.toLowerCase() + '"'));
  } catch { return null; }
}
function probe(port, path, timeout = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout }, r => {
      resolve(r.statusCode === 200); r.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
function logPanel(s) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`;
  console.log(line);
  try { fs.appendFileSync(WATCH_LOG, line + '\n'); } catch { /* 日志失败不影响主逻辑 */ }
}
function launch(script) {
  const c = spawn(NODE, [script], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
  return c.pid;
}

/* ---- ① 8765 主面板：无自杀机制，无条件保证在跑 ---- */
if (!(await probe(8765, '/'))) {
  const pid = launch(PANEL);
  await new Promise(r => setTimeout(r, 6000));       /* server.mjs 启动要跑 bootRefresh，等它就绪 */
  logPanel(await probe(8765, '/') ? `✓ 8765 已拉起（pid ${pid}）` : `✗ 拉起后仍无响应（pid ${pid}）`);
}

/* ---- ② 9999 网关：有自杀机制，只在 App 开着时拉 ---- */
const running = appsRunning();
const up = await probe(9999, '/health');
if (running === true && !up) {
  const pid = launch(GW);
  logPanel(`✓ 9999 网关已拉起（pid ${pid}）`);
}

/* 注：这里曾短暂有过第 ③ 段，用来兜 tools/sync-ctx-to-workbuddy.mjs（名称/上下文同步器）。
   该脚本已于 2026-10-08 归档进 _归档_20261008/ —— 它的职责（写 name / maxInputTokens）
   已并入网关内置的 startWorkBuddyCtxSync()，从此 models.json 只有一个写者，不需要再看门狗兜。
   ★ 别再把常驻脚本的"命"押在计划任务触发器上：独立任务 AILensSyncCtx 的 <TimeTrigger>
     没有 <Repetition>，只在 2026-10-03 那一个时刻响过一次，之后静默失效了 16 小时。 */
process.exit(0);
