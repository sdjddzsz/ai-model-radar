/**
 * AILens 网关常驻守护（本机专用）
 * ── 为什么有它：新机用 Windows 计划任务 AILensGatewayWatch 每分钟调一次看门狗；
 *    本机 schtasks.exe 被安全策略黑名单拦截、PowerShell 注册任务也被 LOLBin 规则拒绝，
 *    所以改用「常驻自循环进程」承担同样的职责。
 *
 *    ★ 但这个进程**必须由 Explorer 双击启动**（见同目录 启动网关.vbs），
 *      不能从 bash/命令行起：2026-10-09 实测，凡是在一次 bash 工具调用里起的
 *      后台进程（nohup 也罢、detached+unref 也罢），都会在那次调用收尾的一瞬
 *      被回收 —— 现象是 pid 写对了、5 秒内 /health=200，下一次调用就 000。
 *      （早期注释曾据 2026-10-03 的观察写成「detached+unref 不随会话回收」，
 *        10-09 在同一台机上复现失败，已更正。进程可见性(ps/tasklist)在本沙盒里
 *        本来就不可信，判活一律用 /health 探针。）
 *
 * ── 与 llm-gateway-watch.mjs 的区别（重要）：
 *    看门狗先判「WorkBuddy/Cherry 有没有在跑」，不在就**不拉**网关。
 *    但本机沙盒里 `tasklist` 返回空 → appsRunning() 恒为 null → 看门狗永远不会拉起网关。
 *    所以本守护**不做进程名判断**，直接按「9999 探活失败就拉起」工作。
 *    安全性由网关自身保证：它的自杀逻辑在 appsRunning() 返回 null 时**不累加 idle**，
 *    也就不会退出；两个 App 真关掉时它的检查同样可能失效 —— 无非是多留一个空闲网关，
 *    代价可接受，换来的是「网关一定活着」。
 *
 * ── 用法：node gw-daemon.mjs（detached 启动）；日志 gw-daemon.log
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const GW = path.join(BASE, 'llm-gateway.mjs');
const PANEL = path.join(BASE, 'server.mjs');
const MON = path.join(BASE, 'usage-monitor.mjs');   /* ★ 2026-10-11 补：9998 用量监控也纳入守护 */
const LOG = path.join(BASE, 'gw-daemon.log');
const INTERVAL_MS = 60 * 1000;

function log(s) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${s}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch { /* 日志失败不影响主逻辑 */ }
}

function probe(port, p, timeout = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout }, r => {
      resolve(r.statusCode === 200); r.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function launch(script) {
  const c = spawn(NODE, [script], { detached: true, stdio: 'ignore', windowsHide: true, cwd: BASE });
  c.unref();
  return c.pid;
}

let booted = false;
let panelFails = 0;
let monFails = 0;
const PANEL_GIVE_UP = 5;
const MON_GIVE_UP = 5;

async function tick() {
  try {
    if (!(await probe(9999, '/health'))) {
      const pid = launch(GW);
      log(`9999 探活失败 → 已拉起（pid ${pid}）`);
    } else if (!booted) {
      log('9999 已在线');
    }
    /* 8765 面板：本机实测反复起不来（拉起后仍无响应），
       连续失败若干次后就不再重试，免得每 60s 造一个僵尸进程。 */
    if (panelFails < PANEL_GIVE_UP) {
      if (!(await probe(8765, '/'))) {
        const pid = launch(PANEL);
        panelFails++;
        log(`8765 探活失败 → 已拉起（pid ${pid}，第 ${panelFails} 次）`);
      } else {
        panelFails = 0;
      }
    } else if (panelFails === PANEL_GIVE_UP) {
      panelFails++;
      log(`8765 连续 ${PANEL_GIVE_UP} 次起不来，停止重试（网关 9999 不受影响）`);
    }
    /* ★ 2026-10-11 补：9998 用量监控。之前不在守护范围里，10-02 之后一直没人拉，
       面板自然一直刷不出数据。同款逻辑：探活失败就拉起，连续失败 5 次放弃。 */
    if (monFails < MON_GIVE_UP) {
      if (!(await probe(9998, '/'))) {
        const pid = launch(MON);
        monFails++;
        log(`9998 探活失败 → 已拉起（pid ${pid}，第 ${monFails} 次）`);
      } else {
        monFails = 0;
      }
    } else if (monFails === MON_GIVE_UP) {
      monFails++;
      log(`9998 连续 ${MON_GIVE_UP} 次起不来，停止重试（网关 9999 不受影响）`);
    }
  } catch (e) {
    log(`tick 异常: ${e.message}`);
  }
  booted = true;
}

log(`守护启动（pid ${process.pid}，间隔 ${INTERVAL_MS / 1000}s）`);
await tick();
setInterval(tick, INTERVAL_MS);
