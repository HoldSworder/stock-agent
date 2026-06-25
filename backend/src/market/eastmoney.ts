import type {
  DragonOverview,
  DragonRole,
  DragonStock,
  FuturesItem,
  GlobalIndex,
  KlineBar,
  KlinePeriod,
  LadderTier,
  MarketEmotion,
  MarketIndex,
  SectorItem,
  SectorMoneyItem,
  StockQuote,
  StockRankItem,
  StockSuggest,
  TrendsResult,
  TurnoverTotal,
} from '@stock-agent/shared';
import { getTrendsTencent, getIndicesTencent } from './tencent';
import { requestJson } from '../datasource/httpClient';
import { num, numOrNull, toSecid, PUSH2_QT } from '../datasource/codes';
import { getQuotes as scheduleQuotes, getKline as scheduleKline } from '../datasource/scheduler';

// 东方财富公开行情接口（push2）薄封装。无需鉴权，仅自用看盘/复盘。
// 统一 fltt=2 直接拿小数值；diff 在 full=1 时为对象，兼容对象/数组。

const PUSH2 = PUSH2_QT;
// push2 实时行情主 host 偶发被限流/封禁（连接秒级 reset，fetch failed），
// push2delay 是同一套 API 的延迟行情镜像（schema 完全一致），作为主 host 网络失败时的兜底。
const PUSH2_HOST = 'push2.eastmoney.com';
const PUSH2_DELAY_HOST = 'push2delay.eastmoney.com';
const PUSH2HIS = 'https://push2his.eastmoney.com/api/qt';
const PUSH2EX = 'https://push2ex.eastmoney.com';
const PUSH2EX_UT = '7eea3edcaed734bea9cbfc24409ed989';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class MarketError extends Error {}

// 指数 secid（市场前缀.代码）：上证/深成/创业板/科创50/北证50
const INDEX_SECIDS = ['1.000001', '0.399001', '0.399006', '1.000688', '0.899050'];
// 外围关键指数 secid（东财 push2 全球行情，market 100=国际指数 / 133=外汇）。
// 顺序即展示顺序，按区域分组：美股 → 中概 → 欧洲 → 亚太 → 汇率 → 债券 → 加密。
// 单个 secid 失败/无数据会被空名过滤剔除（同 getFutures），未生效 secid 不渲染、不影响整体。
const GLOBAL_INDEX_DEFS: ReadonlyArray<{ secid: string; group: string }> = [
  // 美股
  { secid: '100.DJIA', group: '美股' }, // 道琼斯
  { secid: '100.NDX', group: '美股' }, // 纳斯达克100
  { secid: '100.SPX', group: '美股' }, // 标普500
  { secid: '100.VIX', group: '美股' }, // VIX 恐慌指数
  // 中概（A股次日情绪关键参考）
  { secid: '100.HXC', group: '中概' }, // 纳斯达克中国金龙指数
  // 欧洲
  { secid: '100.FTSE', group: '欧洲' }, // 英国富时100
  { secid: '100.GDAXI', group: '欧洲' }, // 德国DAX
  { secid: '100.FCHI', group: '欧洲' }, // 法国CAC40
  // 亚太
  { secid: '100.HSI', group: '亚太' }, // 恒生指数
  { secid: '100.N225', group: '亚太' }, // 日经225
  { secid: '100.KS11', group: '亚太' }, // 韩国KOSPI
  { secid: '100.TWII', group: '亚太' }, // 台湾加权
  { secid: '100.SENSEX', group: '亚太' }, // 印度孟买SENSEX
  // 汇率
  { secid: '100.UDI', group: '汇率' }, // 美元指数
  { secid: '133.USDCNH', group: '汇率' }, // 美元兑离岸人民币
  { secid: '133.USDJPY', group: '汇率' }, // 美元兑日元
  { secid: '100.XIN9', group: '汇率' }, // 富时中国A50
  // 债券
  { secid: '100.US10YR', group: '债券' }, // 美债10年期收益率
  // 加密
  { secid: '120.BTC', group: '加密' }, // 比特币
];
// 两市成交额取上证 + 深成指
const SH_SECID = '1.000001';
const SZ_SECID = '0.399001';

// 国内期货：用 clist 一次性拉取各交易所全部合约，过滤主连行（f14 以「主连」结尾且不含「次」）。
// 市场前缀：113 上期所 / 114 大商所 / 115 郑商所 / 142 上期能源(INE) / 225 广期所。
const FUTURES_MARKETS = ['m:113', 'm:114', 'm:115', 'm:142', 'm:225'];

// 品种码（f12 去掉结尾主连 'm'）→ 逻辑分组。仅收录其中品种（工业/能源/新能源/建材筛选）。
// 沪市/大商所/能源/广期所小写，郑商所大写。
const VARIETY_GROUP: Record<string, string> = {
  // 有色
  cu: '有色', al: '有色', ao: '有色', zn: '有色', pb: '有色', ni: '有色', sn: '有色', ss: '有色', bc: '有色', ad: '有色',
  // 黑色
  rb: '黑色', hc: '黑色', i: '黑色', j: '黑色', jm: '黑色', wr: '黑色', SF: '黑色', SM: '黑色',
  // 贵金属
  au: '贵金属', ag: '贵金属',
  // 能化
  sc: '能化', fu: '能化', bu: '能化', ru: '能化', br: '能化', lu: '能化', pg: '能化', sp: '能化',
  TA: '能化', MA: '能化', eg: '能化', pp: '能化', l: '能化', v: '能化', eb: '能化', PF: '能化', PX: '能化',
  // 建材
  FG: '建材', SA: '建材', UR: '建材',
  // 新能源
  si: '新能源', lc: '新能源', ps: '新能源',
};
const GROUP_ORDER = ['有色', '黑色', '贵金属', '能化', '新能源', '建材'];

