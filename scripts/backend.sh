#!/usr/bin/env bash
# 本地后端保活：用命令起一次，后端崩溃/退出后由 supervisor 自动重启，且脱离终端常驻
# （nohup 忽略 SIGHUP，关终端不掉；显式 down 才停）。无任何额外依赖。
#
#   bash scripts/backend.sh up       # 启动保活（已在跑则跳过）
#   bash scripts/backend.sh down     # 停止保活并清理后端进程
#   bash scripts/backend.sh status   # 查看保活/端口状态
#   bash scripts/backend.sh restart  # 重启
#
# 也可用 pnpm 别名：pnpm backend:up / backend:down / backend:status

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${SA_BACKEND_LOG:-/tmp/sa-backend.log}"
SUP_PIDFILE=/tmp/sa-backend-sup.pid
PORT=8787

port_pids() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null; }
is_up() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; }
sup_alive() { [ -f "$SUP_PIDFILE" ] && kill -0 "$(cat "$SUP_PIDFILE")" 2>/dev/null; }

# 强制释放指定端口：先 SIGTERM，残留再 SIGKILL（用于 dev 启动时抢回端口）
kill_port() {
  local p="$1" pids
  pids="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null)"
  [ -z "$pids" ] && return 0
  echo "[dev] 端口 $p 被占用 (pid $pids)，清理后重启..." >&2
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null)"
  [ -n "$pids" ] && { kill -9 $pids 2>/dev/null || true; sleep 1; }
  return 0
}

# 停掉常驻保活 supervisor（避免它与 dev 抢 8787）
stop_keepalive() {
  if [ -f "$SUP_PIDFILE" ]; then
    kill -9 "$(cat "$SUP_PIDFILE")" 2>/dev/null || true
    rm -f "$SUP_PIDFILE"
  fi
  pkill -9 -f "backend.sh __run" 2>/dev/null || true
}

# supervisor 主体：每 3s 探测端口，未监听则清理半死进程并重新拉起后端。
# 用「探端口」而非 wait 子进程——tsx 以子 node 进程跑服务，wait 包装进程不可靠；探端口与进程模型无关，最稳。
# 关键：忽略 SIGHUP/SIGTERM/SIGINT —— 关终端、Cursor agent 会话结束等都会向进程组发这些信号，
# 忽略后 supervisor 才能真正常驻、不被连带杀掉。仅 'down'（发 SIGKILL，不可捕获）能停止它。
supervisor() {
  trap '' HUP TERM INT
  echo $$ > "$SUP_PIDFILE"
  cd "$ROOT/backend"
  while true; do
    if ! is_up; then
      pkill -f "src/server.ts" 2>/dev/null || true   # 清理可能的半死/孤儿后端
      sleep 1
      echo "[keepalive] $(date '+%F %T') 启动后端" >> "$LOG"
      nohup ./node_modules/.bin/tsx src/server.ts >> "$LOG" 2>&1 &
      # 等待冷启动监听（最多 ~20s），避免启动期间被误判为「未监听」而重复拉起
      for _ in $(seq 1 20); do is_up && break; sleep 1; done
    fi
    sleep 3
  done
}

