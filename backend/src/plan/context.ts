import type { MarketReviewResult } from '@stock-agent/shared';
import { getIndicesResilient } from '../market/eastmoney';
import {
  listEtfAnalyzeReviews,
  listIntelReviews,
  listMarketBoardReviews,
  listReviews,
} from '../repo';
import { shanghaiToday } from '../util';
import { getPreviousReviewedPlan } from './repo';

// 今日计划上下文聚合：严格读取情报研判/大盘与板块研判/一键复盘/ETF综合研判/上一计划复盘五个源
// 【最新一次持久化的 AI 分析】，作为盘前生成今日计划的基准。不在此处现场重跑任何重型分析（persist_only），
// 缺失/过期一律显式标注，由计划 agent 据时效自行降权，但不回退现场重算。
// 三模块合并：情报研判=研报机会+全网热点；大盘与板块研判=大盘复盘+板块主线+期货外盘；ETF综合研判 吸收 ETF行业轮动。

/** 容错截断：超长保留头部，避免注入 prompt 撑爆 token */
function clip(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length <= max ? s : `${s.slice(0, max)}\n...[已截断 ${s.length - max} 字符]`;
}

/** 从可能含多余文字的输出中抽取首个完整 JSON 对象并解析（与 service 容错口径一致；仅一键复盘 JSON 用） */
function parseJsonObject<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

/** 生成时效标注：当日产出无标注，非当日提示注意时效 */
function freshness(createdAt: string | null): string {
  if (!createdAt) return '（生成时间未知）';
  const date = createdAt.slice(0, 10);
  const today = shanghaiToday();
  return date === today ? `（${createdAt}）` : `（${createdAt}，非当日产出，注意时效）`;
}

/**
 * 实时大盘指数点位：六源 AI 分析多为非当日产出，不含实时点位，LLM 易凭旧记忆编造支撑/压力。
 * 这里实时拉一次（东财→腾讯→缓存兜底），作为 marketStance.support/resistance 的唯一锚点。
 */
async function buildLiveIndexBlock(): Promise<string> {
  try {
    const indices = await getIndicesResilient();
    if (!indices.length)
      return '【实时大盘点位】行情接口暂无数据，支撑/压力请基于六源研判里出现的最新点位推算，切勿沿用记忆中的历史点位。';
    const lines = indices
      .filter((i) => i.point > 0)
      .map((i) => {
        const sign = i.pct > 0 ? '+' : '';
        return `${i.name}：${i.point}（${sign}${i.pct}%）`;
      });
    return (
      `【实时大盘点位】（实时拉取，支撑/压力必须围绕这些当前点位上下推算，禁止沿用记忆中的历史点位）\n` +
      lines.join('  ')
    );
  } catch {
    return '【实时大盘点位】行情接口异常，支撑/压力请基于六源研判里出现的最新点位推算，切勿沿用记忆中的历史点位。';
  }
}

/** 情报研判：最新一次「情报研判」正文（研报机会 + 全网热点 合并；markdown 散文，整段引用） */
function buildIntelBlock(): string {
  const latest = listIntelReviews(1)[0];
  if (!latest?.outputText)
    return '【情报研判·最新】无持久化情报研判（情报合并定时未启用或未产出）。';
  return `【情报研判·最新】${freshness(latest.createdAt)}\n${clip(latest.outputText, 3200)}`;
}

/** 大盘与板块研判：最新一次「大盘与板块研判」正文（大盘复盘 + 板块主线 + 期货外盘 合并） */
function buildMarketBoardBlock(): string {
  const latest = listMarketBoardReviews(1)[0];
  if (!latest?.outputText)
    return '【大盘与板块研判·最新】无持久化大盘与板块研判（大盘合并定时未启用或未产出）。';
  return `【大盘与板块研判·最新】${freshness(latest.createdAt)}\n${clip(latest.outputText, 3200)}`;
}