// 外盘商品（东财全球期货 futsseapi，独立于 push2）。
const FUTSSE_LIST = 'https://futsseapi.eastmoney.com/list/COMEX,NYMEX,LME,IPE';
const FUTSSE_TOKEN = '58b2fa8f54638b60b87d69b31969089c';
// 外盘关键词（贵金属/有色/能源）：连续合约（dm 以 00Y 结尾）名称命中即收录
const OVERSEAS_KEYWORDS = ['黄金', '白银', '铜', '铝', '锌', '镍', '锡', '原油', '布伦特', '天然气'];

// 板块 fs（行业 m:90 t:2）
const SECTOR_FS = 'm:90+t:2';
// 沪深京 A 股榜单的 fs 过滤（沪 A + 深 A + 京 A）
const STOCK_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';

export interface FetchJsonOptions {
  /** 自定义请求头（如腾讯需 Referer: https://gu.qq.com/） */
  headers?: Record<string, string>;
  /** 错误信息前缀，默认「东财行情」 */
  label?: string;
  /** 校验返回 JSON 是否含有效数据；返回 false 视为可重试失败（如腾讯 schema 文档） */
  validate?: (json: Record<string, unknown>) => boolean;
  /** 调用统计归属的数据源 id（东财=eastmoney，腾讯/新浪兜底各自归源），默认 eastmoney */
  sourceId?: string;
}

/**
 * 带缓存 + 重试 + 响应体校验的行情 JSON 拉取（统一走 datasource/httpClient）。
 * 网络错误 / 5xx / JSON 解析失败 / validate 未过 → 退避后重试；4xx 直接抛出。
 * push2 主 host 网络/5xx 失败后自动切 push2delay 延迟镜像。
 */
export async function getJson(
  url: string,
  opts: FetchJsonOptions = {},
): Promise<Record<string, unknown>> {
  const { headers, validate } = opts;
  const label = opts.label ?? '东财行情';
  return requestJson({
    sourceId: opts.sourceId ?? 'eastmoney',
    url,
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/', ...headers },
    cacheTtlMs: 15_000,
    maxAttempts: 4,
    retryBaseMs: 500,
    hostFallback: { from: PUSH2_HOST, to: PUSH2_DELAY_HOST },
    errorLabel: label,
    makeError: (msg) => new MarketError(msg),
    validate: validate ? (json) => (validate(json) ? null : `${label}返回无有效数据`) : undefined,
  });
}

/** 数据源健康探测：拉一次上证指数实时点位（单请求，复用缓存/兜底）。失败抛 MarketError */
export async function ping(): Promise<void> {
  await getJson(`${PUSH2}/stock/get?fltt=2&fields=f43,f57,f58&secid=1.000001`, { label: '东财连通性' });
}

/** clist 的 data.diff 兼容对象/数组，统一成数组 */
function toRows(json: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = json.data as { diff?: unknown } | null;
  if (!data || data.diff == null) return [];
  const diff = data.diff;
  if (Array.isArray(diff)) return diff as Array<Record<string, unknown>>;
  return Object.values(diff as Record<string, Record<string, unknown>>);
}

/** 大盘指数（逐个 qt/get，f43 点位 / f170 涨跌幅%） */
export async function getIndices(): Promise<MarketIndex[]> {
  const results = await Promise.all(
    INDEX_SECIDS.map(async (secid) => {
      const url = `${PUSH2}/stock/get?fltt=2&fields=f43,f57,f58,f170&secid=${secid}`;
      const json = await getJson(url);
      const d = (json.data ?? {}) as Record<string, unknown>;
      return {
        code: String(d.f57 ?? ''),
        name: String(d.f58 ?? ''),
        point: num(d.f43),
        pct: num(d.f170),
        secid,
      } satisfies MarketIndex;
    }),
  );
  return results.filter((x) => x.name);
}

/**
 * 批量取指数最新点位（map: secid → 点位），供基差等需现货指数的场景。
 * 单个失败置 0（调用方据此跳过），不抛错。
 */
export async function getIndexPointMap(secids: string[]): Promise<Record<string, number>> {
  const map: Record<string, number> = {};
  await Promise.all(
    secids.map(async (secid) => {
      try {
        const url = `${PUSH2}/stock/get?fltt=2&fields=f43,f58&secid=${secid}`;
        const json = await getJson(url);
        const d = (json.data ?? {}) as Record<string, unknown>;
        map[secid] = num(d.f43);
      } catch {
        map[secid] = 0;
      }
    }),
  );
  return map;
}

/**
 * 单指数实时快照文本（push2 stock/get，显式 secid）：现价/涨跌幅/涨跌额/今开/最高/最低/昨收/振幅。
 * 供指数辩论决策注入，支持 A 股/港股/外围指数（不走 6 位码，规避撞码）。
 */
