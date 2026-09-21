/**
 * AI 模型雷达 · 等服务就绪并打开浏览器
 * 服务的启动由 .cmd 里的 `start /min` 负责，这里只负责等 + 打开。
 */
import net from 'net';
import { spawn } from 'child_process';

const PORT = 8765;
const URL = 'http://localhost:' + PORT;

function alive(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(700);
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

function openBrowser(url) {
  spawn('cmd.exe', ['/d', '/c', 'start', '""', url], {
    detached: true, stdio: 'ignore', windowsHide: true
  }).unref();
}

let up = false;
for (let i = 0; i < 60; i++) {
  if (await alive(PORT)) { up = true; break; }
  await new Promise(r => setTimeout(r, 400));
}

if (up) {
  console.log('  ✓ 服务就绪 → ' + URL);
  openBrowser(URL);
  console.log('  ✓ 已在默认浏览器中打开');
  console.log('\n  数据会自动缓存（AILens\\cache），点页面右上角可强制刷新。');
  console.log('  停止服务：关掉任务栏里最小化的 "AILens" 命令行窗口。\n');
} else {
  console.error('  ✗ 服务没起来。手动排查：node server.mjs');
}
process.exit(0);
