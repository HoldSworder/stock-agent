import type { MarketOverview } from '@stock-agent/shared';
import {
  getIndices,
  getGlobalIndices,
  getFutures,
  getSectorRanking,
  getSectorByChange,
  getSectorMoneyFlow,
  getStockRanking,
  getTurnoverTotal,
  getEmotion,
  getLadder,
} from './eastmoney';

// 大盘盘面快照聚合：原内联于 server.ts，抽出供「/api/market/overview」「/api/market/review」
// 与「market.review 定时复盘」「review.eod 深度复盘」共用，避免重复。

/** 单块失败不影响整体：失败置 fallback（数组块置 []） */
async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

export async function buildOverview(): Promise<MarketOverview> {
  const [
    indices,
    globalIndices,
    futures,
    turnoverTotal,
    emotion,
    ladder,
    hotIndustries,
    hotConcepts,
    moneyInflow,
    moneyOutflow,
    loserSectors,
    topLosers,
    topTurnover,
  ] = await Promise.all([
    safe(getIndices(), [] as MarketOverview['indices']),
    safe(getGlobalIndices(), [] as MarketOverview['globalIndices']),
    safe(getFutures(), [] as MarketOverview['futures']),
    safe(getTurnoverTotal(), null),
    safe(getEmotion(), null),
    safe(getLadder(), null),
    safe(getSectorRanking('industry', 12), []),
    safe(getSectorRanking('concept', 12), []),
    safe(getSectorMoneyFlow('inflow', 10), null),
    safe(getSectorMoneyFlow('outflow', 10), null),
    safe(getSectorByChange('losers', 10), null),
    safe(getStockRanking('losers', 15), null),
    safe(getStockRanking('turnover', 15), []),
  ]);
  return {
    asOf: new Date().toISOString(),
    indices,
    globalIndices,
    futures,
    turnoverTotal,
    emotion,
    ladder,
    hotIndustries,
    hotConcepts,
    moneyInflow,
    moneyOutflow,
    loserSectors,
    topLosers,
    topTurnover,
  };
}

/** 大盘复盘点评 prompt（轻量，单次 agent 运行），供按钮触发与定时复盘共用 */
export function buildMarketReviewPrompt(ov: MarketOverview): string {
  const snapshot = {
    indices: ov.indices,
    globalIndices: ov.globalIndices,
    turnoverTotal: ov.turnoverTotal,
    emotion: ov.emotion,
    ladder: ov.ladder,
    hotIndustries: ov.hotIndustries,
    hotConcepts: ov.hotConcepts,
    moneyInflow: ov.moneyInflow,
    moneyOutflow: ov.moneyOutflow,
    loserSectors: ov.loserSectors,
  };
  return (
    '以下是当前 A 股盘面快照（含 A 股指数与外围关键指数 globalIndices：美股道指/纳指/标普/VIX恐慌指数、中概金龙指数、欧洲英德法、亚太恒生/日经/韩国/台湾/印度、汇率美元指数/离岸人民币/A50、美债收益率、加密，按 group 分区域，含点位/涨跌额/涨跌幅%/最高最低/振幅；A 股侧含成交额/涨停跌停炸板/连板梯队/板块资金流），请据此做一段大盘复盘点评：' +
    '总结指数与市场情绪温度（赚钱效应、连板高度）、领涨/领跌主线板块及资金流向逻辑、值得关注的风险提示，' +
    '并结合外围指数（美股/亚太/汇率）走势，给出一句 A 股+外围的综合方向判断（偏多/中性/偏空 + 理由）。' +
    '必要时用 mx_search / mx_finance_data 补充消息面或数据佐证。结论精炼、分点、给依据，禁止 Markdown 表格。\n\n' +
    JSON.stringify(snapshot)
  );
}

/**
 * 期货 + 外盘复盘点评 prompt（次日盘前触发）。聚焦商品期货与隔夜外盘对 A 股的传导，
 * 与大盘复盘（收盘）分工：盘前据此预判开盘方向与受益/承压板块。
 */
export function buildFuturesOverseasReviewPrompt(ov: MarketOverview): string {
  const snapshot = {
    futures: ov.futures,
    globalIndices: ov.globalIndices,
  };
  return (
    '以下是最新的期货价格（futures：国内主力连续 + 外盘商品，含品种名/最新价/涨跌幅%/分组）' +
    '与外围市场快照（globalIndices：按 group 分区域——美股道指/纳指/标普/VIX恐慌指数、中概纳斯达克金龙指数、欧洲英国富时/德国DAX/法国CAC40、亚太恒生/日经/韩国/台湾/印度、汇率美元指数/离岸人民币/美元日元/富时A50、债券美债10年收益率、加密比特币，含点位/涨跌额/涨跌幅%/最高最低/振幅）。' +
    '请做一段「期货 + 外盘」盘前复盘点评，服务于次日开盘前定调：' +
    '①梳理有色/黑色/贵金属/能化/新能源等商品的涨跌与背后逻辑（如金属涨价、原油波动），' +
    '判断对 A 股相关产业链板块/标的的传导方向（受益 / 承压）；' +
    '②结合隔夜外盘走势，重点参考中概金龙指数（最直接映射 A 股情绪）与 VIX 恐慌指数（避险情绪），给出对次日 A 股开盘情绪与方向的预判；' +
    '③列出值得盘前重点关注的板块或标的线索。' +
    '必要时用 mx_search / mx_finance_data 补充消息面或数据佐证。结论精炼、分点、给依据，禁止 Markdown 表格。\n\n' +
    JSON.stringify(snapshot)
  );
}
