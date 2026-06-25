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
import { buildSentimentOverview, formatForAgent as formatSentiment } from '../sentiment/service';
import { buildMacroOverview, formatMacroForAgent } from './macro';
import { buildUsMapping, formatUsMappingForAgent } from './usMapping';

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

/** 大盘与板块研判统一任务名（大盘复盘点评 + 板块主线研判合并为单一 AI 分析） */
export const MARKET_BOARD_TASK_NAME = '大盘与板块研判';

/**
 * 大盘与板块研判 prompt（合并原「大盘复盘点评」+「板块主线研判」为一次 agent 运行）：
 * 先据盘面快照做大盘复盘点评，再调 market_board_strength 取确定性板块底稿过滤主线，输出一份两段式研判。
 * 成功落 taskRun（taskName=大盘与板块研判），同时作为今日计划的「大盘 + 板块/中线」基准源。
 */
export async function buildMarketBoardPrompt(ov: MarketOverview): Promise<string> {
  const snapshot = {
    indices: ov.indices,
    globalIndices: ov.globalIndices,
    futures: ov.futures,
    turnoverTotal: ov.turnoverTotal,
    emotion: ov.emotion,
    ladder: ov.ladder,
    hotIndustries: ov.hotIndustries,
    hotConcepts: ov.hotConcepts,
    moneyInflow: ov.moneyInflow,
    moneyOutflow: ov.moneyOutflow,
    loserSectors: ov.loserSectors,
  };
  // 情绪周期确定性底稿（S1 短线择时总开关）：best-effort，取数失败则跳过该段，不阻断研判。
  // persist=false：研判可盘中多次触发，不污染收盘定值快照。
  let sentimentBlock = '';
  try {
    const sent = await buildSentimentOverview(false);
    sentimentBlock = `\n\n【市场情绪周期·确定性底稿】\n${formatSentiment(sent)}\n`;
  } catch {
    /* 情绪取数失败：研判退回仅用盘面快照的情绪温度 */
  }
  // 宏观·资金面确定性底稿（基差/SHIBOR/降准/两融/南向/估值分位）：best-effort，失败则跳过该段。
  let macroBlock = '';
  try {
    const macro = await buildMacroOverview();
    macroBlock = `\n\n${formatMacroForAgent(macro)}\n`;
  } catch {
    /* 宏观取数失败：研判退回不含宏观底稿 */
  }
  // 美股映射确定性底稿（隔夜美股龙头/行业 → A股概念·ETF·个股）：best-effort，失败则跳过该段。
  let usMapBlock = '';
  try {
    const usMap = await buildUsMapping();
    if (usMap) usMapBlock = `\n\n${formatUsMappingForAgent(usMap)}\n`;
  } catch {
    /* 美股映射取数失败：研判退回不含映射底稿 */
  }
  return (
    '做一次「大盘与板块研判」，把大盘复盘点评、板块主线研判与期货+外盘传导合并为一份报告，供今日计划直接引用。只研判、不下单、不取个股交易动作。\n\n' +
    '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续，不据此判休市。\n\n' +
    '第1步 大盘复盘（据下方盘面快照）：快照含 A 股指数与外围关键指数 globalIndices（美股道指/纳指/标普/VIX、中概金龙、欧洲、亚太、汇率、美债、加密，按 group 分区域）；A 股侧含成交额/涨停跌停炸板/连板梯队/板块资金流。据此总结：①指数走势与「情绪温度档位」——优先采用下方【市场情绪周期·确定性底稿】的 0-100 情绪指数与周期阶段（冰点/恢复/高潮/退潮/震荡）定位情绪，再结合赚钱效应（涨停数/炸板率）、连板高度、量能（放量/温和/缩量），明确判为【高涨/温和/低迷】之一，并据情绪指数与周期校准择时与仓位倾向（高潮防追高、退潮降仓、恢复试错、冰点观望）；②资金面持续性（主力净流入是延续还是衰减、是否单日脉冲），并参考下方【宏观·资金面·确定性底稿】的两融融资余额趋势、南向资金延续性，以及 SHIBOR/降准反映的流动性松紧、沪深300估值分位、股指期货基差（IM/IC 贴水=中小盘情绪偏弱），并参考股指期货持仓榜（中信/前20 净持仓与日增减）反映的机构对冲方向（增减比绝对值更有意义，中信单家含套保盘需结合前20合计看）——这些一律作为「环境背景与仓位倾向护栏」，不据此追高或抄底；③领涨/领跌主线板块及资金流向逻辑；④风险提示；并结合外围给出一句 A 股+外围综合方向判断（偏多/中性/偏空 + 理由）。\n' +
    '第2步 板块主线（取确定性底稿）：调用 market_board_strength 一次，拿到「行业/概念按中线强度排序的强弱榜」+「真实板块归并的市场主线（含资金净流入/领涨/状态/来源数）」。这是板块研判的事实基础，禁止凭空编造板块或强度。结合中线强度（均线/动量，非当日涨幅）+ 资金净流入持续性 + 来源数，区分①确定性主线 ②值得中线跟踪 ③应剔除的噪声/退潮。\n' +
    '第3步 期货+外盘传导（据快照 futures 国内外商品期货 + globalIndices 隔夜外盘）：①梳理有色/黑色/贵金属/能化/新能源等商品涨跌逻辑，判断对 A 股相关产业链板块的传导方向（受益/承压）；②结合隔夜外盘，重点参考中概金龙指数（最直接映射 A 股情绪）与 VIX 恐慌指数（避险情绪），预判次日开盘情绪与方向；③参考下方【美股映射·确定性底稿】——隔夜领涨/领跌的美股行业/主题 ETF 及其 A 股概念/ETF 桥接，作次日盘前情绪/方向背景，但务必结合第2步系统给出的真实 A 股板块强弱做动态印证：仅当美股某板块强势、且 A 股对应概念也同步走强（两边共振）时，才作为主线候选；单边美股强而 A 股对应板块并未启动的，视为弱信号、不据此追高。同时留意中美脱钩下「美股芯片利空→A 股国产替代利好」的反向逻辑；映射统一让位于第2步本土主线与资金面，非择时信号。\n' +
    '必要时用 mx_search / mx_finance_data 补充消息面或数据佐证（最多各一次）。结论精炼、分点、给依据，禁止 Markdown 表格。\n\n' +
    '输出（竖排清单，控制在两屏内，标注数据时间）：\n' +
    '📊 一、大盘复盘：指数走势 / 情绪温度档位（高涨·温和·低迷 + 依据）/ 资金面持续性 / 领涨领跌主线与资金 / 风险提示 / 一句话 A 股+外围方向（偏多·中性·偏空 + 理由）\n' +
    '🧭 二、板块主线研判：①今日确定性主线（≤4 条：主线名｜中线强度趋势｜资金面｜领涨｜可信度理由）②中线值得跟踪（≤4 条）③剔除/退潮提示（≤3 条）\n' +
    '🌐 三、期货+外盘传导：①商品涨跌对 A 股产业链的受益/承压传导（≤4 条）②隔夜外盘对次日开盘情绪/方向预判（含金龙指数与 VIX）③值得盘前关注的板块/标的线索（≤3 条）\n' +
    '🎯 四、一句话结论：当前市场主线方向与中线风格，并明确给出「今日择时判断」——今日是否适合个股短线进攻（适合/谨慎/回避）+ 建议仓位倾向（进攻 60-90% / 均衡 30-60% / 防守 ≤30%），供今日计划择时闸门直接采用。\n' +
    '⚠️ 确定性指标研判，仅供参考，不构成投资建议。\n' +
    sentimentBlock +
    macroBlock +
    usMapBlock +
    '\n' +
    JSON.stringify(snapshot)
  );
}
