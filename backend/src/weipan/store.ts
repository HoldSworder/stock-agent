import type { WeipanAlert } from '@stock-agent/shared';
import { newId, nowIso, shanghaiToday } from '../util';

// 尾盘盯盘告警缓存：进程内环形缓冲（最近 200 条），供 /ws/weipan 实时流与告警面板回看。
// ponytail: 不落 DB（省一张表/一次迁移）——每笔卖出的**持久**记录已在 sim_trades（战法成交流水，带 reason），
// 这里只做「信号提醒」的轻量留痕；进程重启即清空（可接受，业绩以 sim_trades 为准）。

const CAP = 200;
const alerts: WeipanAlert[] = [];

export function insertWeipanAlert(input: Omit<WeipanAlert, 'id' | 'createdAt'>): WeipanAlert {
  const alert: WeipanAlert = { ...input, id: newId(), createdAt: nowIso() };
  alerts.unshift(alert);
  if (alerts.length > CAP) alerts.length = CAP;
  return alert;
}

export function listWeipanAlerts(limit = 100, todayOnly = false): WeipanAlert[] {
  const src = todayOnly
    ? alerts.filter((a) => shanghaiToday(new Date(a.createdAt)) === shanghaiToday())
    : alerts;
  return src.slice(0, Math.max(1, limit));
}

export function countWeipanAlertsToday(): number {
  const today = shanghaiToday();
  return alerts.filter((a) => shanghaiToday(new Date(a.createdAt)) === today).length;
}
