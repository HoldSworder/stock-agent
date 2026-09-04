/**
 * Phase 0 能力矩阵：由 `scripts/symbolPlanCapability.probe.ts` / `.probe2.ts` 实测得出。
 * 适配器据此决定「提供证据」还是「标记缺失并降级」，避免把未验证的数据源写进 MVP 门禁。
 * 结论变化时请重跑探测脚本再改这里，不要凭印象调整。
 */
export type CapabilityVerdict = 'available' | 'degraded' | 'unavailable';

export interface CapabilityEntry {
  verdict: CapabilityVerdict;
  /** 缺失原因，直接进 EvidenceMeta.warnings 供前端展示 */
  note: string;
}

/** 实测日期，用于判断结论是否需要复测 */
export const CAPABILITY_PROBED_AT = '2026-08-03';

export const CAPABILITIES: Record<string, CapabilityEntry> = {
  /** 分钟线深度：60m/15m 各 320 根均实得 320（407ms / 201ms），4.1 目标上限达成 */
  minuteKlineDepth320: {
    verdict: 'available',
    note: '60m 覆盖约 4 个月、15m 覆盖约 1 个月',
  },
  /** 五档盘口：a-stock-data sidecar 无 quotes/quote/l2_quotes/snapshot 端点（全 404） */
  orderBookL2: {
    verdict: 'unavailable',
    note: '无五档数据源，盘口价差与冲击成本不可计算',
  },
  /** 指数成分股（含权重）：index_stock_cons_weight_csindex 可用，沪深300 返回 300 行 */
  indexConstituentsWithWeight: {
    verdict: 'available',
    note: '经 akshare index_stock_cons_weight_csindex 取中证系列成分与权重',
  },
  /** ETF→跟踪指数代码：三个候选 akshare 函数全部 404/500，无法自动解析 */
  etfIndexAutoResolve: {
    verdict: 'unavailable',
    note: '无自动映射数据源，改用内置 ETF→指数代码映射表；未登记的 ETF 不提供成分广度',
  },
  /** ETF 基金季报持仓：口径滞后一季度且常只有前十大，不能当成分广度分母 */
  etfQuarterlyHoldings: {
    verdict: 'degraded',
    note: '基金季报持仓仅可定性参考，不作为成分广度分母',
  },
  /** 个股解禁与增减持：getLockupAndHolders 可用且含未来解禁日 */
  stockLockupEvents: {
    verdict: 'available',
    note: '含未来解禁安排',
  },
  /** 财报预约披露日：stock_report_disclosure 404，cninfo 公告接口只返回历史，未来日期命中 0 */
  stockFutureEarningsCalendar: {
    verdict: 'unavailable',
    note: '无未来财报披露日数据源，事件风险仅以解禁安排与已发布业绩预告兜底',
  },
  /** 板块成分广度：只读收盘后日频快照 board_newhigh_snapshots，禁止实时遍历 */
  boardBreadthSnapshot: {
    verdict: 'available',
    note: '读每日的板块创新高快照；该快照任务没开或已过期时，这项结论会打折扣',
  },
};

export function capabilityOf(key: string): CapabilityEntry {
  // 用 hasOwn 而非裸下标：?? 只挡 undefined，挡不住原型链上的 constructor/toString 等属性
  return Object.hasOwn(CAPABILITIES, key)
    ? CAPABILITIES[key]
    : { verdict: 'unavailable', note: '未登记的能力项' };
}

/**
 * ETF → 跟踪指数代码映射（手工维护）。
 * ponytail: 自动解析三个数据源全部不可用（见 etfIndexAutoResolve），而用户实际只长期跟踪少量 ETF，
 * 手工小表比自动解析可靠。上限就是这张表的维护成本，需要覆盖更多 ETF 时在此追加即可。
 * 指数代码需为 index_stock_cons_weight_csindex 可识别的中证/国证代码。
 */
export interface EtfIndexRef {
  indexCode: string;
  indexName: string;
  /**
   * 东财 secid。指数与个股撞码，取 K 线必须显式传 secid，否则 buildKlineSecid 会按个股规则解析到错误市场。
   * 无法取到行情的境外指数（如恒生科技）留 null，此时不作为相对强弱基准，只在事件风险里说明。
   */
  secid: string | null;
}

export const ETF_INDEX_MAP: Record<string, EtfIndexRef> = {
  '159516': { indexCode: '931743', indexName: '中证半导体材料设备主题指数', secid: '2.931743' },
  '159740': { indexCode: 'HSTECH', indexName: '恒生科技指数', secid: null },
  '513180': { indexCode: 'HSTECH', indexName: '恒生科技指数', secid: null },
  '159326': { indexCode: '931643', indexName: '中证通信设备主题指数', secid: '2.931643' },
  '588200': { indexCode: '000685', indexName: '上证科创板芯片指数', secid: '1.000685' },
};

/** 取 ETF 的跟踪指数；未登记返回 null（调用方据此写入缺失警告）。code 来自请求参数，须防原型链穿透 */
export function trackingIndexOf(code: string): EtfIndexRef | null {
  return Object.hasOwn(ETF_INDEX_MAP, code) ? ETF_INDEX_MAP[code] : null;
}
