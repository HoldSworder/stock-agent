import { getValue } from '../settings';
import { requestJson } from '../datasource/httpClient';

// 华泰证券 AI 网关（涨乐/妙想 edge gate）官方接口薄封装。
// 五个 skill（指标行情 / 分析诊断 / 条件选股 / 模拟交易 / 自选管理）共用同一网关
// （<baseUrl>/edge/entry/gate）与同一 apiKey（HT_APIKEY），仅 skillCode 与 path 不同。
// apiKey 优先读设置页（htApiKey），回退进程环境变量 HT_APIKEY（兼容官方 skill 的永久变量）。

const GATEWAY_PATH = '/edge/entry/gate';

// 各能力对应的 skillCode（来自官方 skill 实现，不可臆改）
const SKILL_CODE = {
  queryIndicator: 'mx_1779108020995',
  financialAnalysis: 'mx_1779096185749',
  selectStock: 'mx_select-stock',
  paperTrading: 'mx_1778741794549',
  watchlist: 'mx_watchlist-management',
} as const;

type Exchange = 'SH' | 'SZ' | 'BJ';
type Json = Record<string, unknown>;

export class HtscError extends Error {}

/** 网关基址（设置页可覆盖，默认官方生产网关），末尾去斜杠 */
function baseUrl(): string {
  return (getValue('htscBaseUrl') || 'https://ai.zhangle.com').replace(/\/+$/, '');
}

/** apiKey：设置页优先，回退环境变量 HT_APIKEY；均空则抛错 */
function apiKey(): string {
  const key = getValue('htApiKey') || (process.env.HT_APIKEY ?? '').trim();
  if (!key) {
    throw new HtscError('华泰 HT_APIKEY 未配置，请到数据源页（华泰证券 AI 网关）填写 apiKey');
  }
  return key;
}

/** 装配请求头（apiKey + skillCode 鉴权） */
function htscHeaders(skillCode: string): Record<string, string> {
  return { 'Content-Type': 'application/json', apiKey: apiKey(), skillCode };
}

interface PostOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * 统一 POST：发往 <baseUrl>/edge/entry/gate<path>，带一次退避重试与统一打点（sourceId='htsc'）。
 * 返回网关原始信封；业务成功/失败语义因 path 而异（老 finAnalysis 用 code=0，新接口用 ok=true），
 * 由各方法或调用方判定，本层只负责网络与解析。
 */
async function htscPost(
  path: string,
  skillCode: string,
  body: Json,
  opts: PostOptions = {},
): Promise<Json> {
  return requestJson({
    sourceId: 'htsc',
    url: `${baseUrl()}${GATEWAY_PATH}${path}`,
    method: 'POST',
    headers: htscHeaders(skillCode),
    body: JSON.stringify(body),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 60000,
    maxAttempts: 2,
    retryBaseMs: 600,
    isAuthFailure: (s) => s === 401 || s === 403,
    authFailureMessage: '华泰网关鉴权失效，请检查 apiKey',
    errorLabel: '华泰网关',
    makeError: (msg) => new HtscError(msg),
  });
}

