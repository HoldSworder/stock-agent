import { ElMessage } from 'element-plus';

// WebSocket 重连退避。各 store 原先各自抄了一份「固定 5s 无限重连」：
// token 失效（后端 401 拒绝握手）或后端长期不可用时，每条长连接都会每 5 秒
// 打一次注定失败的握手，永不停止也永不提示，用户只能从 Network 面板里发现。
// chatStream 已有指数退避 + 次数上限的正确实现，这里抽成共享的一份供 store 复用。

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const RETRY_MAX_TIMES = 8;

export interface WsRetry {
  /**
   * 在 onclose 里调用，安排下一次重连。
   * @returns 是否已排定；false 表示已达上限、不会再重连（调用方据此收尾状态）
   */
  schedule: (reconnect: () => void) => boolean;
  /** 连接成功或用户主动重连时调用，重置退避计数，否则打满后再也不会自动重连 */
  reset: () => void;
  /** 主动断开时调用，取消已排定的重连 */
  cancel: () => void;
}

/**
 * @param label 面向用户的连接名（如「实时盯盘」），用于达上限时的提示文案
 */
export function createWsRetry(label: string): WsRetry {
  let timer: number | null = null;
  let count = 0;

  return {
    schedule(reconnect) {
      if (timer != null) return true; // 已排定，不重复叠加
      if (count >= RETRY_MAX_TIMES) {
        ElMessage.error(`${label}连接多次失败，已停止重连，请检查登录状态或刷新页面`);
        return false;
      }
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** count);
      count += 1;
      timer = window.setTimeout(() => {
        timer = null;
        reconnect();
      }, delay);
      return true;
    },
    reset() {
      count = 0;
      // 挂起的退避定时器一并取消：调用方多是「先 reset 再自己建连接」，
      // 留着它会在几秒后再 connect 一次，握手恰好已失败时就多开一条连接
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    cancel() {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
