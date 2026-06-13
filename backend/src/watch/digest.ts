import type { WatchConfig } from '@stock-agent/shared';
import { sendTelegram } from '../notify/telegram';
import { nowIso } from '../util';
import { getStats, listAlerts } from './store';

// 当日告警摘要（对标 stock-signal-bot 复盘）：收盘后汇总当日告警 + 命中率，推一条 Telegram。

/** 组织并推送当日摘要；当日无告警则静默跳过 */
export async function sendDailyDigest(cfg: WatchConfig): Promise<void> {
  if (!cfg.pushTelegram) return;
  const today = nowIso().slice(0, 10);
  // 取足够多再按当日过滤（单用户日内量级有限）
  const todays = listAlerts(500).filter((a) => a.createdAt.slice(0, 10) === today);
  if (todays.length === 0) return;

  const pushed = todays.filter((a) => a.shouldAlert).length;
  const silenced = todays.filter((a) => !a.shouldAlert && !isScreened(a.verdict)).length;
  const screened = todays.filter((a) => isScreened(a.verdict)).length;

  // 当日已推送告警的结论分布
  const verdictCount = new Map<string, number>();
  for (const a of todays) {
    if (!a.shouldAlert || !a.verdict) continue;
    verdictCount.set(a.verdict, (verdictCount.get(a.verdict) ?? 0) + 1);
  }
  const verdictLine =
    verdictCount.size > 0
      ? [...verdictCount.entries()].map(([k, v]) => `${k}×${v}`).join('、')
      : '无';

  const stats = getStats();
  const hitLine =
    stats.hitRate != null
      ? `历史命中率 ${stats.hitRate.toFixed(0)}%（成熟样本 ${stats.maturedCount}）`
      : '历史命中率 暂无成熟样本';

  const text =
    `【盯盘日报 ${today}】\n` +
    `触发 ${todays.length} 条：推送 ${pushed}、沉默 ${silenced}、初筛拦截 ${screened}\n` +
    `推送结论：${verdictLine}\n` +
    `今日研判 token ${stats.tokensToday}\n` +
    hitLine;

  try {
    await sendTelegram(text);
  } catch (e) {
    console.warn('[watch] 日报推送失败:', e instanceof Error ? e.message : e);
  }
}

function isScreened(verdict: string | null): boolean {
  return verdict === '跳过(初筛)' || verdict === '跳过(打分门)';
}