export const htsc = {
  // ===== query-indicator =====
  /** 查询金融指标、行情数据或财务估值（保留用户原话，勿拆分/改写） */
  queryIndicator(query: string, signal?: AbortSignal) {
    return htscPost('/api/finAnalysis/queryIndicator', SKILL_CODE.queryIndicator, { query }, { timeoutMs: 60000, signal });
  },

  // ===== financial-analysis =====
  /** 对个股 / ETF / 板块等进行分析诊断 */
  diagnosisStock(query: string, signal?: AbortSignal) {
    return htscPost('/api/finAnalysis/diagnosisStock', SKILL_CODE.financialAnalysis, { query }, { timeoutMs: 360000, signal });
  },
  /** 市场洞察（个股 / 大盘 / 板块 / 多标的对比 / 资讯） */
  marketInsight(query: string, signal?: AbortSignal) {
    return htscPost('/api/finAnalysis/marketInsight', SKILL_CODE.financialAnalysis, { query }, { timeoutMs: 360000, signal });
  },

  // ===== select-stock =====
  /** 条件选股：按自然语言筛选条件查询符合条件的金融标的 */
  selectStock(query: string, signal?: AbortSignal) {
    return htscPost('/api/finAnalysis/selectStock', SKILL_CODE.selectStock, { query }, { timeoutMs: 300000, signal });
  },

  // ===== watchlist-management =====
  /** 添加自选股（query 为用户加自选请求文本，group 默认「默认组」） */
  addWatchlist(query: string, group = '默认组', signal?: AbortSignal) {
    return htscPost('/api/finAnalysis/addWatchlist', SKILL_CODE.watchlist, { query, group }, { timeoutMs: 30000, signal });
  },
  /** 查询自选股列表 */
  getWatchlist(query: string, signal?: AbortSignal) {
    return htscPost('/api/finAnalysis/getWatchlist', SKILL_CODE.watchlist, { query }, { timeoutMs: 30000, signal });
  },

  // ===== a-share-paper-trading（A 股模拟交易）=====
  /** 按名称 / 代码 / 拼音搜索股票，解析为标准 (stockCode, exchange) */
  searchStock(query: string, limit = 30, signal?: AbortSignal) {
    return htscPost('/api/simSkills/searchStock', SKILL_CODE.paperTrading, { query, limit }, { timeoutMs: 8000, signal });
  },
  /** 查股票实时行情（exchange 必填，规避同代码不同市场歧义） */
  getQuote(stockCode: string, exchange: Exchange, signal?: AbortSignal) {
    return htscPost('/api/simSkills/getQuote', SKILL_CODE.paperTrading, { stockCode, exchange }, { timeoutMs: 8000, signal });
  },
  /** 查账户资金总览 */
  getAccountBalance(signal?: AbortSignal) {
    return htscPost('/api/simSkills/getAccountBalance', SKILL_CODE.paperTrading, {}, { timeoutMs: 8000, signal });
  },
  /** 查所有持仓明细 */
  getPositions(signal?: AbortSignal) {
    return htscPost('/api/simSkills/getPositions', SKILL_CODE.paperTrading, {}, { timeoutMs: 8000, signal });
  },
  /** 提交买卖委托（limit 必填 price，market 忽略 price） */
  submitOrder(
    params: {
      direction: 'buy' | 'sell';
      stockCode: string;
      exchange: Exchange;
      quantity: number;
      orderType?: 'limit' | 'market';
      price?: number;
    },
    signal?: AbortSignal,
  ) {
    const body: Json = {
      direction: params.direction,
      stockCode: params.stockCode,
      exchange: params.exchange,
      quantity: params.quantity,
      orderType: params.orderType ?? 'limit',
    };
    if (params.price != null) body.price = params.price;
    return htscPost('/api/simSkills/submitOrder', SKILL_CODE.paperTrading, body, { timeoutMs: 8000, signal });
  },
  /** 按单号撤销单笔未成交（或部分成交）委托 */
  cancelOrder(orderId: string, signal?: AbortSignal) {
    return htscPost('/api/simSkills/cancelOrder', SKILL_CODE.paperTrading, { orderId }, { timeoutMs: 8000, signal });
  },
  /** 一键撤销所有未成交委托（stockCode 与 exchange 须同时给或同时省略） */
  cancelAllPendingOrders(
    filter: { stockCode?: string; exchange?: Exchange; direction?: 'buy' | 'sell' } = {},
    signal?: AbortSignal,
  ) {
    return htscPost('/api/simSkills/cancelAllPendingOrders', SKILL_CODE.paperTrading, { ...filter }, { timeoutMs: 8000, signal });
  },
  /** 查当日未成交 / 部分成交委托（按提交时间倒序） */
  listPendingOrders(
    filter: { stockCode?: string; exchange?: Exchange; direction?: 'buy' | 'sell' } = {},
    signal?: AbortSignal,
  ) {
    return htscPost('/api/simSkills/listPendingOrders', SKILL_CODE.paperTrading, { ...filter }, { timeoutMs: 8000, signal });
  },
  /** 查历史成交记录（startDate/endDate 为 YYYY-MM-DD，跨度 ≤ 90 天） */
  listTradeHistory(
    params: { startDate: string; endDate: string; stockCode?: string; exchange?: Exchange; direction?: 'buy' | 'sell' },
    signal?: AbortSignal,
  ) {
    return htscPost('/api/simSkills/listTradeHistory', SKILL_CODE.paperTrading, { ...params }, { timeoutMs: 8000, signal });
  },
};

export type HtscClient = typeof htsc;

/**
 * 健康探测：用最轻量的 searchStock（5s 级、仅做代码解析）验证网关连通与 apiKey 有效。
 * apiKey 未配置或网关鉴权失效会抛错（由数据源页展示为离线 + detail）。
 */
export async function pingHtsc(signal?: AbortSignal): Promise<void> {
  const json = await htsc.searchStock('平安银行', 1, signal);
  // 网关新接口以 ok=false + error 表达业务/鉴权失败；据此暴露明确 detail
  if (json && json.ok === false) {
    const err = (json.error ?? {}) as Json;
    throw new HtscError(String(err.message ?? '华泰网关返回失败'));
  }
}