export async function getIndexSnapshot(secid: string): Promise<string> {
  const url = `${PUSH2}/stock/get?fltt=2&fields=f43,f44,f45,f46,f57,f58,f60,f169,f170,f171&secid=${secid}`;
  const json = await getJson(url);
  const d = (json.data ?? {}) as Record<string, unknown>;
  const name = String(d.f58 ?? '');
  const point = num(d.f43);
  if (!name || point <= 0) throw new MarketError(`指数快照不可用: ${secid}`);
  const parts = [
    `${name}(${String(d.f57 ?? '')}) 现报 ${point}（${num(d.f170) >= 0 ? '+' : ''}${num(d.f170)}%，涨跌额 ${num(d.f169)}）`,
  ];
  const open = num(d.f46);
  const high = num(d.f44);
  const low = num(d.f45);
  const prevClose = num(d.f60);
  const amplitude = num(d.f171);
  if (open > 0) parts.push(`今开 ${open}`);
  if (high > 0 && low > 0) parts.push(`最高 ${high} / 最低 ${low}`);
  if (prevClose > 0) parts.push(`昨收 ${prevClose}`);
  if (amplitude > 0) parts.push(`振幅 ${amplitude}%`);
  return parts.join('，');
}

/**
 * 指数（带兜底）：先东财 push2；抛错或返回空时回退腾讯 minute qt。
 * 供 buildOverview 使用，配合 stale 缓存形成「东财→腾讯→缓存」三级。
 */
export async function getIndicesResilient(): Promise<MarketIndex[]> {
  try {
    const em = await getIndices();
    if (em.length > 0) return em;
  } catch {
    // 东财失败 → 腾讯兜底
  }
  return getIndicesTencent([...INDEX_SECIDS]);
}

/** num()=0 时归一为 undefined（外围指数高低/振幅等明细缺失时省略，不渲染 0 误导） */
function numOpt(v: unknown): number | undefined {
  const n = num(v);
  return n !== 0 ? n : undefined;
}

/**
 * 外围关键指数（美股/欧洲/亚太/汇率/债券/加密）。结构同 getFutures：逐个 qt/get，
 * 含点位/涨跌额/涨跌幅/最高最低/开盘/昨收/振幅 + 区域分组。
 * 单个失败置 null 跳过；空名（无数据/未生效 secid）过滤，保证部分源失败不影响整体。
 */
