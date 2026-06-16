import type { ScreenNlStrategy } from '@stock-agent/shared';

// 自然语言选股预设：与多因子量化选股并列的另一类选股口径。
// 每条预设 = 一段自然语言 keyword，直接喂给妙想 mx_screener（miaoxiang.screener）。
// keyword 是「单一出处」：定时任务（尾盘 1445 / 妙想 0933）也复用同一常量，
// 保证「选股模块预设」与「战法定时任务」选股口径永不分叉，迁移后天然一致。

/**
 * 尾盘动能套利选股 keyword（原文取自尾盘任务 WEIPAN_PROMPT「尾盘候选」一步）。
 * 改动须同步评估对尾盘定时任务的影响（两者共用此常量）。
 */
export const WEIPAN_SCREEN_KEYWORD =
  '今天 A 股涨幅在 3% 到 9% 之间且非涨停，换手率在 3% 到 15% 之间，成交额大于 5 亿，流通市值小于 500 亿，只要主板和创业板（代码以 60/000/001/002/003/300/301 开头），剔除科创板（688/689 开头）和北交所（8 或 4 开头），昨日未涨停，结果必须包含最新价（现价），按市场面分数从高到低排序取前 15 只';

/**
 * 妙想量化选股 keyword（原文取自妙想 0933 任务「统一选股 keyword（禁止改写）」）。
 * 改动须同步评估对妙想定时任务的影响（两者共用此常量）。
 */
export const MIAOXIANG_SCREEN_KEYWORD =
  '上市板块为主板，近三日处于热门板块，今日涨幅在2%到7%之间，量比大于1.2，成交额大于3亿元，流通市值在50亿到800亿之间，MACD值大于0，收盘价大于20日均价，排除ST，排除上市不满30天，按主力资金净流入降序，取前8只';

const NL_STRATEGIES: ScreenNlStrategy[] = [
  {
    id: 'weipan_momentum',
    name: '尾盘动能套利',
    description:
      '尾盘动能套利打法：涨幅 3%~9% 非涨停、换手 3%~15%、成交额 >5 亿、流通市值 <500 亿，主板/创业板，挑当日强势主线龙头，次日择机兑现。',
    keyword: WEIPAN_SCREEN_KEYWORD,
  },
  {
    id: 'miaoxiang_quant',
    name: '妙想量化',
    description:
      '妙想量化筛选：主板、近三日热门板块、涨幅 2%~7%、量比 >1.2、成交额 >3 亿、流通市值 50~800 亿、MACD>0 且站上 20 日线，按主力净流入排序。',
    keyword: MIAOXIANG_SCREEN_KEYWORD,
  },
];

const BY_ID = new Map(NL_STRATEGIES.map((s) => [s.id, s]));

/** 默认自然语言选股预设 id（未配置时回退） */
export const DEFAULT_NL_STRATEGY_ID = 'weipan_momentum';

/** 全部自然语言选股预设（前端下拉与战法关联用 id 引用） */
export function listNlStrategies(): ScreenNlStrategy[] {
  return NL_STRATEGIES;
}

/** 是否为已知预设 id */
export function hasNlStrategy(id: string): boolean {
  return BY_ID.has(id);
}

/** 按 id 取预设；未知 id 回退默认预设 */
export function getNlStrategy(id: string | null | undefined): ScreenNlStrategy {
  return (id && BY_ID.get(id)) || BY_ID.get(DEFAULT_NL_STRATEGY_ID)!;
}
