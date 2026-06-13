import { getValue } from '../settings';
import { requestJson } from '../datasource/httpClient';
import { checkBusinessStatus, formatSearchData } from './searchData';

// 妙想（东方财富）官方接口薄封装。
// 老门户（mkapi2.dfcfs.com，apikey/mkt_ 前缀）：选股/资讯/自选股/模拟盘仍在用。
// 新门户（ai-saas.eastmoney.com，em_api_key/em_ 前缀）：金融数据（searchData）与问答助手（assistant/ask）。

const BASE = 'https://mkapi2.dfcfs.com/finskillshub/api/claw';

// 新门户：AI 金融问答助手（robo-advisor）。返回已加工的自然语言答案 + 引用，
// 用 EM_API_KEY（em_ 前缀）鉴权，与老 claw 门户的 mkt_ apikey 不同。
const ASSISTANT_URL =
  'https://ai-saas.eastmoney.com/proxy/app-robo-advisor-api/assistant/ask';

// 新门户：金融结构化数据查询（mcp searchData）。老 claw /query 已失效，统一切到此处。
const SEARCH_DATA_URL = 'https://ai-saas.eastmoney.com/proxy/b/mcp/tool/searchData';

const ENDPOINTS = {
  screen: `${BASE}/stock-screen`, // 选股
  news: `${BASE}/news-search`, // 资讯
  selfSelectGet: `${BASE}/self-select/get`,
  selfSelectManage: `${BASE}/self-select/manage`,
  positions: `${BASE}/mockTrading/positions`,
  balance: `${BASE}/mockTrading/balance`,
  orders: `${BASE}/mockTrading/orders`,
  trade: `${BASE}/mockTrading/trade`,
  cancel: `${BASE}/mockTrading/cancel`,
  newPost: `${BASE}/mockTrading/newPost`,
} as const;

export class MiaoxiangError extends Error {}

/** 装配请求头（apikey 鉴权）；未配置直接抛错 */
function mxHeaders(): Record<string, string> {
  const apikey = getValue('mxApiKey');
  if (!apikey) throw new MiaoxiangError('妙想 MX_APIKEY 未配置，请到设置页填写');
  return { 'Content-Type': 'application/json', apikey };
}

/** 装配新门户请求头（em_api_key 鉴权）；未配置直接抛错 */
function emHeaders(): Record<string, string> {
  const apikey = getValue('emApiKey');
  if (!apikey) throw new MiaoxiangError('妙想 EM_API_KEY 未配置，请到设置页填写');
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'mx-financial-assistant/1.0',
    em_api_key: apikey,
  };
}

function isSuccessCode(code: unknown): boolean {
  return code === 200 || code === '200';
}

// 妙想按 apikey 做全局限流（超频回 code=112「请求频率过高」）。这里把【所有】妙想请求
// 串行化并施加最小间隔，从源头规避并发/高频触发限流；偶发 112 再由各调用的退避重试兜底。
// 串行 + 间隔对 agent（几次调用）几乎无感，却能彻底消除「逐只并发查行情 / 分析与战法同步同时打」导致的 112。
const MX_MIN_GAP_MS = 700;
let mxChain: Promise<unknown> = Promise.resolve();
let mxLastAt = 0;

/** 把妙想请求排入全局串行队列，相邻请求至少间隔 MX_MIN_GAP_MS */
function mxSchedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = mxChain.then(async () => {
    const wait = MX_MIN_GAP_MS - (Date.now() - mxLastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      mxLastAt = Date.now();
    }
  });
  // 队列始终向后推进，单次失败不打断后续请求
  mxChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

/** 宽松调用：单次请求，解析失败即抛错。用于自选股管理等低频非交易接口。 */
function post(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return mxSchedule(() =>
    requestJson({
      sourceId: 'miaoxiang',
      url,
      method: 'POST',
      headers: mxHeaders(),
      body: JSON.stringify(body),
      signal,
      errorLabel: '妙想接口',
      makeError: (msg) => new MiaoxiangError(msg),
    }),
  );
}

/**
 * 数据调用：带网络/解析重试 + 宽松 code 校验。用于行情/选股/资讯等高频数据接口。
 * 这些接口会间歇性抖动或限流，单次失败会被模型误判为「无法获取数据」，故统一加退避重试。
 * 校验宽松：仅当响应显式返回非成功 code 时才重试，容忍无 code 字段的正常响应。
 */
function postData(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  return mxSchedule(() =>
    requestJson({
      sourceId: 'miaoxiang',
      url,
      method: 'POST',
      headers: mxHeaders(),
      body: JSON.stringify(body),
      signal,
      // 退避拉长以等过限流窗口（112）：600/1200/1800ms
      maxAttempts: 4,
      retryBaseMs: 600,
      errorLabel: '妙想接口',
      makeError: (msg) => new MiaoxiangError(msg),
      validate: (json) =>
        json.code != null && !isSuccessCode(json.code)
          ? `妙想接口返回非成功 code=${String(json.code)} message=${String(json.message ?? '')}`
          : null,
    }),
  );
}

/**
 * 严格调用：带重试与响应校验（统一走 httpClient）。
 * mkapi2 模拟盘接口会间歇性返回非法 JSON 的 schema 桩或非成功 code，
 * 解析失败 / code 非成功时按小退避重试，耗尽后抛错；外部 signal 取消即时中止。
 */