# 开发态保活（供 pnpm dev 使用）：前台运行 tsx watch（保留热重载 + 终端日志），
# 同时探测端口——后端崩溃持续未监听 / watcher 进程退出 → 强制重启；Ctrl-C 干净退出。
# 与 supervisor() 不同：dev 要响应 Ctrl-C，故正常 trap 而非忽略信号。
cmd_dev() {
  cd "$ROOT/backend"
  # 启动即抢占，确保本 dev 实例为唯一权威实例：
  # 1) 杀掉其它残留的 dev watchdog（排除自身），否则旧 watchdog 会与本实例抢 8787
  local _pid
  for _pid in $(pgrep -f "backend.sh dev" 2>/dev/null); do
    [ "$_pid" != "$$" ] && kill -9 "$_pid" 2>/dev/null || true
  done
  # 2) 停掉常驻保活、清理占用 8787 的旧后端
  stop_keepalive
  kill_port "$PORT"
  pkill -f "tsx/dist/cli.mjs watch src/server.ts" 2>/dev/null || true
  sleep 1
  local child=""
  # 启动 watcher 并等待冷启动完成：最多 ~40s 等首次监听端口。
  # 关键：没有这段宽限，慢冷启动（TS 编译 / 建连）会在 ~9s 内被崩溃探测误判 → 杀-重启死循环 → 端口一直起不来 → 前端持续 500。
  start_child() {
    ./node_modules/.bin/tsx watch src/server.ts & child=$!
    for _ in $(seq 1 40); do
      is_up && break
      kill -0 "$child" 2>/dev/null || break   # 子进程已退出 → 交主循环重启
      sleep 1
    done
  }
  trap 'kill "$child" 2>/dev/null; pkill -f "src/server.ts" 2>/dev/null; exit 0' INT TERM
  start_child
  local down=0
  while true; do
    if kill -0 "$child" 2>/dev/null; then
      # watcher 存活：探端口，应用崩溃会持续未监听（热重载只会短暂掉端口，不会连续命中）
      if is_up; then down=0; else down=$((down + 1)); fi
      # ponytail: 连续 3 次(~9s)未监听才判为崩溃，避开热重载瞬时掉端口；超长重建可能误重启（无害，等价再跑一次 watch）
      if [ "$down" -ge 3 ]; then
        echo "[dev-keepalive] 后端持续未监听，重启 watcher..."
        kill "$child" 2>/dev/null; pkill -f "src/server.ts" 2>/dev/null; sleep 1
        start_child; down=0
      fi
    else
      echo "[dev-keepalive] watcher 已退出，重启..."
      pkill -f "src/server.ts" 2>/dev/null; sleep 1
      start_child; down=0
    fi
    sleep 3
  done
}

cmd_up() {
  if sup_alive; then
    echo "保活已在运行 (pid $(cat "$SUP_PIDFILE"))"
    return 0
  fi
  local existing
  existing="$(port_pids)"
  if [ -n "$existing" ]; then
    echo "端口 $PORT 已被占用 (pid $existing)；请先 'bash scripts/backend.sh down' 或手动结束后再启动。"
    return 1
  fi
  # 脱离终端：nohup 忽略 SIGHUP + stdio 重定向 + disown
  nohup bash "${BASH_SOURCE[0]}" __run >/dev/null 2>&1 < /dev/null &
  disown 2>/dev/null || true
  sleep 1
  echo "后端保活已启动（崩溃/退出自动重拉）。日志: $LOG"
  echo "停止: bash scripts/backend.sh down"
}

cmd_down() {
  # supervisor 忽略 SIGTERM，故用 SIGKILL 强停
  if [ -f "$SUP_PIDFILE" ]; then
    kill -9 "$(cat "$SUP_PIDFILE")" 2>/dev/null || true
  fi
  rm -f "$SUP_PIDFILE"
  pkill -9 -f "backend.sh __run" 2>/dev/null || true
  # 清理监听端口的后端进程（tsx 实际以 node 运行，按端口兜底最稳）
  local pids
  pids="$(port_pids)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  pkill -f "src/server.ts" 2>/dev/null || true
  sleep 1
  echo "已停止后端保活。"
}

cmd_status() {
  if sup_alive; then
    echo "保活: 运行中 (pid $(cat "$SUP_PIDFILE"))"
  else
    echo "保活: 未运行"
  fi
  local pids
  pids="$(port_pids)"
  if [ -n "$pids" ]; then
    echo "端口 $PORT: LISTEN (pid $pids)"
  else
    echo "端口 $PORT: 未监听"
  fi
}

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  restart) cmd_down; cmd_up ;;
  status) cmd_status ;;
  dev) cmd_dev ;;
  freeport) kill_port "${2:?用法: freeport <端口>}" ;;
  __run) supervisor ;;
  *) echo "用法: bash scripts/backend.sh {up|down|restart|status|dev|freeport <端口>}"; exit 1 ;;
esac
