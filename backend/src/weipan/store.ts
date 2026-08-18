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
  // slice(0, NaN) 会返回空数组，用户看到的是「无告警」而不是「参数错了」，故非数字回落默认条数
  const safe = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), CAP) : 100;
  return src.slice(0, safe);
}

export function countWeipanAlertsToday(): number {
  const today = shanghaiToday();
  return alerts.filter((a) => shanghaiToday(new Date(a.createdAt)) === today).length;
}
