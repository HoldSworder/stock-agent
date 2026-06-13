import type { DailyPlanItem, StrategySellProfile, WatchSource } from '@stock-agent/shared';

// 盯盘模块内部上下文类型（不对外导出到 shared）。

/** 单标的的规则评估输入（由 engine 组装快照 + 滚动状态后传入纯规则） */
export interface QuoteCtx {
  code: string;
  name: string;
  source: WatchSource;
  /** 现价 */
  price: number;
  /** 涨跌幅 % */
  pct: number;
  /** 昨收 */
  prevClose: number;
  /** 持仓成本（仅 source=position 有值） */
  avgCost?: number;
  /** 今日滚动最高价 */
  dayHigh: number;
  /** 上一轮价格（首轮为 null） */
  prevPrice: number | null;
  /** 涨停价（按板块近似推算） */
  limitUp?: number;
  /** 换手率 %（C 技术指标，best-effort） */
  turnoverRate?: number;
  /** 量比（C 技术指标，best-effort） */
  volumeRatio?: number;
  /** 当日 ATR%（日线波动率，用于通用下跌阈值的波动率归一化；缺失则回退静态阈值） */
  atrPct?: number;
  /** 所属战法 id（持仓来自战法时有值） */
  strategyId?: string;
  /** 所属战法名 */
  strategyName?: string;
  /** 战法卖点档案（有档案才启用战法专属触发） */
  profile?: StrategySellProfile | null;
  /** 今日计划标的项（有则启用计划结构化触发价对照） */
  planItem?: DailyPlanItem | null;
}

/** 每只标的的滚动状态（engine 内存维护） */
export interface RollState {
  dayHigh: number;
  lastPrice: number;
  /** 状态所属交易日 YYYY-MM-DD（跨日重置） */
  day: string;
}
