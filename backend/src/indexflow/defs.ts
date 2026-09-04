import type { IndexFlowGroup } from '@stock-agent/shared';

// 宽基指数资金流的指数清单与分组。
//
// 为什么不复用 market/eastmoney.ts 的 INDEX_SECIDS：那个常量同时被 getIndices() 用于
// 大盘页顶部行情条，而 getIndices 又被 agent/tools.ts 与 market/overview.ts 调用。
// 往里加指数会一路渗进 agent 的上下文，改的是资金流却影响了研判输入。

/** 单个可取资金流的指数定义 */
export interface IndexFlowDef {
  /** 东财 secid（市场前缀.代码） */
  secid: string;
  /** 展示名 */
  name: string;
  /** 6 位代码，供开 K 线 */
  code: string;
  /**
   * 分组归属。null = 只在明细里展示、不参与「哪边资金更强」的投票。
   *
   * 深证成指与创业板指成分重叠且风格不纯；科创50 与北证50 的市场范围和风格较特殊，
   * 不代表普通大小盘风格。这三个放进任一组都会污染多数票，所以只展示不投票。
   */
  group: IndexFlowGroup | null;
}

/** 资金流专用指数清单（10 个），顺序即展示顺序 */
export const INDEX_FLOW_DEFS: readonly IndexFlowDef[] = [
  // 大盘蓝筹
  { secid: '1.000300', name: '沪深300', code: '000300', group: 'large' },
  { secid: '1.000016', name: '上证50', code: '000016', group: 'large' },
  { secid: '1.000510', name: '中证A500', code: '000510', group: 'large' },
  { secid: '1.000001', name: '上证指数', code: '000001', group: 'large' },
  // 中小盘
  { secid: '1.000905', name: '中证500', code: '000905', group: 'small' },
  { secid: '1.000852', name: '中证1000', code: '000852', group: 'small' },
  { secid: '0.399006', name: '创业板指', code: '399006', group: 'small' },
  // 只展示，不投票
  { secid: '0.399001', name: '深证成指', code: '399001', group: null },
  { secid: '1.000688', name: '科创50', code: '000688', group: null },
  { secid: '0.899050', name: '北证50', code: '899050', group: null },
];

/** 分组显示名 */
export const GROUP_LABEL: Record<IndexFlowGroup, string> = {
  large: '大盘蓝筹',
  small: '中小盘',
};

/** 按 secid 查定义，未登记返回 null */
export function findDef(secid: string): IndexFlowDef | null {
  return INDEX_FLOW_DEFS.find((d) => d.secid === secid) ?? null;
}
