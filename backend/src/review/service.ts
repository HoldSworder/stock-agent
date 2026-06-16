import type { MarketReviewResult, PlanFulfillment } from '@stock-agent/shared';
import { buildOverview } from '../market/overview';
import { getQuotes } from '../market/eastmoney';
import { fetchRealPositions } from '../realPositions';
import { listWatch } from '../watchlist';
import { listMarketBoardReviews, listReviews } from '../repo';
import { miaoxiang } from '../miaoxiang/client';
import { ingestFromReview, listThemes, refreshThemes } from '../themes/service';
import { computePlanFulfillment } from '../plan/service';

// 妙想原始响应压缩：超长时保留头部，避免注入 prompt 撑爆 token。
function mxPreview(value: unknown, max = 3000): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length <= max ? s : `${s.slice(0, max)}\n...[已截断 ${s.length - max} 字符]`;
}

/** 妙想取数包装：失败即降级为给定占位文案，避免单点失败拖垮整份复盘。 */
async function mxSafe(
  fn: () => Promise<unknown>,
  fallback: string,
  max: number,
): Promise<string> {
  try {
    return mxPreview(await fn(), max);
  } catch {
    return fallback;
  }
}

// 一键深度复盘：以盘面快照 + 真实持仓 + 自选股池 + 上次复盘为上下文，
// 让 agent 强制输出结构化 JSON 供前端模块化渲染。
// 原内联于 server.ts /ws/review，抽出供「流式一键复盘」与「review.eod 定时深度复盘」共用。

/** 复盘运行的统一任务名（前端 listReviews 历史按此过滤，定时与手动共用） */
export const DEEP_REVIEW_TASK_NAME = '一键复盘';

/**
 * 把结构化深度复盘 + 计划兑现度统计压成一条简明 Telegram 摘要（确定性组装，不再让模型决定推送内容）。
 * 原 market.review（15:05 大盘点评直推 TG）已并入收盘深度复盘，由此 digest 承接其推送职责。
 * 解析失败时降级为纯兑现度提示，保证至少推出可用信息。
 */
export function buildReviewDigest(jsonText: string, fulfillment: PlanFulfillment | null): string {
  const lines: string[] = [];
  try {
    const r = JSON.parse(jsonText) as Partial<MarketReviewResult>;
    if (r.comprehensiveStance) {
      const s = r.comprehensiveStance;
      lines.push(`方向：${s.bias ?? '—'}　${(s.summary ?? '').slice(0, 80)}`);
    } else if (r.marketTrend) {
      lines.push(`大盘：${r.marketTrend.slice(0, 80)}`);
    }
    const themes = (r.mainThemes ?? [])
      .slice(0, 3)
      .map((t) => `${t.name}${t.strength ? `(${t.strength})` : ''}`)
      .filter(Boolean);
    if (themes.length) lines.push(`主线：${themes.join('、')}`);
    const risks = (r.risks ?? []).slice(0, 2).map((x) => x.title).filter(Boolean);
    if (risks.length) lines.push(`风险：${risks.join('；')}`);
    const focus = (r.tomorrowPlan?.focus ?? []).slice(0, 3).filter(Boolean);
    if (focus.length) lines.push(`明日：${focus.join('、')}`);
  } catch {
    lines.push('深度复盘已生成（结构化结果见 WebUI）。');
  }
  if (fulfillment && fulfillment.total > 0) {
    const rate = fulfillment.hitRate != null ? `${Math.round(fulfillment.hitRate * 100)}%` : '—';
    lines.push(
      `计划兑现：命中 ${fulfillment.triggered}/${fulfillment.withTrigger}（${rate}）` +
        ` 失效${fulfillment.invalid} 待触发${fulfillment.pending}`,
    );
  }
  return `📊 收盘复盘摘要\n${lines.join('\n')}`;
}

