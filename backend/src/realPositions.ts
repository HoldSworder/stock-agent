import { eq } from 'drizzle-orm';
import type { FundPosition, RealPortfolio, RealPosition } from '@stock-agent/shared';
import { db, schema } from './db/client';
import { getValue } from './settings';
import { newId, nowIso } from './util';
import { requestJson } from './datasource/httpClient';
import { num, shanghaiYmd } from './datasource/codes';

// 真实持仓数据源：直连同花顺投资账本接口，自给自足，无需 OpenViking / portfolio-sync。
// - stock_position：取股票持仓账本（股数 count、成本 cost、现金 money_remain），但其内嵌的
//   现价/当日盈亏是账本上次上传时的静态快照，可能滞后多日，不能直接用。
// - pass_quotes：取实时现价 xianjia、昨收 zuoshou，用它重算现价与今日实时盈亏。
// - account_list + merge_fund：取场外基金账户（manFund，如「支付宝/蚂蚁财富」）的逐只基金持仓；
//   merge_fund 由同花顺侧直接给出份额、成本净值、最新净值、市值与盈亏，口径与账户汇总一致，
//   无需再外接天天基金估值。
// 本模块合并归一化，并镜像落 positions 表（account=real）。

export class RealPositionError extends Error {}

const THS_BASE = 'https://tzzb.10jqka.com.cn/caishen_httpserver/tzzb/caishen_fund';
const STOCK_POSITION_URL = `${THS_BASE}/pc/asset/v1/stock_position`;
const PASS_QUOTES_URL = `${THS_BASE}/invest/v1/pass_quotes`;
const ACCOUNT_LIST_URL = `${THS_BASE}/pc/account/v1/account_list`;
const MERGE_FUND_URL = `${THS_BASE}/fund/v1/merge_fund`;

/** 调同花顺投资账本接口（form 编码 + Cookie 鉴权，统一走 httpClient），返回 ex_data */
async function thsPost(url: string, params: Record<string, string>): Promise<unknown> {
  const cookie = getValue('thsCookie');
  if (!cookie) throw new RealPositionError('同花顺 Cookie 未配置，请到设置页填写');

  const json = (await requestJson({
    sourceId: 'ths',
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams(params).toString(),
    // 网络/5xx/解析抖动重试；鉴权失效(401/403)与 error_code!=='0' 的逻辑错误不在此重试
    maxAttempts: 3,
    retryBaseMs: 300,
    isAuthFailure: (s) => s === 401 || s === 403,
    authFailureMessage: '同花顺 Cookie 已失效，请到设置页更新',
    errorLabel: '同花顺接口',
    makeError: (msg) => new RealPositionError(msg),
  })) as { error_code?: string; error_msg?: string; ex_data?: unknown };
  if (json.error_code !== '0') {
    throw new RealPositionError(`同花顺接口返回异常: ${json.error_msg ?? json.error_code}`);
  }
  return json.ex_data;
}

interface RawHolding {
  code: string;
  name: string;
  market: string;
  count: number;
  cost: number;
  holdDays: number;
  /** 原始现价（账本侧，清仓行用于展示，无需实时报价） */
  rawPrice: number;
  /** 原始已实现/持有盈亏（清仓行直接复用，不可用 count*(price-cost) 重算） */
  rawHoldProfit: number;
  /** 原始持有盈亏率 */
  rawHoldRate: number;
}

/** 拉取持仓账本：逐 fund_key 调用并合并 position 列表、累加现金 */
async function fetchLedger(userId: string, fundKeys: string[]): Promise<{
  holdings: RawHolding[];
  cash: number;
}> {
  const holdings: RawHolding[] = [];
  let cash = 0;

  for (const fundKey of fundKeys) {
    const exData = (await thsPost(STOCK_POSITION_URL, {
      terminal: '1',
      version: '0.0.0',
      userid: userId,
      user_id: userId,
      manual_id: '',
      fund_key: fundKey,
      rzrq_fund_key: '',
    })) as { money_remain?: unknown; position?: unknown };

    cash += num(exData.money_remain);
    const list = Array.isArray(exData.position)
      ? (exData.position as Array<Record<string, unknown>>)
      : [];
    for (const p of list) {
      holdings.push({
        code: String(p.code ?? ''),
        name: String(p.name ?? ''),
        market: String(p.market ?? ''),
        count: num(p.count),
        cost: num(p.cost),
        holdDays: num(p.hold_days),
        rawPrice: num(p.price),
        rawHoldProfit: num(p.hold_profit),
        rawHoldRate: num(p.hold_rate),
      });
    }
  }
  return { holdings, cash };
}

interface Quote {
  price: number;
  prevClose: number;
}

