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

# ===== 进程定位：一律先按仓库归属过滤，再动手 =====
# 只按 "src/server.ts" / "backend.sh dev" 这类相对串匹配是危险的：src/server.ts 是极常见的
# 相对路径，本机任何其它项目的 `tsx src/server.ts`、甚至命令行恰好含该串的进程（编辑器搜索、
# 另一个 agent 的 shell）都会被 pkill 连带杀掉。下面用「命令行含仓库绝对路径 或 cwd 在仓库内」
# 双条件把作用域收回到本仓库自己拉起的进程。

# 进程 cwd（macOS 无 /proc，用 lsof 取；取不到返回空）
proc_cwd() { lsof -a -d cwd -p "$1" -Fn 2>/dev/null | grep '^n' | head -1 | cut -c2-; }

# 该 PID 是否属于本仓库（顺带充当「进程仍存活」的校验）
belongs_to_repo() {
  local cmd
  cmd="$(ps -p "$1" -o command= 2>/dev/null)" || return 1
  [ -z "$cmd" ] && return 1
  case "$cmd" in *"$ROOT"*) return 0 ;; esac
  case "$(proc_cwd "$1")" in "$ROOT" | "$ROOT"/*) return 0 ;; esac
  return 1
}

# 命令行匹配 $1 且属于本仓库的 PID（排除本脚本自身）
repo_pids() {
  local pid
  for pid in $(pgrep -f "$1" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    belongs_to_repo "$pid" && echo "$pid"
  done
}

# 杀掉本仓库内命令行匹配 $1 的进程；$2 给 -9 则强杀。
# 动手前复核一次归属：pgrep 快照里可能含已退出的子 shell，PID 回绕时会打到无关进程。
kill_repo_procs() {
  local pattern="$1" sig="${2:-}" pid
  for pid in $(repo_pids "$pattern"); do
    belongs_to_repo "$pid" || continue
    kill $sig "$pid" 2>/dev/null || true
  done
}

# 是否为本脚本拉起的后端进程。命令行形态必须是 tsx 包装进程或它派生的 node 子进程
# （…/tsx/… + src/server.ts），再叠加仓库归属——否则「cwd 恰在本仓库、命令行恰含
# src/server.ts」的普通 shell（编辑器搜索、另一个 agent 的命令行）也会被误杀。
is_backend_proc() {
  local cmd
  cmd="$(ps -p "$1" -o command= 2>/dev/null)" || return 1
  case "$cmd" in *tsx*src/server.ts*) ;; *) return 1 ;; esac
  belongs_to_repo "$1"
}

# 停掉本脚本拉起的后端进程：先 SIGTERM，残留再 SIGKILL（每次动手前复核，避免 PID 回绕误伤）
stop_backends() {
  local pid pids=""
  for pid in $(pgrep -f "src/server\.ts" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    is_backend_proc "$pid" && pids="$pids $pid"
  done
  [ -z "$pids" ] && return 0
  for pid in $pids; do is_backend_proc "$pid" && kill "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in $pids; do is_backend_proc "$pid" && kill -9 "$pid" 2>/dev/null || true; done
  return 0
}

# 读取并校验 supervisor PID；校验通过时输出 PID。
# 残留 pidfile + PID 回绕会让 kill -9 打到无关进程，故必须确认该 PID 的命令行确实是本脚本的 supervisor。
sup_pid() {
  [ -f "$SUP_PIDFILE" ] || return 1
  local pid
  pid="$(cat "$SUP_PIDFILE" 2>/dev/null)"
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  ps -p "$pid" -o command= 2>/dev/null | grep -q "backend\.sh __run" || return 1
  echo "$pid"
}
sup_alive() { sup_pid >/dev/null 2>&1; }

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
  local pid
  pid="$(sup_pid)" && kill -9 "$pid" 2>/dev/null || true
  rm -f "$SUP_PIDFILE"
  kill_repo_procs "backend\.sh __run" -9
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
      stop_backends   # 清理可能的半死/孤儿后端（仅本仓库的）
      sleep 1
      echo "[keepalive] $(date '+%F %T') 启动后端" >> "$LOG"
      nohup ./node_modules/.bin/tsx src/server.ts >> "$LOG" 2>&1 &
      child=$!
      # 等冷启动监听。判据是「子进程是否还活着」而不是固定秒数：
      # 冷启动要跑 schema 迁移 + 种子 + 首轮行情预热，实测就在 20s 临界线上，
      # 按固定 20s 放弃会让下一轮的 stop_backends 把正在启动的后端杀掉，
      # 陷入「起一半就被杀」的无限重启（日志里只剩 keepalive 行、看不到任何后端输出）。
      # 上限 60s：tsx 是包装进程，node 子进程崩了它可能仍活着，kill -0 察觉不到，
      # 所以还要靠这个上限兜底回到外层循环重试，不能无限等。
      for _ in $(seq 1 60); do
        is_up && break
        kill -0 "$child" 2>/dev/null || break
        sleep 1
      done
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
  kill_repo_procs "backend\.sh dev" -9
  # 2) 停掉常驻保活、清理占用 8787 的旧后端（含本仓库残留的 tsx watch）
  stop_keepalive
  kill_port "$PORT"
  stop_backends
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
  trap 'kill "$child" 2>/dev/null; stop_backends; exit 0' INT TERM
  start_child
  local down=0
  while true; do
    if kill -0 "$child" 2>/dev/null; then
      # watcher 存活：探端口，应用崩溃会持续未监听（热重载只会短暂掉端口，不会连续命中）
      if is_up; then down=0; else down=$((down + 1)); fi
      # ponytail: 连续 3 次(~9s)未监听才判为崩溃，避开热重载瞬时掉端口；超长重建可能误重启（无害，等价再跑一次 watch）
      if [ "$down" -ge 3 ]; then
        echo "[dev-keepalive] 后端持续未监听，重启 watcher..."
        kill "$child" 2>/dev/null; stop_backends
        start_child; down=0
      fi
    else
      echo "[dev-keepalive] watcher 已退出，重启..."
      stop_backends
      start_child; down=0
    fi
    sleep 3
  done
}

cmd_up() {
  local pid
  if pid="$(sup_pid)"; then
    echo "保活已在运行 (pid $pid)"
    return 0
  fi
  local existing
  existing="$(port_pids)"
  if [ -n "$existing" ]; then
    echo "端口 $PORT 已被占用 (pid $existing)；请先 'bash scripts/backend.sh down' 或手动结束后再启动。"
    return 1
  fi
  # 脱离终端：nohup 忽略 SIGHUP + stdio 重定向 + disown。
  # 用绝对路径启动，supervisor 的命令行才带仓库路径，后续 kill 才能按仓库归属精确定位。
  nohup bash "$ROOT/scripts/backend.sh" __run >/dev/null 2>&1 < /dev/null &
  disown 2>/dev/null || true
  sleep 1
  echo "后端保活已启动（崩溃/退出自动重拉）。日志: $LOG"
  echo "停止: bash scripts/backend.sh down"
}

cmd_down() {
  # supervisor 忽略 SIGTERM，故用 SIGKILL 强停
  local pid pids
  pid="$(sup_pid)" && kill -9 "$pid" 2>/dev/null || true
  rm -f "$SUP_PIDFILE"
  kill_repo_procs "backend\.sh __run" -9
  # 清理监听端口的后端进程（tsx 实际以 node 运行，按端口兜底最稳）
  pids="$(port_pids)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  stop_backends
  echo "已停止后端保活。"
}

cmd_status() {
  local sup
  if sup="$(sup_pid)"; then
    echo "保活: 运行中 (pid $sup)"
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