/**
 * 深度复盘成功完成后的统一回调：把复盘 mainThemes 的验证结论结构化回流共享主线
 * （写 phase / 调整强度与退潮态），闭合阶段 B「复盘验证 → 主线回流」。
 * best-effort，绝不抛错阻断复盘落库；供 review.eod 定时与 /ws/review 手动流式共用。
 */
export function onDeepReviewComplete(jsonText: string | null): void {
  if (!jsonText) return;
  try {
    const n = ingestFromReview(jsonText);
    if (n > 0) console.log(`[review] 复盘验证回流共享主线 ${n} 条`);
  } catch (e) {
    console.warn('[review] 复盘主线回流失败:', e instanceof Error ? e.message : e);
  }
}

/** 组装深度复盘 prompt（含盘面/持仓/自选/上次复盘上下文，best-effort 降级） */
export async function buildDeepReviewPrompt(): Promise<string> {
  // 盘面快照（必备）+ 真实持仓（best-effort，未配置 Cookie 时降级）
  const ov = await buildOverview();
  let positionsNote = '真实持仓数据不可用（未配置同花顺 Cookie 或拉取失败）。';
  try {
    const pf = await fetchRealPositions();
    positionsNote =
      `总资产${pf.totalAsset.toFixed(2)} 现金${pf.cash.toFixed(2)} 持仓市值${pf.totalMarketValue.toFixed(2)} ` +
      `当日盈亏${pf.totalTodayProfit.toFixed(2)}\n` +
      (pf.positions.length
        ? pf.positions
            .map(
              (p) =>
                `- ${p.name}(${p.code}) 现价${p.price} 成本${p.avgCost} ${p.qty}股 ` +
                `今日${p.todayProfit.toFixed(0)}(${(p.todayRate * 100).toFixed(2)}%) ` +
                `持有盈亏${p.holdProfit.toFixed(0)}(${(p.holdRate * 100).toFixed(2)}%) 仓位${(p.positionRate * 100).toFixed(1)}%`,
            )
            .join('\n')
        : '当前空仓。');
  } catch {
    /* 降级：positionsNote 保持不可用提示 */
  }

  // 自选股池今日表现（best-effort）
  let watchNote = '自选股池为空或拉取失败。';
  try {
    const items = listWatch();
    if (items.length > 0) {
      const quotes = await getQuotes(items.map((i) => i.code));
      const qm = new Map(quotes.map((q) => [q.code, q]));
      watchNote = items
        .map((i) => {
          const q = qm.get(i.code);
          const pctStr = q ? `${q.pct >= 0 ? '+' : ''}${q.pct.toFixed(2)}%` : '—';
          return `- ${i.name}(${i.code})${i.tags ? ` [${i.tags}]` : ''} 今日${pctStr}`;
        })
        .join('\n');
    }
  } catch {
    /* 降级 */
  }

  // 近日复盘对比：取上一条成功复盘，抽取主线与走势用于延续/切换判断
  let prevReviewNote = '无历史复盘可对比（首次复盘）。';
  try {
    const prev = listReviews(2).find((r) => r.outputText);
    if (prev?.outputText) {
      const obj = JSON.parse(prev.outputText) as Partial<MarketReviewResult>;
      const themes = (obj.mainThemes ?? []).map((t) => t.name).filter(Boolean).join('、');
      prevReviewNote =
        `上次复盘（${prev.createdAt}）：` +
        `主线=${themes || '未记录'}；走势=${(obj.marketTrend ?? '').slice(0, 120)}`;
    }
  } catch {
    /* 历史解析失败忽略 */
  }

  // 共享市场主线（待验证）：先刷新当日板块主线，再取活跃主线清单 + 最新板块研判结论，
  // 让复盘逐条对照验证（延续/加速/分歧/退潮/证伪），结论经 ingestFromReview 回流 themes。
  let sharedThemesNote = '暂无共享市场主线（板块聚合未产出）。';
  try {
    await refreshThemes().catch(() => {});
    const themeLines = listThemes(false)
      .slice(0, 10)
      .map(
        (t) =>
          `- ${t.theme}｜强度${Math.round(t.strength)}｜${t.status}/${t.phase}｜来源${t.sources.length}` +
          `${t.evidence[0]?.text ? `｜${t.evidence[0].text}` : ''}`,
      );
    const board = listMarketBoardReviews(1)[0];
    const boardNote = board?.outputText ? `\n[最新大盘与板块研判]\n${board.outputText.slice(0, 1200)}` : '';
    if (themeLines.length) sharedThemesNote = `${themeLines.join('\n')}${boardNote}`;
  } catch {
    /* 主线源异常忽略，复盘照常 */
  }

  // 计划兑现度（纯代码统计，不调模型）：供复盘点评今日计划命中率，闭合「兑现度入复盘」。
  let fulfillmentNote = '暂无今日计划兑现度数据。';
  try {
    const f = computePlanFulfillment();
    if (f && f.total > 0) {
      const rate = f.hitRate != null ? `${Math.round(f.hitRate * 100)}%` : '—';
      fulfillmentNote =
        `计划项${f.total}（含触发价${f.withTrigger}）：命中${f.triggered}（${rate}）` +
        ` 失效${f.invalid} 待触发${f.pending}`;
    }
  } catch {
    /* 兑现度异常忽略 */
  }

  // 妙想确定性取数（全部 best-effort 降级，并行预取，不占 agent step）：
  // 把强势板块/个股、龙虎榜资金、情绪量化、消息面与妙想综合研判一次性注入 prompt，
  // 让本地 agent 优先基于这些权威数据归纳，减少臆测、也不依赖 agent 主动调用工具。
  const [mxSectorNote, mxStockNote, mxDragonNote, mxSentimentNote, mxNewsNote, mxJudgeNote] =
    await Promise.all([
      mxSafe(
        () =>
          miaoxiang.financeData(
            '今日涨幅居前的行业板块与概念板块各前5名，给出板块名、涨幅、领涨个股',
          ),
        '妙想强势板块数据不可用（未配置 MX_APIKEY 或请求失败）。',
        2500,
      ),
      mxSafe(
        () =>
          miaoxiang.screener(
            '今日强势放量上涨、量价配合良好的主板/创业板个股，按强度排序取前10，排除ST、科创板688、北交所',
          ),
        '妙想强势个股数据不可用（未配置 MX_APIKEY 或请求失败）。',
        2500,
      ),
      mxSafe(
        () =>
          miaoxiang.financeData(
            '今日龙虎榜机构席位与知名游资净买入前列个股各前8名，给出股票名、代码、净买入额、席位性质',
          ),
        '妙想龙虎榜数据不可用（未配置 MX_APIKEY 或请求失败）。',
        2500,
      ),
      mxSafe(
        () =>
          miaoxiang.financeData(
            '今日市场情绪量化：昨日涨停个股今日平均溢价率、连板晋级率、炸板率、最高连板高度、涨跌停家数',
          ),
        '妙想情绪量化数据不可用（未配置 MX_APIKEY 或请求失败）。',
        2500,
      ),
      mxSafe(
        () => miaoxiang.search('今日A股盘后重要政策、行业事件、机构观点与次日可能的进攻方向'),
        '妙想消息面数据不可用（未配置 MX_APIKEY 或请求失败）。',
        4000,
      ),
      mxSafe(
        () =>
          miaoxiang.financeData(
            '基于今日A股收盘盘面，给出专业研判：情绪周期定位（启动/发酵/高潮/退潮/冰点）、当前主线题材、资金风格切换、明日方向与仓位倾向',
          ),
        '妙想综合研判不可用（未配置 MX_APIKEY 或请求失败）。',
        4000,
      ),
    ]);

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
    topLosers: ov.topLosers,
    topTurnover: ov.topTurnover,
  };

  return (
    '请基于以下 A 股盘面快照、我的真实持仓、自选股池与上次复盘，做一份当日收盘的【深度多维复盘】。' +
    '下方已提供绝大部分所需数据，请【优先直接基于这些数据】完成复盘，尽快产出结论；' +
    '仅在主线题材的消息面/资金面有重大存疑时才调用 mx_search / mx_finance_data 补充，全程工具调用务必控制在 3 次以内，' +
    '不要调用与复盘无关的工具（如选股、下单、保存自选）。持仓中 holdDays<=1 视为今日新开仓，用于操作复盘（卖出数据不可得则注明）。\n\n' +
    '【权威数据优先】下方【妙想综合研判】为东方财富金融大模型对今日盘面的专业判断，' +
    '情绪周期定位、资金风格切换、主线题材、明日方向应优先采信妙想研判，本地仅负责结构化并结合我的真实持仓微调，不要凭空臆测。\n\n' +
    '复盘需覆盖以下全部维度：①大盘走势综述（指数、成交额、放缩量）；②市场情绪综述（涨跌停、炸板率、连板高度）；' +
    '③情绪周期定位（启动/发酵/高潮/退潮/冰点 + 赚钱/亏钱效应）；④资金面深度（北向、主力、两融、量能、风格切换）；' +
    '⑤连板梯队质量（晋级率、炸板率、最高板高度、高度板分歧、涨停溢价率 limitUpPremium，溢价率优先取【妙想情绪量化】）；' +
    '⑥当前主线题材判断（结合梯队/资金流/概念，主线名称+强度阶段+依据，可多条按强度排序）；' +
    '【主线验证】请逐条对照下方【共享市场主线（待验证）】清单，对每条主线给出 verdict（延续/加速/分歧/退潮/证伪），' +
    '不得凭空另起清单外的主线（确有新主线时在 reason 注明「新增」）；' +
    '⑦热门板块与细分概念；⑧热门个股；⑨逐只持仓复盘（今日表现+去留建议）；⑩我的今日操作复盘（针对今日新开仓标的评估对错，并结合下方【计划兑现度】点评今日计划命中得失）；' +
    '⑪自选股池复盘（强弱定性+点评）；⑫风险警示（外围/监管/获利盘/退潮信号）；⑬明日策略（重点关注、应对预案、仓位建议）；' +
    '⑭与近日对比（主线延续还是切换、情绪趋势）；⑮操作建议；' +
    '⑯外围市场综述（基于 globalIndices 美股/亚太/汇率/A50 走势，逐个给走势定性与对 A 股影响）；' +
    '⑰A股+外围综合方向判断（综合 A 股盘面与外围给出 偏多/中性/偏空 + 一句话定调 + 关键驱动，作为今日计划的大环境趋势基准）；' +
    '⑱妙想强势板块/强势个股（基于下方【妙想强势板块/个股】数据归纳，逐项给出推荐原因；个股仅保留主板/创业板可交易标的，不要自行调用选股工具）；' +
    '⑲龙虎榜资金动向 dragonTiger（基于【妙想龙虎榜】数据，机构/游资净买入合力个股，判断资金性质）；' +
    '⑳情绪标杆 sentimentBenchmark（次日盯盘锚点：弱转强/强转弱/空间龙/主线龙头，给走势反馈点评）。\n\n' +
    '【篇幅控制】为保证 JSON 完整不被截断，请务必精炼：每个文本字段控制在 60 字以内；' +
    'mainThemes≤4、hotSectors≤6、hotStocks≤8、strongSectors≤6、strongStocks≤8、dragonTiger≤6、sentimentBenchmark≤5、watchlistReview 只列值得关注者、risks≤4、suggestions≤6、tomorrowPlan.focus/contingency 各≤4、overseasMarkets≤6、comprehensiveStance.drivers≤4。\n' +
    '【严格输出要求】最终回答只输出一个【完整且合法】的 JSON 对象（务必闭合所有括号），不要任何额外文字、解释或 Markdown 代码围栏，结构如下：\n' +
    '{' +
    '"marketTrend":"string","emotionNote":"string",' +
    '"emotionCycle":{"phase":"启动|发酵|高潮|退潮|冰点","moneyEffect":"string","note":"string"},' +
    '"capitalFlow":{"northbound":"string","mainForce":"string","margin":"string","volume":"string","styleNote":"string"},' +
    '"ladderQuality":{"promotionRate":"string","brokenRate":"string","maxHeight":"string","divergence":"string","limitUpPremium":"string"},' +
    '"dragonTiger":[{"code":"string","name":"string","netBuy":"string","note":"string"}],' +
    '"sentimentBenchmark":[{"type":"弱转强|强转弱|空间龙|主线龙头","code":"string","name":"string","note":"string"}],' +
    '"mainThemes":[{"name":"string","strength":"string","reason":"string","verdict":"延续|加速|分歧|退潮|证伪"}],' +
    '"hotSectors":[{"name":"string","kind":"行业|概念","note":"string"}],' +
    '"hotStocks":[{"code":"string","name":"string","note":"string"}],' +
    '"strongSectors":[{"name":"string","reason":"string","leader":"string"}],' +
    '"strongStocks":[{"code":"string","name":"string","reason":"string"}],' +
    '"positionsReview":[{"code":"string","name":"string","todayNote":"string","action":"持有|加仓|减仓|清仓|观望"}],' +
    '"myTradesReview":[{"code":"string","name":"string","assessment":"string","verdict":"正确|失误|中性|待观察"}],' +
    '"watchlistReview":[{"code":"string","name":"string","strength":"string","note":"string"}],' +
    '"risks":[{"title":"string","detail":"string"}],' +
    '"tomorrowPlan":{"focus":["string"],"contingency":["string"],"positionAdvice":"string"},' +
    '"trendComparison":{"mainlineContinuity":"string","emotionTrend":"string","note":"string"},' +
    '"overseasMarkets":[{"name":"string","region":"美股|亚太|汇率","trend":"string","impact":"string"}],' +
    '"comprehensiveStance":{"bias":"偏多|中性|偏空","summary":"string","drivers":["string"]},' +
    '"suggestions":["string"]' +
    '}\n' +
    '数据不可用的维度：对象类字段可省略或置 null，数组类字段返回空数组。action 与 verdict 必须是给定枚举之一。\n\n' +
    '=== 盘面快照 ===\n' +
    JSON.stringify(snapshot) +
    '\n\n=== 真实持仓 ===\n' +
    positionsNote +
    '\n\n=== 自选股池 ===\n' +
    watchNote +
    '\n\n=== 上次复盘 ===\n' +
    prevReviewNote +
    '\n\n=== 共享市场主线（待验证，逐条给 mainThemes[].verdict）===\n' +
    sharedThemesNote +
    '\n\n=== 计划兑现度（今日计划命中统计，用于操作复盘点评）===\n' +
    fulfillmentNote +
    '\n\n=== 妙想综合研判（权威源，情绪周期/资金风格/主线/明日方向优先采信）===\n' +
    mxJudgeNote +
    '\n\n=== 妙想强势板块/个股（原始数据，用于 strongSectors/strongStocks 归纳）===\n' +
    '[强势板块]\n' +
    mxSectorNote +
    '\n[强势个股]\n' +
    mxStockNote +
    '\n\n=== 妙想龙虎榜（原始数据，用于 dragonTiger 归纳）===\n' +
    mxDragonNote +
    '\n\n=== 妙想情绪量化（原始数据，用于 ladderQuality.limitUpPremium / 情绪综述）===\n' +
    mxSentimentNote +
    '\n\n=== 妙想消息面/政策面（原始数据，用于风险与明日进攻方向）===\n' +
    mxNewsNote
  );
}