/** 拉取实时报价：返回 code -> {现价, 昨收}，并附带报价时间戳 */
async function fetchQuotes(
  userId: string,
  holdings: RawHolding[],
  dateCompact: string,
): Promise<{ quotes: Map<string, Quote>; asOf: string }> {
  const quotes = new Map<string, Quote>();
  if (holdings.length === 0) return { quotes, asOf: nowIso() };

  const codeParam = holdings.map((h) => `${h.market}:${h.code}`).join(',');
  const resp = (await thsPost(PASS_QUOTES_URL, {
    terminal: '1',
    version: '0.0.0',
    userid: userId,
    user_id: userId,
    code: codeParam,
    date: dateCompact,
  })) as unknown;

  // pass_quotes 的 ex_data 是数组；其时间戳在外层 json.timestamp，但 thsPost 只回 ex_data，
  // 报价时间用本地当前时间近似即可（数据本身已是实时）。
  const list = Array.isArray(resp) ? (resp as Array<Record<string, unknown>>) : [];
  for (const q of list) {
    const code = String(q.zqdm ?? '');
    if (!code) continue;
    quotes.set(code, { price: num(q.xianjia), prevClose: num(q.zuoshou) });
  }
  return { quotes, asOf: nowIso() };
}

function normalize(h: RawHolding, q: Quote | undefined, totalAsset: number): RealPosition {
  // 有实时报价用实时价，否则退回成本价（避免 0 价导致市值异常）
  const price = q && q.price > 0 ? q.price : h.cost;
  const prevClose = q && q.prevClose > 0 ? q.prevClose : price;
  const marketValue = h.count * price;
  const holdProfit = h.count * (price - h.cost);
  const todayProfit = h.count * (price - prevClose);
  return {
    code: h.code,
    name: h.name,
    market: h.market,
    qty: h.count,
    avgCost: h.cost,
    price,
    marketValue,
    holdProfit,
    holdRate: h.cost > 0 ? (price - h.cost) / h.cost : 0,
    todayProfit,
    todayRate: prevClose > 0 ? (price - prevClose) / prevClose : 0,
    positionRate: totalAsset > 0 ? marketValue / totalAsset : 0,
    holdDays: h.holdDays,
  };
}

/** 构造当日清仓行：qty=0，盈亏用原始已实现值（不可重算） */
function toClosed(h: RawHolding): RealPosition {
  return {
    code: h.code,
    name: h.name,
    market: h.market,
    qty: 0,
    avgCost: h.cost,
    price: h.rawPrice,
    marketValue: 0,
    holdProfit: h.rawHoldProfit,
    holdRate: h.rawHoldRate,
    todayProfit: 0,
    todayRate: 0,
    positionRate: 0,
    holdDays: h.holdDays,
  };
}

// ===== 场外基金（同花顺账本 manFund 账户：account_list + merge_fund）=====

/** merge_fund 单只基金行归一化后的中间结构（份额/成本净值/净值/市值/盈亏均取自同花顺） */
interface RawFund {
  code: string;
  name: string;
  shares: number;
  costNav: number;
  nav: number;
  marketValue: number;
  holdProfit: number;
  holdRate: number;
  todayProfit: number;
  todayRate: number;
  /** 数据同步日期（synchro_date） */
  syncDate: string;
}

/** 取场外基金账户列表（manFund），返回 fundId 与账户名 */
async function fetchFundAccounts(userId: string): Promise<Array<{ fundId: string; name: string }>> {
  const exData = (await thsPost(ACCOUNT_LIST_URL, {
    terminal: '1',
    version: '0.0.0',
    userid: userId,
    user_id: userId,
    manual_id: '',
  })) as { fund?: unknown };
  const list = Array.isArray(exData.fund) ? (exData.fund as Array<Record<string, unknown>>) : [];
  return list
    .map((f) => ({ fundId: String(f.fundId ?? ''), name: String(f.fundname ?? '') }))
    .filter((f) => f.fundId.length > 0);
}

/** 逐基金账户拉逐只持仓（merge_fund）；同花顺已算好净值/市值/盈亏，直接采用 */
async function fetchFundHoldings(userId: string): Promise<RawFund[]> {
  const accounts = await fetchFundAccounts(userId);
  const holdings: RawFund[] = [];
  for (const acc of accounts) {
    const exData = (await thsPost(MERGE_FUND_URL, {
      terminal: '1',
      version: '0.0.0',
      userid: userId,
      user_id: userId,
      from_id: 'pcweb',
      custid: '',
      fundid: acc.fundId,
    })) as { account?: { synchro_date?: unknown }; fund?: unknown };

    const syncDate = String(exData.account?.synchro_date ?? '');
    const rows = Array.isArray(exData.fund) ? (exData.fund as Array<Record<string, unknown>>) : [];
    for (const p of rows) {
      const code = String(p.fundcode ?? '');
      const shares = num(p.fundcount);
      if (!code || shares <= 0) continue; // 跳过空/已清仓行
      holdings.push({
        code,
        name: String(p.fundname ?? ''),
        shares,
        costNav: num(p.percost),
        nav: num(p.fundnav),
        marketValue: num(p.fundvalue),
        holdProfit: num(p.posprofit),
        holdRate: num(p.pospercent),
        // 盘中 now_profit/now_rate 为估算值，盘后为空串 -> 归零
        todayProfit: num(p.now_profit),
        todayRate: num(p.now_rate),
        syncDate,
      });
    }
  }
  return holdings;
}

