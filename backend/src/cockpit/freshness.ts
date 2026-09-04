import type { ActionDataSource, DataCompleteness, SourceFreshness } from '@stock-agent/shared';
import { ACTION_DATA_SOURCE_LABELS, FRESHNESS_OUTAGE_DAYS } from '@stock-agent/shared';
import { isAShareTradingTime, shanghaiToday } from '../util';
import {
  expectedSnapshotDate,
  snapshotBehindDays,
  type DailySnapshotSource,
} from '../scheduling/snapshotWindow';

// 数据新鲜度：回答「现在这份判断，底下的数据是什么时候的」。
//
// 为什么单独做一层：取数成功不等于数据可用。板块快照可能是三周前的、真实持仓可能是昨天收盘的，
// 接口都会正常返回 200。拿过期数据驱动减仓建议，比取数失败更危险——失败看得见，过期看不见。
//
// 判定要按**数据自己的节奏**，这是这层最容易写错的地方：
//   日频快照 15:20 才产出，拿「是不是今天的」去判它，盘中全程都会被判过期，
//   而过期又会连锁挡住买入动作——等于整个交易日都不许买。
//   正确的问法是「按它的产出时刻，现在最新应该是哪天的」，答案由 snapshotWindow 统一给出，
//   与落盘闸门共用同一份定义，避免保存侧和展示侧各说一套。

/** 日频快照源 → snapshotWindow 里的键。其余源走实时分钟制 */
const DAILY_SOURCE: Partial<Record<ActionDataSource, DailySnapshotSource>> = {
  boards: 'breadth',
};

/**
 * 实时源的有效时长（分钟），只在**盘中**适用。
 *
 * 盘后不按分钟算：收盘后持仓不再变动，一份 16:00 的持仓到 22:00 依然准确，
 * 按分钟判过期会让整个晚上都显示「数据不新鲜」，噪声盖过信号。
 * 盘后改判「是不是同一个交易日的」。
 */
const INTRADAY_TTL_MINUTES: Record<ActionDataSource, number> = {
  // 持仓与纪律直接决定止损动作，盘中要求最严
  positions: 10,
  discipline: 10,
  // 行情驱动「临近触发」的判断，过期会让人以为还差得远
  quote: 3,
  // 计划是盘前生成的，当天内不重算
  plan: 24 * 60,
  // 轮动与板块都是日频快照
  rotation: 24 * 60,
  boards: 24 * 60,
};

/** 判定这三源没就绪就不放行买入动作——止损还没算出来时先买入是最坏的顺序 */
export const RISK_SOURCES: ActionDataSource[] = ['positions', 'discipline', 'boards'];

/**
 * 判定一个来源的新鲜度。
 *
 * @param dataAt 数据实际产生的时间（ISO 或 YYYY-MM-DD）。null 表示取不到
 * @param failedNote 取数失败时的原因；给了就直接判 failed
 * @param pendingNote 「还在后台算」的说明。给了它就判 missing 而不是 failed——
 *   预热中不是失败，标成红色会让人以为坏了去排查一个根本不存在的故障
 */
export function judgeFreshness(
  source: ActionDataSource,
  dataAt: string | null,
  failedNote?: string,
  pendingNote?: string,
): SourceFreshness {
  const label = ACTION_DATA_SOURCE_LABELS[source];
  const ttlMinutes = INTRADAY_TTL_MINUTES[source];
  const base = { source, label, ttlMinutes, behindDays: null as number | null };
  if (failedNote) {
    return { ...base, state: 'failed', dataAt: null, note: failedNote };
  }
  if (!dataAt) {
    return { ...base, state: 'missing', dataAt: null, note: pendingNote ?? `${label}没有数据` };
  }

  // 日频快照源：按它自己的产出时刻判，不按自然日
  const daily = DAILY_SOURCE[source];
  if (daily) {
    const expected = expectedSnapshotDate(daily);
    const behind = snapshotBehindDays(dataAt.slice(0, 10), expected) ?? 0;
    if (behind === 0) return { ...base, state: 'ok', dataAt, behindDays: 0, note: '' };
    if (behind >= FRESHNESS_OUTAGE_DAYS) {
      return {
        ...base,
        state: 'outage',
        dataAt,
        behindDays: behind,
        // 说清落后多久，「不是今天的」和「三周没更新了」是完全不同的严重程度
        note: `${label}已经 ${behind} 个交易日没更新（最新还停在 ${dataAt.slice(0, 10)}），多半是定时任务没在跑`,
      };
    }
    return {
      ...base,
      state: 'stale',
      dataAt,
      behindDays: behind,
      note: `${label}是 ${dataAt.slice(0, 10)} 的，落后 ${behind} 个交易日`,
    };
  }

  // 实时源
  const day = dataAt.slice(0, 10);
  const today = shanghaiToday();
  if (day !== today) {
    return {
      ...base,
      state: 'stale',
      dataAt,
      note: `${label}是 ${day} 的，不是今天的`,
    };
  }
  // 只有日期没有时刻（如快照日），到这一步已确认是今天，视为新鲜
  if (dataAt.length <= 10) return { ...base, state: 'ok', dataAt, note: '' };
  if (!isAShareTradingTime(new Date())) return { ...base, state: 'ok', dataAt, note: '' };
  const ageMin = (Date.now() - new Date(dataAt).getTime()) / 60_000;
  if (ageMin > ttlMinutes) {
    return {
      ...base,
      state: 'stale',
      dataAt,
      note: `${label}已经 ${Math.round(ageMin)} 分钟没更新（盘中最多 ${ttlMinutes} 分钟）`,
    };
  }
  return { ...base, state: 'ok', dataAt, note: '' };
}

/**
 * 汇总成一句话结论 + 风险检查是否就绪。
 *
 * `riskReady` 是给动作清单的闸门：持仓/纪律/板块任一没就绪，买入类动作就不能标成「可执行」。
 * 理由是顺序——用户看到一份看起来完整的机会清单就会照做，而此时止损动作可能还没算出来。
 *
 * 注意日频源现在按自己的节奏判，所以「板块快照是昨收的」在盘中属于正常，不再挡住买入；
 * 只有真的落后了（stale/outage）才挡。这修掉了上一版「盘中永远不许买」的缺陷。
 */
export function summarizeFreshness(sources: SourceFreshness[]): DataCompleteness {
  const bad = sources.filter((s) => s.state !== 'ok');
  const outages = sources.filter((s) => s.state === 'outage');
  const riskBad = bad.filter((s) => RISK_SOURCES.includes(s.source));
  const riskReady = riskBad.length === 0;
  const summary =
    outages.length > 0
      ? `有数据已经断供：${outages.map((s) => s.note).join('；')}`
      : bad.length === 0
        ? '所有数据都是最新的'
        : riskBad.length > 0
          ? `持仓风险还检查不了：${riskBad.map((s) => s.note).join('；')}`
          : `部分数据不完整：${bad.map((s) => s.note).join('；')}`;
  return { riskReady, sources, summary, outages };
}