export async function getGlobalIndices(): Promise<GlobalIndex[]> {
  const results = await Promise.all(
    GLOBAL_INDEX_DEFS.map(async (def): Promise<GlobalIndex | null> => {
      try {
        const url = `${PUSH2}/stock/get?fltt=2&fields=f43,f44,f45,f46,f57,f58,f60,f169,f170,f171&secid=${def.secid}`;
        const json = await getJson(url);
        const d = (json.data ?? {}) as Record<string, unknown>;
        return {
          code: String(d.f57 ?? ''),
          name: String(d.f58 ?? ''),
          point: num(d.f43),
          pct: num(d.f170),
          secid: def.secid,
          group: def.group,
          change: numOpt(d.f169),
          high: numOpt(d.f44),
          low: numOpt(d.f45),
          open: numOpt(d.f46),
          prevClose: numOpt(d.f60),
          amplitude: numOpt(d.f171),
        };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((x): x is GlobalIndex => x != null && x.name !== '');
}

/**
 * 国内期货（clist 批量）。每个交易所一次 clist 拿全部合约，过滤主连行
 * （f14 以「主连」结尾且不含「次」），按 VARIETY_GROUP 收录工业/能源类品种并映射分组。
 * 单市场失败置空跳过，不影响其它市场。
 */
async function getDomesticFutures(): Promise<FuturesItem[]> {
  const lists = await Promise.all(
    FUTURES_MARKETS.map((fs) =>
      getJson(
        `${PUSH2}/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fs}&fields=f2,f3,f12,f13,f14`,
      )
        .then(toRows)
        .catch(() => [] as Array<Record<string, unknown>>),
    ),
  );
  const out: FuturesItem[] = [];
  for (const rows of lists) {
    for (const r of rows) {
      const name = String(r.f14 ?? '');
      const code = String(r.f12 ?? '');
      // 仅主连，排除「次主连」
      if (!name.endsWith('主连') || name.includes('次')) continue;
      const variety = code.slice(0, -1); // 去掉结尾主连 'm'
      const group = VARIETY_GROUP[variety];
      if (!group) continue; // 仅收录筛选品种
      out.push({
        code,
        name,
        price: num(r.f2),
        pct: num(r.f3),
        secid: `${r.f13}.${code}`,
        group,
        region: 'domestic',
      });
    }
  }
  // 按 GROUP_ORDER 分组排序，组内按涨跌幅降序
  out.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || b.pct - a.pct,
  );
  return out;
}

/**
 * 外盘商品期货（东财全球期货 futsseapi，独立于 push2）。
 * 拉取 COMEX/NYMEX/LME/IPE 列表，保留连续合约（dm 以 00Y 结尾）且名称命中关键词的行。
 * price/pct 可能为 '-'，num() 归 0；无报价（price<=0）剔除。secid 置空，前端不开 K 线。
 */
async function getOverseasFutures(): Promise<FuturesItem[]> {
  const url =
    `${FUTSSE_LIST}?orderBy=dm&sort=desc&pageSize=1000&pageIndex=0` +
    `&token=${FUTSSE_TOKEN}&field=dm,sc,name,p,zde,zdf&blockName=callback`;
  const json = await getJson(url, { label: '东财外盘期货' });
  const list = Array.isArray((json as { list?: unknown }).list)
    ? ((json as { list: Array<Record<string, unknown>> }).list)
    : [];
  return list
    .filter((r) => {
      const dm = String(r.dm ?? '');
      const name = String(r.name ?? '');
      if (!dm.endsWith('00Y')) return false; // 仅连续合约
      return OVERSEAS_KEYWORDS.some((k) => name.includes(k));
    })
    .map(
      (r) =>
        ({
          code: String(r.dm ?? ''),
          name: String(r.name ?? ''),
          price: num(r.p),
          pct: num(r.zdf),
          secid: '',
          group: '外盘',
          region: 'overseas',
        }) satisfies FuturesItem,
    )
    .filter((x) => x.name !== '' && x.price > 0);
}

export async function getFutures(): Promise<FuturesItem[]> {
  const [domestic, overseas] = await Promise.all([
    getDomesticFutures().catch(() => [] as FuturesItem[]),
    getOverseasFutures().catch(() => [] as FuturesItem[]),
  ]);
  return [...domestic, ...overseas];
}

/**
 * K 线目标 → 东财 secid。个股 6 位走 toSecid；板块 BKxxxx 用 90 前缀。
 * 大盘指数因 code 与个股撞码，须由调用方显式传 secid，不走此函数。
 */
function buildKlineSecid(code: string): string {
  if (/^\d{6}$/.test(code)) return toSecid(code);
  if (/^BK\d+$/i.test(code)) return `90.${code.toUpperCase()}`;
  throw new MarketError(`无法解析 K 线代码: ${code}`);
}

/** 批量个股实时报价（ulist.np 一次取多只）。f2 现价 / f3 涨跌幅% / f12 代码 / f14 名称 / f18 昨收 / f6 成交额 / f7 振幅% / f8 换手率% / f10 量比 */
export async function getQuotesEastmoney(codes: string[]): Promise<StockQuote[]> {
  const valid = codes.filter((c) => /^\d{6}$/.test(c));
  if (valid.length === 0) return [];
  const secids = valid.map(toSecid).join(',');
  const url = `${PUSH2}/ulist.np/get?fltt=2&fields=f2,f3,f6,f7,f8,f10,f12,f14,f18&secids=${secids}`;
  const json = await getJson(url);
  return toRows(json).map((r) => {
    // f7 振幅 / f8 换手率 / f10 量比：缺失（如停牌/无数据）东财返回 '-' → num()=0，归一为 undefined
    const amplitude = num(r.f7);
    const turnover = num(r.f8);
    const volRatio = num(r.f10);
    return {
      code: String(r.f12 ?? ''),
      name: String(r.f14 ?? ''),
      price: num(r.f2),
      pct: num(r.f3),
      prevClose: num(r.f18),
      // f6 成交额（元）→ 亿
      amount: num(r.f6) / 1e8,
      amplitude: amplitude > 0 ? amplitude : undefined,
      turnoverRate: turnover > 0 ? turnover : undefined,
      volumeRatio: volRatio > 0 ? volRatio : undefined,
    };
  });
}

/** 单只个股实时报价 + 涨跌停价（用于模拟下单的涨跌停校验） */
export interface QuoteWithLimits {
  code: string;
  name: string;
  /** 现价 */
  price: number;
  /** 涨停价 */
  limitUp: number;
  /** 跌停价 */
  limitDown: number;
  /** 昨收 */
  prevClose: number;
}

/** 取单只个股现价与涨跌停价（stock/get：f43 现价 / f51 涨停 / f52 跌停 / f58 名称 / f60 昨收） */
export async function getQuoteWithLimits(code: string): Promise<QuoteWithLimits> {
  if (!/^\d{6}$/.test(code)) throw new MarketError(`非法股票代码: ${code}`);
  const url = `${PUSH2}/stock/get?fltt=2&fields=f43,f51,f52,f58,f60&secid=${toSecid(code)}`;
  const json = await getJson(url);
  const d = (json.data ?? {}) as Record<string, unknown>;
  const name = String(d.f58 ?? '');
  if (!name) throw new MarketError(`未查到代码 ${code} 的行情`);
  return {
    code,
    name,
    price: num(d.f43),
    limitUp: num(d.f51),
    limitDown: num(d.f52),
    prevClose: num(d.f60),
  };
}

/** 取个股所属行业名（push2 stock/get，f127 所属行业）。无数据/失败返回空串，由调用方降级。 */
export async function getStockIndustry(code: string): Promise<string> {
  if (!/^\d{6}$/.test(code)) return '';
  const url = `${PUSH2}/stock/get?fltt=2&fields=f127&secid=${toSecid(code)}`;
  const json = await getJson(url);
  const d = (json.data ?? {}) as Record<string, unknown>;
  const v = d.f127;
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 股票搜索联想（东方财富 suggest）。返回可跟踪的主板/创业板/ETF 候选（沪深，6 位代码）。
 * 解析 QuotationCodeTable.Data[]，字段 Code/Name/MktNum（1=沪 0=深）。
 */
export async function searchSuggest(q: string, count = 10): Promise<StockSuggest[]> {
  const kw = q.trim();
  if (!kw) return [];
  const url = `https://searchadapter.eastmoney.com/api/suggest/get?input=${encodeURIComponent(
    kw,
  )}&type=14&count=${count}`;
  const json = await getJson(url);
  const table = (json.QuotationCodeTable ?? {}) as { Data?: unknown };
  const rows = Array.isArray(table.Data) ? (table.Data as Array<Record<string, unknown>>) : [];
  const out: StockSuggest[] = [];
  for (const r of rows) {
    const code = String(r.Code ?? '');
    const mkt = String(r.MktNum ?? '');
    if (!/^\d{6}$/.test(code)) continue; // 仅 A 股/ETF 6 位代码
    if (mkt !== '0' && mkt !== '1') continue; // 仅沪(1)/深(0)，过滤北交所/港美股/指数
    out.push({ code, name: String(r.Name ?? ''), market: mkt === '1' ? 'SH' : 'SZ' });
  }
  return out;
}

/** K 线周期 → 东财 klt 参数（分钟级 5/15/30/60/120 直接对应 klt） */
const KLT_MAP: Record<KlinePeriod, number> = {
  day: 101,
  week: 102,
  month: 103,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '60m': 60,
  '120m': 120,
};

/**
 * 批量实时报价（薄委托至 datasource 调度层：东财 → 网易 自动兜底）。
 * 保留此入口与签名，消费方无需改动即经统一调度取数。
 */
export function getQuotes(codes: string[]): Promise<StockQuote[]> {
  return scheduleQuotes(codes);
}

/**
 * K 线（薄委托至 datasource 调度层：东财 → 腾讯 → 新浪 自动兜底，按级别能力降级）。
 * 保留此入口与签名，消费方无需改动即经统一调度取数。
 */
export function getKline(
  code: string,
  period: KlinePeriod = 'day',
  limit = 250,
  secid?: string,
): Promise<KlineBar[]> {
  return scheduleKline(code, period, limit, secid);
}

/**
 * K 线（东财，前复权 fqt=1），支持个股 / 板块 / 大盘指数。
 * push2his kline/get，fields2 顺序：f51 日期 / f52 开 / f53 收 / f54 高 / f55 低 / f56 量(手) / f57 额(元)。
 * 个股/板块传 code 自动解析 secid；大盘指数因撞码须显式传 secid。
 */
export async function getKlineEastmoney(
  code: string,
  period: KlinePeriod = 'day',
  limit = 250,
  secid?: string,
): Promise<KlineBar[]> {
  const resolved = secid ?? buildKlineSecid(code);
  const klt = KLT_MAP[period] ?? 101;
  const url = `${PUSH2HIS}/stock/kline/get?secid=${resolved}&klt=${klt}&fqt=1&end=20500101&lmt=${limit}&fields1=f1&fields2=f51,f52,f53,f54,f55,f56,f57`;
  const json = await getJson(url);
  const data = json.data as { klines?: string[] } | null;
  const kl = data?.klines ?? [];
  return kl.map((row) => {
    const [time, open, close, high, low, volume, amount] = row.split(',');
    return {
      time,
      open: num(open),
      close: num(close),
      high: num(high),
      low: num(low),
      volume: num(volume),
      amount: num(amount),
    } satisfies KlineBar;
  });
}

/**
 * 当日分时编排：个股 / 指数优先腾讯（更稳），失败回退东财；板块仅东财（腾讯无对应代码）。
 * 两源皆失败才抛 MarketError（路由兜底 502，概率极低）。
 */
export async function getTrends(code: string, secid?: string): Promise<TrendsResult> {
  const isBoard = !secid && /^BK\d+$/i.test(code);
  if (!isBoard) {
    try {
      return await getTrendsTencent(code, secid);
    } catch {
      // 腾讯失败（含不支持的代码 / 反爬）→ 回退东财
    }
  }
  return getTrendsEastmoney(code, secid);
}

/**
 * 当日分时（东财 trends2，1 分钟级），支持个股 / 板块 / 大盘指数。
 * trends2/get：data.preClose 昨收 / data.name 名称 / data.trends[] 逗号串。
 * fields2 顺序 f51 时间 / f52 开 / f53 收(现价) / f54 高 / f55 低 / f56 量(手) / f57 额 / f58 均价。
 * 个股(6位)/板块(BKxxxx) 传 code 自动解析 secid；大盘指数因撞码须显式传 secid。
 */
export async function getTrendsEastmoney(code: string, secid?: string): Promise<TrendsResult> {
  const resolved = secid ?? buildKlineSecid(code);
  const url = `${PUSH2HIS}/stock/trends2/get?secid=${resolved}&fields1=f1,f2,f3,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1&fltt=2`;
  const json = await getJson(url);
  const data = json.data as { preClose?: unknown; name?: unknown; trends?: string[] } | null;
  // 无分时数据（场外基金/停牌/部分指数板块）：返回空点位由前端提示「暂不支持分时」，不抛 502
  if (!data) return { code, name: '', prevClose: 0, points: [] };
  const trends = data.trends ?? [];
  const points = trends.map((row) => {
    const cols = row.split(',');
    // cols[0] 形如 "2026-06-09 09:30"，仅取 HH:MM
    const time = (cols[0] ?? '').slice(-5);
    return {
      time,
      price: num(cols[2]),
      avg: num(cols[7]),
      volume: num(cols[5]),
    };
  });
  return {
    code,
    name: String(data.name ?? ''),
    prevClose: num(data.preClose),
    points,
  };
}

/**
 * 板块搜索联想（东方财富 suggest）。返回行业/概念板块候选（MktNum=90，Code 形如 BKxxxx）。
 * 用于把复盘文本里的板块名称解析为板块代码再取 K 线。
 */
export async function searchBoard(q: string, count = 8): Promise<StockSuggest[]> {
  const kw = q.trim();
  if (!kw) return [];
  const url = `https://searchadapter.eastmoney.com/api/suggest/get?input=${encodeURIComponent(
    kw,
  )}&type=14&count=${count}`;
  const json = await getJson(url);
  const table = (json.QuotationCodeTable ?? {}) as { Data?: unknown };
  const rows = Array.isArray(table.Data) ? (table.Data as Array<Record<string, unknown>>) : [];
  const out: StockSuggest[] = [];
  for (const r of rows) {
    const code = String(r.Code ?? '').toUpperCase();
    if (!/^BK\d+$/.test(code)) continue; // 仅板块代码
    if (String(r.MktNum ?? '') !== '90') continue;
    out.push({ code, name: String(r.Name ?? ''), market: 'BK' });
  }
  return out;
}

/** 板块涨幅榜（industry=行业 m:90 t:2 / concept=概念 m:90 t:3）。
 * by=today 按当日涨幅(f3)排，mid60 按 60 日涨幅(f24)排取中线强势榜；两者均带 60日/年初至今多日字段。 */
export async function getSectorRanking(
  kind: 'industry' | 'concept',
  n = 12,
  by: 'today' | 'mid60' = 'today',
): Promise<SectorItem[]> {
  const t = kind === 'industry' ? 2 : 3;
  const fid = by === 'mid60' ? 'f24' : 'f3';
  const url = `${PUSH2}/clist/get?pn=1&pz=${n}&po=1&fid=${fid}&fltt=2&fs=m:90+t:${t}&fields=f3,f12,f14,f24,f25,f128,f140`;
  const json = await getJson(url);
  return toRows(json).map((r) => ({
    code: String(r.f12 ?? ''),
    name: String(r.f14 ?? ''),
    pct: num(r.f3),
    ret60: numOrNull(r.f24),
    ytd: numOrNull(r.f25),
    leadStock: String(r.f128 ?? ''),
    leadStockCode: String(r.f140 ?? ''),
  }));
}

/** 个股榜（gainers=涨幅榜 fid=f3 po=1 / turnover=成交额榜 fid=f6 po=1 / losers=跌幅榜 fid=f3 po=0） */
export async function getStockRanking(
  by: 'gainers' | 'turnover' | 'losers',
  n = 15,
): Promise<StockRankItem[]> {
  const fid = by === 'turnover' ? 'f6' : 'f3';
  const po = by === 'losers' ? 0 : 1;
  const url = `${PUSH2}/clist/get?pn=1&pz=${n}&po=${po}&fid=${fid}&fltt=2&fs=${STOCK_FS}&fields=f2,f3,f6,f12,f14`;
  const json = await getJson(url);
  return toRows(json).map((r) => ({
    code: String(r.f12 ?? ''),
    name: String(r.f14 ?? ''),
    price: num(r.f2),
    pct: num(r.f3),
    // f6 成交额（元）→ 亿
    amount: num(r.f6) / 1e8,
  }));
}

/** 板块榜（po=1 涨幅榜 / po=0 跌幅榜），复用领涨股字段 */
export async function getSectorByChange(
  dir: 'gainers' | 'losers',
  n = 12,
): Promise<SectorItem[]> {
  const po = dir === 'gainers' ? 1 : 0;
  const url = `${PUSH2}/clist/get?pn=1&pz=${n}&po=${po}&fid=f3&fltt=2&fs=${SECTOR_FS}&fields=f3,f12,f14,f128,f140`;
  const json = await getJson(url);
  return toRows(json).map((r) => ({
    code: String(r.f12 ?? ''),
    name: String(r.f14 ?? ''),
    pct: num(r.f3),
    leadStock: String(r.f128 ?? ''),
    leadStockCode: String(r.f140 ?? ''),
  }));
}

/** 板块主力资金流（inflow=净流入TOP po=1 / outflow=净流出TOP po=0），f62 主力净流入 */
export async function getSectorMoneyFlow(
  dir: 'inflow' | 'outflow',
  n = 10,
): Promise<SectorMoneyItem[]> {
  const po = dir === 'inflow' ? 1 : 0;
  const url = `${PUSH2}/clist/get?pn=1&pz=${n}&po=${po}&fid=f62&fltt=2&fs=${SECTOR_FS}&fields=f3,f12,f14,f62`;
  const json = await getJson(url);
  return toRows(json).map((r) => ({
    code: String(r.f12 ?? ''),
    name: String(r.f14 ?? ''),
    pct: num(r.f3),
    // f62 主力净流入（元）→ 亿
    netInflow: num(r.f62) / 1e8,
  }));
}

/** 个股某交易日的资金流明细（push2his fflow/daykline，免 MX） */
export interface FundFlowDay {
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 主力净流入额（元） */
  main: number;
  /** 超大单净流入额（元） */
  superBig: number;
  /** 主力净流入占成交额比 % */
  mainPct: number;
  /** 收盘价 */
  close: number;
  /** 当日涨跌幅 % */
  pct: number;
}

/**
 * 个股主力资金多日序列（push2his fflow/daykline，klt=101 日线，免 MX）。
 * klines 逗号字段：f51 日期 / f52 主力 / f53 小单 / f54 中单 / f55 大单 / f56 超大单 /
 * f57 主力占比 / f58-61 各单占比 / f62 收盘价 / f63 涨跌幅。返回升序（旧→新），失败返回 []。
 */
export async function getStockFundFlow(code: string, days = 6): Promise<FundFlowDay[]> {
  if (!/^\d{6}$/.test(code)) return [];
  const url =
    `${PUSH2HIS}/stock/fflow/daykline/get?secid=${toSecid(code)}&klt=101&lmt=${days}` +
    `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63`;
  const json = await getJson(url);
  const data = json.data as { klines?: string[] } | null;
  const kl = data?.klines ?? [];
  return kl.map((row) => {
    const c = row.split(',');
    return {
      date: String(c[0] ?? ''),
      main: num(c[1]),
      superBig: num(c[5]),
      mainPct: num(c[6]),
      close: num(c[11]),
      pct: num(c[12]),
    };
  });
}

/** 两市成交额（上证+深成，今日 + 昨日 best-effort 来自日K） */
export async function getTurnoverTotal(): Promise<TurnoverTotal> {
  async function klineAmounts(secid: string): Promise<{ today: number; prev: number | null }> {
    const url = `${PUSH2HIS}/stock/kline/get?secid=${secid}&klt=101&fqt=1&end=20500101&lmt=2&fields1=f1&fields2=f51,f57`;
    const json = await getJson(url);
    const data = json.data as { klines?: string[] } | null;
    const kl = data?.klines ?? [];
    if (kl.length === 0) return { today: 0, prev: null };
    const amt = (row: string) => num(row.split(',')[1]);
    const today = amt(kl[kl.length - 1]);
    const prev = kl.length >= 2 ? amt(kl[kl.length - 2]) : null;
    return { today, prev };
  }
  const [sh, sz] = await Promise.all([klineAmounts(SH_SECID), klineAmounts(SZ_SECID)]);
  const shAmount = sh.today / 1e8;
  const szAmount = sz.today / 1e8;
  const total = shAmount + szAmount;
  const prevTotal =
    sh.prev != null && sz.prev != null ? (sh.prev + sz.prev) / 1e8 : null;
  const chgPct = prevTotal && prevTotal > 0 ? ((total - prevTotal) / prevTotal) * 100 : null;
  return { shAmount, szAmount, total, prevTotal, chgPct };
}

// ===== push2ex：涨停/跌停/炸板池（情绪与梯队）=====

/** 当日 Asia/Shanghai 日期 YYYYMMDD */
function shanghaiDateNum(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .replace(/-/g, '');
}

interface ZtPoolItem {
  c: string; // code
  n: string; // name
  hybk?: string; // 行业板块
  lbc?: number; // 连板数（连续涨停天数），如 4 即 4 连板
  zttj?: { days?: number; ct?: number }; // {days天ct板} 涨停统计（近 days 天涨停 ct 次），非连板数
  fbt?: number; // 首次封板时间（HHMMSS，如 93015 即 09:30:15，越早越强）
  lbt?: number; // 最后封板时间
  fund?: number; // 封单额（元）
  hs?: number; // 换手率 %
  amount?: number; // 成交额（元）
}

async function fetchPool(
  endpoint: 'getTopicZTPool' | 'getTopicDTPool' | 'getTopicZBPool',
  pagesize = 1,
): Promise<{ tc: number; pool: ZtPoolItem[] }> {
  const date = shanghaiDateNum();
  const url = `${PUSH2EX}/${endpoint}?ut=${PUSH2EX_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=${pagesize}&sort=fbt:asc&date=${date}`;
  try {
    const json = await getJson(url);
    const data = json.data as { tc?: number; pool?: ZtPoolItem[] } | null;
    if (!data) return { tc: 0, pool: [] };
    return { tc: num(data.tc), pool: data.pool ?? [] };
  } catch {
    return { tc: 0, pool: [] };
  }
}

/** 市场情绪温度：涨停/跌停/炸板/最高连板/炸板率 */
export async function getEmotion(): Promise<MarketEmotion> {
  const [zt, dt, zb] = await Promise.all([
    fetchPool('getTopicZTPool', 400),
    fetchPool('getTopicDTPool', 1),
    fetchPool('getTopicZBPool', 1),
  ]);
  const maxStreak = zt.pool.reduce((m, p) => Math.max(m, p.lbc ?? 0), 0);
  const denom = zt.tc + zb.tc;
  return {
    limitUp: zt.tc,
    limitDown: dt.tc,
    brokenBoard: zb.tc,
    brokenRate: denom > 0 ? (zb.tc / denom) * 100 : 0,
    maxStreak,
  };
}

/** 涨停板梯队：按连板天数分组（高板→首板），每梯队最多 20 只 */
export async function getLadder(): Promise<LadderTier[]> {
  const { pool } = await fetchPool('getTopicZTPool', 400);
  const byStreak = new Map<number, LadderTier>();
  for (const p of pool) {
    const streak = p.lbc ?? 1;
    let tier = byStreak.get(streak);
    if (!tier) {
      tier = { streak, count: 0, stocks: [] };
      byStreak.set(streak, tier);
    }
    tier.count += 1;
    if (tier.stocks.length < 20) {
      tier.stocks.push({ code: p.c, name: p.n, sector: p.hybk ?? '' });
    }
  }
  return [...byStreak.values()].sort((a, b) => b.streak - a.streak);
}

// ===== S6 龙头辨识（连板梯队 + 龙头分层）=====

/** 封板时间数字（HHMMSS）→ HH:MM:SS 文本；缺失/异常返回空串 */
function fmtSealTime(v: number | undefined): string {
  if (!v || v <= 0) return '';
  const s = String(v).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

const dragonClamp = (v: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, v));

/**
 * 龙头分 0-100（A 股短线龙头辨识，规则化、零量化知识）：
 *  - 连板高度：越高越强（8 板封顶满分，权重 40）
 *  - 封板时间：越早越强（09:30 满分→11:30 衰减，权重 30）——「先板是大哥」
 *  - 封单额：越大越强（5 亿封顶满分，权重 20）——封单厚度反映资金合力
 *  - 换手率：适度活跃（首板看换手，过低无人气、过高分歧，权重 10）
 */
function computeDragonScore(p: ZtPoolItem): number {
  const streak = p.lbc ?? 1;
  const heightScore = dragonClamp((streak / 8) * 100);

  // 封板时间：09:30(=570min) 给满分，到 11:30(=690min) 线性衰减到 0；缺失给中性 50
  let sealTimeScore = 50;
  if (p.fbt && p.fbt > 0) {
    const s = String(p.fbt).padStart(6, '0');
    const minutes = Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));
    sealTimeScore = dragonClamp(100 - ((minutes - 570) / 120) * 100);
  }

  // 封单额（元→亿）：5 亿封顶满分；缺失给中性 40
  const fundYi = p.fund != null ? p.fund / 1e8 : null;
  const fundScore = fundYi != null ? dragonClamp((fundYi / 5) * 100) : 40;

  // 换手率：8% 为理想活跃点，过低/过高都扣分；缺失给中性 50
  const hs = p.hs ?? null;
  const hsScore = hs != null ? dragonClamp(100 - Math.abs(hs - 8) * 6) : 50;

  return Math.round(heightScore * 0.4 + sealTimeScore * 0.3 + fundScore * 0.2 + hsScore * 0.1);
}

/** 龙头分层：组装连板梯队 + 每梯队龙头分排序 + 全场总龙头/中军/弹性角色标注 */
export async function getDragonRanking(): Promise<DragonOverview> {
  const [{ pool }, emotion] = await Promise.all([
    fetchPool('getTopicZTPool', 400),
    getEmotion().catch(() => null),
  ]);

  // 逐只算龙头分
  const enriched: DragonStock[] = pool.map((p) => ({
    code: p.c,
    name: p.n,
    sector: p.hybk ?? '',
    streak: p.lbc ?? 1,
    firstSealTime: fmtSealTime(p.fbt),
    sealFund: p.fund != null ? Math.round((p.fund / 1e8) * 100) / 100 : null,
    turnoverRate: p.hs ?? null,
    dragonScore: computeDragonScore(p),
    role: '弹性' as DragonRole,
  }));

  // 全场总龙头：龙头分最高者；中军：高板梯队（连板≥3且非总龙头）的强者；其余首板/低板为弹性
  const sortedByScore = [...enriched].sort((a, b) => b.dragonScore - a.dragonScore);
  const topDragon = sortedByScore[0] ?? null;
  for (const s of enriched) {
    if (topDragon && s.code === topDragon.code) s.role = '总龙头';
    else if (s.streak >= 3) s.role = '中军';
    else s.role = '弹性';
  }

  // 按连板天数分组，组内按龙头分降序，每梯队最多 20 只
  const byStreak = new Map<number, DragonStock[]>();
  for (const s of enriched) {
    const arr = byStreak.get(s.streak) ?? [];
    arr.push(s);
    byStreak.set(s.streak, arr);
  }
  const tiers = [...byStreak.entries()]
    .map(([streak, stocks]) => ({
      streak,
      count: stocks.length,
      stocks: stocks.sort((a, b) => b.dragonScore - a.dragonScore).slice(0, 20),
    }))
    .sort((a, b) => b.streak - a.streak);

  return {
    asOf: new Date().toISOString(),
    maxStreak: emotion?.maxStreak ?? (enriched.reduce((m, s) => Math.max(m, s.streak), 0) || 0),
    limitUpCount: emotion?.limitUp ?? pool.length,
    brokenRate: emotion?.brokenRate ?? 0,
    topDragon,
    tiers,
    note:
      '连板梯队龙头辨识（确定性规则：连板高度+封板时间+封单额+换手），仅供参考，不构成投资建议。',
  };
}

/** 取单只个股在当日连板梯队中的位置与龙头角色（决策/盯盘用，不在涨停池则返回 null） */
export async function getStockDragonStatus(code: string): Promise<DragonStock | null> {
  const ov = await getDragonRanking().catch(() => null);
  if (!ov) return null;
  for (const tier of ov.tiers) {
    const hit = tier.stocks.find((s) => s.code === code);
    if (hit) return hit;
  }
  return null;
}