function normalizeFund(h: RawFund, totalAsset: number): FundPosition {
  return {
    code: h.code,
    name: h.name,
    shares: h.shares,
    costNav: h.costNav,
    nav: h.nav,
    marketValue: h.marketValue,
    holdProfit: h.holdProfit,
    holdRate: h.holdRate,
    todayProfit: h.todayProfit,
    todayRate: h.todayRate,
    positionRate: totalAsset > 0 ? h.marketValue / totalAsset : 0,
    estAvailable: h.nav > 0,
    asOf: h.syncDate,
  };
}

/** 把真实持仓镜像写入 positions 表（先清旧 real 行，再写当前快照） */
function persist(portfolio: RealPortfolio): void {
  db.delete(schema.positions).where(eq(schema.positions.account, 'real')).run();
  const rows = [
    ...portfolio.positions.map((p) => ({
      code: p.code,
      name: p.name,
      qty: p.qty,
      avgCost: p.avgCost,
      price: p.price,
      marketValue: p.marketValue,
      profit: p.holdProfit,
    })),
    ...portfolio.funds.map((f) => ({
      code: f.code,
      name: f.name,
      qty: f.shares,
      avgCost: f.costNav,
      price: f.nav,
      marketValue: f.marketValue,
      profit: f.holdProfit,
    })),
  ];
  for (const r of rows) {
    db.insert(schema.positions)
      .values({ id: newId(), account: 'real', ...r, snapshotAt: portfolio.asOf })
      .run();
  }
}

/** 拉取场外基金持仓；任何失败都不影响股票部分，返回空列表 */
async function loadFunds(userId: string): Promise<RawFund[]> {
  try {
    return await fetchFundHoldings(userId);
  } catch {
    // 基金账户缺失/接口异常：仅记空，股票持仓正常返回
    return [];
  }
}

/**
 * 读取真实持仓：直连同花顺投资账本（持仓账本 + 实时报价），实时计算盈亏。
 */
export async function fetchRealPositions(persistSnapshot = true): Promise<RealPortfolio> {
  const userId = getValue('thsUserId');
  if (!userId) throw new RealPositionError('同花顺 UID 未配置，请到设置页填写');
  const fundKeys = getValue('thsFundKeys')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fundKeys.length === 0) throw new RealPositionError('同花顺 fund_key 未配置，请到设置页填写');

  const { ymd, compact } = shanghaiYmd(new Date());
  const { holdings, cash } = await fetchLedger(userId, fundKeys);

  // 拆分实际持有（count>0）与当日清仓（count<=0）；只对持有标的取实时报价
  const held = holdings.filter((h) => h.count > 0);
  const closed = holdings.filter((h) => h.count <= 0);
  const { quotes, asOf } = await fetchQuotes(userId, held, compact);

  // 场外基金（蚂蚁财富等）：同花顺账本 manFund 账户逐只持仓（净值/市值/盈亏由同花顺给出）
  const rawFunds = await loadFunds(userId);

  // 先算股票市值与基金市值，得到总资产后再统一计算仓位占比
  let stockMarketValue = 0;
  for (const h of held) {
    const q = quotes.get(h.code);
    const price = q && q.price > 0 ? q.price : h.cost;
    stockMarketValue += h.count * price;
  }
  const fundMarketValue = rawFunds.reduce((s, f) => s + f.marketValue, 0);
  const totalMarketValue = stockMarketValue + fundMarketValue;
  const totalAsset = cash + totalMarketValue;

  const positions = held.map((h) => normalize(h, quotes.get(h.code), totalAsset));
  const funds = rawFunds.map((f) => normalizeFund(f, totalAsset));
  const closedToday = closed.map(toClosed);

  const portfolio: RealPortfolio = {
    asOf,
    sourceDate: ymd,
    source: '同花顺投资账本',
    cash,
    positionCount: positions.length + funds.length,
    totalMarketValue,
    fundMarketValue,
    totalAsset,
    totalHoldProfit:
      positions.reduce((s, p) => s + p.holdProfit, 0) + funds.reduce((s, f) => s + f.holdProfit, 0),
    totalTodayProfit:
      positions.reduce((s, p) => s + p.todayProfit, 0) +
      funds.reduce((s, f) => s + f.todayProfit, 0),
    positions,
    funds,
    closedToday,
  };
  if (persistSnapshot) persist(portfolio);
  return portfolio;
}

/** 同花顺连通性探测（数据源页健康检查用）：取场外基金账户列表，需 Cookie + UID */
export async function pingThs(): Promise<void> {
  const userId = getValue('thsUserId');
  if (!userId) throw new RealPositionError('同花顺 UID 未配置，请到设置页填写');
  await fetchFundAccounts(userId);
}
