import { getValue } from '../settings';

// 妙想（东方财富）官方接口薄封装。
// 契约来源：openclaw 已验证可用的 mx-* skill（mkapi2.dfcfs.com 老门户，apikey 头）。
// 所有接口用 MX_APIKEY（mkt_ 前缀）。EM_API_KEY 保留供新门户后续使用。

const BASE = 'https://mkapi2.dfcfs.com/finskillshub/api/claw';

const ENDPOINTS = {
  query: `${BASE}/query`, // 金融数据
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

async function post(url: string, body: unknown): Promise<unknown> {
  const apikey = getValue('mxApiKey');
  if (!apikey) {
    throw new MiaoxiangError('妙想 MX_APIKEY 未配置，请到设置页填写');
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new MiaoxiangError(`妙想接口请求失败: ${e instanceof Error ? e.message : e}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new MiaoxiangError(`妙想接口 ${res.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
  /** 全市场金融数据（自然语言） */
  financeData(toolQuery: string) {
    return post(ENDPOINTS.query, { toolQuery });
  },

  /** 选股（自然语言条件） */
  screener(keyword: string) {
    return post(ENDPOINTS.screen, { keyword });
  },

  /** 金融资讯搜索 */
  search(query: string) {
    return post(ENDPOINTS.news, { query });
  },

  /** 读取自选股 */
  selfSelectGet() {
    return post(ENDPOINTS.selfSelectGet, {});
  },

  /** 管理自选股（自然语言增删） */
  selfSelectManage(query: string) {
    return post(ENDPOINTS.selfSelectManage, { query });
  },

  // ===== 模拟盘 =====
  positions() {
    return post(ENDPOINTS.positions, { moneyUnit: 1 });
  },
  balance() {
    return post(ENDPOINTS.balance, { moneyUnit: 1 });
  },
  orders() {
    return post(ENDPOINTS.orders, { fltOrderDrt: 0, fltOrderStatus: 0 });
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
    return post(ENDPOINTS.trade, payload);
  },
  cancel(p: CancelParams) {
    const payload = p.all
      ? { type: 'all' }
      : { type: 'order', orderId: p.orderId, stockCode: p.stockCode };
    return post(ENDPOINTS.cancel, payload);
  },
};

export type MiaoxiangClient = typeof miaoxiang;