function postJson(
  url: string,
  body: unknown,
  retries = 5,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return mxSchedule(() =>
    requestJson({
      sourceId: 'miaoxiang',
      url,
      method: 'POST',
      headers: mxHeaders(),
      body: JSON.stringify(body),
      signal,
      maxAttempts: retries,
      retryBaseMs: 400,
      errorLabel: '妙想接口',
      makeError: (msg) => new MiaoxiangError(msg),
      validate: (json) =>
        isSuccessCode(json.code)
          ? null
          : `妙想接口返回非成功 code=${String(json.code)} message=${String(json.message ?? '')}`,
    }),
  );
}

export interface TradeParams {
  type: 'buy' | 'sell';
  stockCode: string;
  quantity: number;
  useMarketPrice: boolean;
  /** 限价（元）。市价单忽略；接口要求按板块放大为整数，这里自动处理 */
  price?: number;
}

export interface CancelParams {
  all?: boolean;
  orderId?: string;
  stockCode?: string;
}

export const miaoxiang = {
  /**
   * AI 金融问答助手（新门户）：一次自然语言提问，返回【已加工好的自然语言答案】。
   * 比 claw/query 更快更稳，适合「综合问某些股票的价格/涨跌/资金面/最新动态/研判」。
   * 走独立门户（不入 mxSchedule 串行队列，避免被慢的老门户请求拖累）。
   */
  async assistantAsk(
    question: string,
    opts?: { deepThink?: boolean; signal?: AbortSignal },
  ): Promise<string> {
    const body: Record<string, unknown> = { question };
    if (opts?.deepThink) body.deepThink = true;
    const json = await requestJson({
      sourceId: 'miaoxiang',
      url: ASSISTANT_URL,
      method: 'POST',
      headers: emHeaders(),
      body: JSON.stringify(body),
      signal: opts?.signal,
      timeoutMs: 28000,
      maxAttempts: 2,
      retryBaseMs: 800,
      errorLabel: '妙想金融问答',
      makeError: (msg) => new MiaoxiangError(msg),
      // 该门户严格用 code==200 表成功（与老门户 code 约定不同）
      validate: (j) =>
        isSuccessCode(j.code)
          ? null
          : `妙想金融问答返回非成功 code=${String(j.code)} message=${String(j.message ?? '')}`,
    });
    const data = (json.data ?? {}) as Record<string, unknown>;
    const answer = typeof data.displayData === 'string' ? data.displayData.trim() : '';
    if (!answer) throw new MiaoxiangError('妙想金融问答返回空答案');
    return answer;
  },

  /**
   * 全市场金融结构化数据（自然语言）。走新门户 searchData（em_api_key 鉴权），
   * 返回拍平后的精简文本表。独立门户，不入 mxSchedule 串行队列（与老 claw 限流无关）。
   */
  async financeData(toolQuery: string, signal?: AbortSignal): Promise<string> {
    const rand = (): string => Math.random().toString(16).slice(2, 10);
    const json = await requestJson({
      sourceId: 'miaoxiang',
      url: SEARCH_DATA_URL,
      method: 'POST',
      headers: emHeaders(),
      body: JSON.stringify({
        query: toolQuery,
        toolContext: { callId: `call_${rand()}`, userInfo: { userId: `user_${rand()}` } },
      }),
      signal,
      timeoutMs: 28000,
      maxAttempts: 2,
      retryBaseMs: 800,
      errorLabel: '妙想金融数据',
      makeError: (msg) => new MiaoxiangError(msg),
      // 新门户成功语义：code/status ∈ {null,0,200}；业务错误抛出由调用方降级处理
      validate: (j) => checkBusinessStatus(j),
    });
    return formatSearchData(json);
  },

  /** 选股（自然语言条件） */
  screener(keyword: string, signal?: AbortSignal) {
    return postData(ENDPOINTS.screen, { keyword }, signal);
  },

  /** 金融资讯搜索 */
  search(query: string, signal?: AbortSignal) {
    return postData(ENDPOINTS.news, { query }, signal);
  },

  /** 读取自选股 */
  selfSelectGet(signal?: AbortSignal) {
    return post(ENDPOINTS.selfSelectGet, {}, signal);
  },

  /** 管理自选股（自然语言增删） */
  selfSelectManage(query: string, signal?: AbortSignal) {
    return post(ENDPOINTS.selfSelectManage, { query }, signal);
  },

  // ===== 模拟盘（严格调用，带重试消化 schema 桩）=====
  positions(signal?: AbortSignal) {
    return postJson(ENDPOINTS.positions, { moneyUnit: 1 }, 5, signal);
  },
  balance(signal?: AbortSignal) {
    return postJson(ENDPOINTS.balance, { moneyUnit: 1 }, 5, signal);
  },
  orders(signal?: AbortSignal) {
    return postJson(ENDPOINTS.orders, { fltOrderDrt: 0, fltOrderStatus: 0 }, 5, signal);
  },
  trade(p: TradeParams) {
    const payload: Record<string, unknown> = {
      type: p.type,
      stockCode: p.stockCode,
      quantity: p.quantity,
      useMarketPrice: p.useMarketPrice,
    };
    if (!p.useMarketPrice && typeof p.price === 'number') {
      // 接口要求整数价：沪市6/科创9两位小数，其余三位
      const dp = ['6', '9'].includes(p.stockCode[0]) ? 2 : 3;
      payload.price = Math.round(p.price * 10 ** dp);
    }
    return postJson(ENDPOINTS.trade, payload);
  },
  cancel(p: CancelParams) {
    const payload = p.all
      ? { type: 'all' }
      : { type: 'order', orderId: p.orderId, stockCode: p.stockCode };
    return postJson(ENDPOINTS.cancel, payload);
  },
};

export type MiaoxiangClient = typeof miaoxiang;