/** ETF 综合研判：最新一次「ETF 综合研判」正文（操作信号 + 中线赛道轮动 合并） */
function buildEtfBlock(): string {
  const latest = listEtfAnalyzeReviews(1)[0];
  if (!latest?.outputText)
    return '【ETF 综合研判·最新】无持久化 ETF 综合研判（ETF 合并定时未启用或未产出）。';
  return `【ETF 综合研判·最新】${freshness(latest.createdAt)}\n${clip(latest.outputText, 2800)}`;
}

/** 复盘：最新一次「一键复盘」综合方向/外围/主线/明日策略 */
function buildReviewBlock(): string {
  const latest = listReviews(3).find((r) => r.outputText);
  if (!latest) return '【一键复盘·最新】无持久化深度复盘（复盘定时未启用或未产出）。';
  const obj = parseJsonObject<Partial<MarketReviewResult>>(latest.outputText);
  if (!obj) return `【一键复盘·最新】${freshness(latest.createdAt)}\n（结构化解析失败）`;
  const lines: string[] = [`【一键复盘·最新】${freshness(latest.createdAt)}`];
  const cs = obj.comprehensiveStance;
  if (cs) {
    lines.push(`综合方向：${cs.bias} —— ${cs.summary ?? ''}`);
    if (cs.drivers?.length) lines.push('关键驱动：' + cs.drivers.join('；'));
  }
  if (obj.mainThemes?.length) {
    lines.push(
      '主线题材：' +
        obj.mainThemes.slice(0, 4).map((t) => `${t.name}(${t.strength})`).join('、'),
    );
  }
  if (obj.strongStocks?.length) {
    lines.push(
      '强势个股：' +
        obj.strongStocks.slice(0, 8).map((s) => `${s.name}(${s.code})`).join('、'),
    );
  }
  if (obj.overseasMarkets?.length) {
    lines.push(
      '外围：' +
        obj.overseasMarkets
          .slice(0, 6)
          .map((o) => `${o.name}(${o.region}) ${o.trend}→${o.impact}`)
          .join('  '),
    );
  }
  if (obj.tomorrowPlan) {
    const tp = obj.tomorrowPlan;
    if (tp.focus?.length) lines.push('次日重点：' + tp.focus.slice(0, 4).join('、'));
    if (tp.positionAdvice) lines.push('仓位建议：' + tp.positionAdvice);
  }
  return lines.join('\n');
}

/** 闭环反哺：上一份已收盘计划的复盘总结（含次日预案草稿），让计划自身的复盘结论流回次日生成 */
function buildPrevPlanReviewBlock(): string {
  const prev = getPreviousReviewedPlan(shanghaiToday());
  if (!prev?.reviewSummary)
    return '【上一计划复盘·闭环反哺】无已收盘的历史计划复盘（首次运行或上一计划未收盘归档）。';
  return `【上一计划复盘·闭环反哺】（${prev.planDate} 计划收盘复盘，含次日预案草稿）\n${clip(prev.reviewSummary, 2500)}`;
}

/**
 * 聚合五源最新 AI 分析为单段文本，供今日计划 agent 一次性读取作为生成基准。
 * 顺序：情报研判（研报+热点）→ 大盘与板块研判（大盘复盘+板块主线+期货外盘）→ 一键复盘综合方向
 * → ETF综合研判（操作信号+中线轮动）→ 上一计划收盘复盘/次日预案（闭环反哺）。
 */
export async function buildPlanContext(): Promise<string> {
  const liveIndex = await buildLiveIndexBlock();
  return [
    `今日计划基准（${shanghaiToday()}）——以下为各模块【最新一次持久化 AI 分析】，缺失/非当日已标注，请据时效自行降权：`,
    liveIndex,
    buildIntelBlock(),
    buildMarketBoardBlock(),
    buildReviewBlock(),
    buildEtfBlock(),
    buildPrevPlanReviewBlock(),
  ].join('\n\n');
}
