#!/usr/bin/env bash
# 等到 OpenRouter 可达后，自动跑完整一轮模型实测（BENCH_REDO=all，保证 25 个数据一致）。
# 用法：bash tools/bench-runner.sh   （后台运行，网络恢复后自动开跑，跑完写 bench-DONE.log）
set -u
# node.exe 动态解析：WorkBuddy 升级托管 Node 会换版本目录（22.22.2-x），不写死版本号。
resolve_node() {
  if [ -n "${AILENS_NODE:-}" ] && [ -x "${AILENS_NODE}" ]; then printf '%s\n' "$AILENS_NODE"; return 0; fi
  local base="${HOME}/.workbuddy/binaries/node"
  if [ -f "${base}/versions/current" ]; then
    local ver; ver="$(tr -d '\r\n' < "${base}/versions/current")"
    if [ -x "${base}/versions/${ver}/node.exe" ]; then printf '%s\n' "${base}/versions/${ver}/node.exe"; return 0; fi
  fi
  local d
  for d in $(ls -1dt "${base}"/versions/*/ 2>/dev/null); do
    if [ -x "${d}node.exe" ]; then printf '%s\n' "${d}node.exe"; return 0; fi
  done
  command -v node.exe || command -v node
}
NODE="$(resolve_node)"
[ -n "$NODE" ] || { echo "错误：未找到 node.exe" >&2; exit 1; }
SCRIPT="G:/WorkBuddy/AILens/tools/bench-models.mjs"
RUNLOG="G:/WorkBuddy/AILens/bench-run.log"
DONE="G:/WorkBuddy/AILens/bench-DONE.log"
MAX_WAIT=${BENCH_WATCH_MAX:-20}   # 最多等多少分钟（每 60s 探一次），可用环境变量覆盖
CHECK_URL="https://openrouter.ai/api/v1/models"
# 用 --noproxy 直连探活：与实测脚本的实际 fetch 路径一致（脚本直连 openrouter，不经代理）。
# 只有直连可达才开跑，避免「代理通但直连不通」时启动注定失败的跑批。

ts() { date +"%H:%M:%S"; }

echo "[$(ts)] 启动：等待 OpenRouter 恢复（最多 ${MAX_WAIT}m）" | tee -a "$RUNLOG"
reachable=0
for ((i=1; i<=MAX_WAIT; i++)); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --noproxy '*' --max-time 8 "$CHECK_URL" 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo "[$(ts)] OpenRouter 可达 (HTTP 200)，开始跑实测" | tee -a "$RUNLOG"
    reachable=1
    break
  fi
  echo "[$(ts)] 第${i}/${MAX_WAIT}次探活失败 (HTTP ${code:-无响应})，60s 后重试" | tee -a "$RUNLOG"
  sleep 60
done

if [ "$reachable" != "1" ]; then
  echo "[$(ts)] 超时：20 分钟内 OpenRouter 未恢复。网络仍 outage，本次放弃（脚本已硬化，恢复后重跑即可）。" | tee -a "$RUNLOG"
  echo "TIMEOUT" > "$DONE"
  exit 0
fi

echo "[$(ts)] === 启动完整实测 (BENCH_REDO=all) ===" | tee -a "$RUNLOG"
BENCH_REDO=all BENCH_RETRIES=4 "$NODE" "$SCRIPT" >> "$RUNLOG" 2>&1
rc=$?
echo "[$(ts)] 实测结束，退出码=$rc" | tee -a "$RUNLOG"
if [ "$rc" = "0" ]; then
  echo "OK $(ts)" > "$DONE"
else
  echo "ERROR rc=$rc $(ts)" > "$DONE"
fi
