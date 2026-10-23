import {
  SHARES_PER_LOT,
  type KlineBar,
  type KlinePeriod,
  type MarketIndex,
  type StockQuote,
  type TrendsResult,
  type TrendPoint,
} from '@stock-agent/shared';
import { createHash } from 'node:crypto';
import { getJson as getJsonRaw, MarketError, type FetchJsonOptions } from './eastmoney';
import { num } from '../datasource/codes';
import { requestText } from '../datasource/httpClient';

// 腾讯为独立数据源：调用统计归到 sourceId=tencent（透传其余 opts）
const getJson = (url: string, opts: FetchJsonOptions = {}): Promise<Record<string, unknown>> =>
  getJsonRaw(url, { sourceId: 'tencent', ...opts });

// 腾讯财经行情（gtimg）薄封装，作为东财的更稳数据源。
// 必须带 Referer: https://gu.qq.com/，否则高频返回「schema 文档」而非数据。

const TX_MINUTE = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';
const TX_FQKLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const TX_MKLINE = 'https://ifzq.gtimg.cn/appstock/app/kline/mkline';
const TX_XCX_BASE = 'https://proxy.finance.qq.com';
const TX_XCX_KLINE_PATH = '/cgi/cgi-bin/stockinfoquery/kline/app/get';
const TX_XCX_APP = 'zxg_xcx';
const TX_XCX_OPENID = 'stockfe';
const TX_HEADERS = { Referer: 'https://gu.qq.com/' };

// 分钟级周期 → 腾讯 mkline 的 m 参数（m5/m15/m30/m60/m120）
const TX_MIN_MAP: Partial<Record<KlinePeriod, string>> = {
  '5m': 'm5',
  '15m': 'm15',
  '30m': 'm30',
  '60m': 'm60',
  '120m': 'm120',
};

const TX_XCX_PERIOD_MAP: Record<KlinePeriod, string> = {
  '5m': 'm5',
  '15m': 'm15',
  '30m': 'm30',
  '60m': 'm60',
  '120m': 'm120',
  day: 'day',
  week: 'week',
  month: 'month',
};

/** 腾讯自选股接口所用的 MD5 十六进制摘要。 */
function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

/**
 * 生成腾讯自选股 K 线请求地址。
 * 请求签名来自当前本机安装的爱盯盘包；签名失效时由数据源调度继续使用公开腾讯与其他行情源。
 * @param now 仅供离线自检传入固定时间，线上不传。
 */
export function buildTencentXcxUrl(
  path: string,
  businessParams: Record<string, string | number | undefined>,
  now = Date.now(),
): string {
  const params: Record<string, string> = {
    app: TX_XCX_APP,
    openid: TX_XCX_OPENID,
    t: String(now),
  };
  for (const [key, value] of Object.entries(businessParams)) {
    if (value !== undefined && value !== '') params[key] = String(value);
  }
  const secret = md5(`${TX_XCX_APP}GET`).toUpperCase();
  const text = `${Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')}&key=${secret}`;
  const url = new URL(path, TX_XCX_BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('x-appid', TX_XCX_APP);
  url.searchParams.set('x-sa-v', '2');
  url.searchParams.set('x-sa-sign', md5(text));
  url.searchParams.set('x-timestamp', String(Math.floor(now / 1000)));
  return url.toString();
}

/**
 * 东财 secid / 代码转换成腾讯自选股 K 线代码。
 * 北交所、东财板块（90.BK）这个接口不认，返回空后交给后面的行情源。
 * 腾讯自己的板块写法是「数字.BK」，会转成 pt 加那段数字。
 */
export function toTencentXcxCode(code: string, secid?: string): string | null {
  const raw = (secid || code).trim();
  if (/^pt[0-9A-Za-z]+$/i.test(raw)) return raw.toLowerCase();
  const board = /^([0-9A-Za-z]+)\.BK$/i.exec(raw);
  if (board?.[1]) return `pt${board[1].toLowerCase()}`;
  if (secid) {
    const [market, symbol] = secid.split('.');
    if (!symbol) return null;
    if (market === '1' && /^\d{6}$/.test(symbol)) return `sh${symbol}`;
    if (market === '0' && /^\d{6}$/.test(symbol) && !/^(?:[48]|92)/.test(symbol)) return `sz${symbol}`;
    if (market === '116' && /^\d{5}$/.test(symbol)) return `hk${symbol}`;
    return null;
  }
  if (!/^\d{6}$/.test(code) || /^(?:[48]|92)/.test(code)) return null;
  if (/^(6|5|9|11)/.test(code)) return `sh${code}`;
  return `sz${code}`;
}

/** 腾讯自选股的日期改成图表使用的写法。8 位是日，12 位是分钟。 */
function tencentXcxTime(raw: unknown): string {
  const value = String(raw ?? '');
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (/^\d{12}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(8, 10)}:${value.slice(10, 12)}`;
  }
  return value;
}

/**
 * 东财 secid / 6 位代码 → 腾讯 code（sh/sz 前缀）。
 * 沪市（secid 前缀 1 / 代码 6,5,9 开头）→ sh；其余 → sz。板块 BKxxxx 腾讯无对应 → null。
 */
export function toTxCode(code: string, secid?: string): string | null {
  if (secid) {
    const [mkt, sym] = secid.split('.');
    if (!sym || !/^\d+$/.test(sym)) return null; // 板块 90.BKxxxx 等
    return `${mkt === '1' ? 'sh' : 'sz'}${sym}`;
  }
  if (/^\d{6}$/.test(code)) return `${/^(6|5|9)/.test(code) ? 'sh' : 'sz'}${code}`;
  return null; // BKxxxx 等
}

/**
 * 拉取腾讯当日分时并解析为 TrendsResult。
 * 数据点格式 "HHMM 价格 累计量(手) 累计额(元)"；昨收取 qt[code][4]、名称取 qt[code][1]。
 * 个股均价 = 累计额/(累计量*100)（VWAP）；指数无意义，令 avg=price 使均价线与价格线重合。
 */
export async function getTrendsTencent(code: string, secid?: string): Promise<TrendsResult> {
  const txcode = toTxCode(code, secid);
  if (!txcode) throw new MarketError(`腾讯行情不支持的代码: ${secid || code}`);
  const isIndex = !!secid;
  const url = `${TX_MINUTE}?code=${txcode}`;
  const json = await getJson(url, {
    label: '腾讯行情',
    headers: TX_HEADERS,
    validate: (j) => {
      const node = (j.data as Record<string, unknown> | undefined)?.[txcode] as
        | { data?: { data?: unknown } }
        | undefined;
      return Array.isArray(node?.data?.data) && node!.data!.data!.length > 0;
    },
  });

  const node = (json.data as Record<string, unknown>)[txcode] as {
    data?: { data?: string[]; date?: string };
    qt?: Record<string, string[]>;
  };
  const rows = node.data?.data ?? [];
  const qt = node.qt?.[txcode] ?? [];
  const prevClose = num(qt[4]);
  const tradeDate = toTradeDate(node.data?.date);

  let prevCumVol = 0;
  const points: TrendPoint[] = rows.map((row) => {
    const [t, priceStr, cumVolStr, cumAmtStr] = row.split(' ');
    const price = num(priceStr);
    const cumVol = num(cumVolStr);
    const cumAmt = num(cumAmtStr);
    // 腾讯量额为累计值，分时点需要每分钟增量
    const volume = Math.max(cumVol - prevCumVol, 0);
    prevCumVol = cumVol;
    const avg = isIndex || cumVol <= 0 ? price : cumAmt / (cumVol * SHARES_PER_LOT);
    return {
      time: t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : t,
      price,
      avg,
      volume,
    } satisfies TrendPoint;
  });

  return {
    code,
    name: String(qt[1] ?? ''),
    prevClose,
    points,
    ...(tradeDate ? { tradeDate } : {}),
  };
}

/**
 * 腾讯分时的 data.date → YYYY-MM-DD。实测有 "20260807" 与 "260807" 两种写法，
 * 都补齐成完整日期；认不出的形态返回 null（宁可缺字段，也不给消费方一个错日期）。
 */
function toTradeDate(raw: string | undefined): string | null {
  const s = String(raw ?? '');
  const full = /^\d{8}$/.test(s) ? s : /^\d{6}$/.test(s) ? `20${s}` : '';
  return full ? `${full.slice(0, 4)}-${full.slice(4, 6)}-${full.slice(6, 8)}` : null;
}

/**
 * 指数实时报价兜底（腾讯 minute query 的 qt 字段，JSON，无需 GBK）。
 * qt[1] 名称 / qt[3] 现价 / qt[4] 昨收 / qt[32] 涨跌幅%。逐个 secid 取，单个失败跳过、空名过滤。
 * 仅用于东财指数失败时兜底，故名称/点位/涨跌幅即可，code 取 secid 的代码段。
 */
export async function getIndicesTencent(secids: string[]): Promise<MarketIndex[]> {
  const results = await Promise.all(
    secids.map(async (secid) => {
      const txcode = toTxCode('', secid);
      if (!txcode) return null;
      try {
        const url = `${TX_MINUTE}?code=${txcode}`;
        const json = await getJson(url, {
          label: '腾讯指数',
          headers: TX_HEADERS,
          validate: (j) => {
            const node = (j.data as Record<string, unknown> | undefined)?.[txcode] as
              | { qt?: Record<string, string[]> }
              | undefined;
            return Array.isArray(node?.qt?.[txcode]) && node!.qt![txcode]!.length > 4;
          },
        });
        const node = (json.data as Record<string, unknown>)[txcode] as {
          qt?: Record<string, string[]>;
        };
        const qt = node.qt?.[txcode] ?? [];
        const name = String(qt[1] ?? '');
        if (!name) return null;
        return {
          code: secid.split('.')[1] ?? '',
          name,
          point: num(qt[3]),
          pct: num(qt[32]),
          secid,
        } satisfies MarketIndex;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((x): x is MarketIndex => x != null && x.name !== '');
}

/**
 * 腾讯 K 线行（[date/time, open, close, high, low, volume, ...amount?]）→ KlineBar。
 * 导出以便单位不变式自检（klineVolumeUnit.selfcheck）离线断言「腾讯给『手』，不许再除 100」。
 */
export function toTencentBar(row: unknown[], isMinute: boolean): KlineBar {
  const rawTime = String(row[0] ?? '');
  // 分钟级 time 为 "YYYYMMDDHHMM"，归一为 "YYYY-MM-DD HH:MM"；日/周/月已是 "YYYY-MM-DD"
  const time =
    isMinute && /^\d{12}$/.test(rawTime)
      ? `${rawTime.slice(0, 4)}-${rawTime.slice(4, 6)}-${rawTime.slice(6, 8)} ${rawTime.slice(8, 10)}:${rawTime.slice(10, 12)}`
      : rawTime;
  return {
    time,
    open: num(row[1]),
    close: num(row[2]),
    high: num(row[3]),
    low: num(row[4]),
    // 腾讯 volume 单位为「手」，与本项目 KlineBar.volume 口径一致，无需换算。
    // 注：新浪与 mootdx 返回的是「股」，已在各自解析层 /100 归一；此处若日后发现量级
    // 比东财大 100 倍（同一交易日对账），说明腾讯也改口径了，同样补 /100。
    volume: num(row[5]),
    // 分钟级第 8 列为成交额。日/周/月置 0 不是偷懒：2026-08-04 实测 fqkline/get 每行**只有 6 列**
    // ["2026-08-04","1350.06","1328.36","1350.94","1328.36","37450"]，本源日线确实不返回成交额，
    // 无第 7 列可补。腾讯又排日线链首位（比东财稳，见文件头），故量能侧由消费层解决：
    // symbolPlans/volumePrice.ts 的 pickBasis 在「本源整窗口无成交额」时回退成交量口径并显式标注。
    amount: isMinute ? num(row[7]) : 0,
  } satisfies KlineBar;
}

/**
 * 腾讯 K 线（前复权），支持个股 / 指数；板块（BKxxxx）无对应代码 → 抛错由编排回退。
 * 日/周/月走 fqkline/get（qfq），读 data[code]['qfq'+period]；
 * 分钟（5/15/30/60/120）走 kline/mkline，读 data[code]['m'+n]。
 */
export async function getKlineTencent(
  code: string,
  period: KlinePeriod = 'day',
  limit = 250,
  secid?: string,
): Promise<KlineBar[]> {
  const txcode = toTxCode(code, secid);
  if (!txcode) throw new MarketError(`腾讯行情不支持的代码: ${secid || code}`);

  const mParam = TX_MIN_MAP[period];
  if (mParam) {
    const url = `${TX_MKLINE}?param=${txcode},${mParam},,${limit}`;
    const json = await getJson(url, {
      label: '腾讯行情',
      headers: TX_HEADERS,
      validate: (j) => {
        const node = (j.data as Record<string, unknown> | undefined)?.[txcode] as
          | Record<string, unknown>
          | undefined;
        return Array.isArray(node?.[mParam]);
      },
    });
    const node = (json.data as Record<string, unknown>)[txcode] as Record<string, unknown[][]>;
    return (node[mParam] ?? []).map((row) => toTencentBar(row, true));
  }

  if (period !== 'day' && period !== 'week' && period !== 'month') {
    throw new MarketError(`腾讯行情不支持的周期: ${period}`);
  }
  const url = `${TX_FQKLINE}?param=${txcode},${period},,,${limit},qfq`;
  const key = `qfq${period}`;
  const json = await getJson(url, {
    label: '腾讯行情',
    headers: TX_HEADERS,
    validate: (j) => {
      const node = (j.data as Record<string, unknown> | undefined)?.[txcode] as
        | Record<string, unknown>
        | undefined;
      return Array.isArray(node?.[key]) || Array.isArray(node?.[period]);
    },
  });
  const node = (json.data as Record<string, unknown>)[txcode] as Record<string, unknown[][]>;
  const rows = node[key] ?? node[period] ?? [];
  return rows.map((row) => toTencentBar(row, false));
}

interface TencentXcxNode {
  date?: unknown;
  open?: unknown;
  last?: unknown;
  high?: unknown;
  low?: unknown;
  volume?: unknown;
  amount?: unknown;
}

/**
 * 腾讯自选股单根 K 线转换。
 * 沪深日、周、月线的成交量是股，要换成手；分钟线和港股保持原值。
 */
export function toTencentXcxBar(
  node: TencentXcxNode,
  opts: { minute: boolean; volumeInShares: boolean },
): KlineBar {
  return {
    time: tencentXcxTime(node.date),
    open: num(node.open),
    close: num(node.last),
    high: num(node.high),
    low: num(node.low),
    volume: opts.volumeInShares ? num(node.volume) / SHARES_PER_LOT : num(node.volume),
    amount: num(node.amount),
  };
}

/**
 * 腾讯自选股签名 K 线。
 * 仅作为公开腾讯接口的后备：签名规则或接口变动不会阻塞后续东财、通达信和新浪数据源。
 */
export async function getKlineTencentXcx(
  code: string,
  period: KlinePeriod = 'day',
  limit = 250,
  secid?: string,
): Promise<KlineBar[]> {
  const txcode = toTencentXcxCode(code, secid);
  if (!txcode) throw new MarketError(`腾讯自选股不支持的代码: ${secid || code}`);
  const ktype = TX_XCX_PERIOD_MAP[period];
  const minute = period.endsWith('m');
  const market = secid?.split('.')[0];
  const volumeInShares = !minute && (market === '1' || market === '0' || (!secid && /^\d{6}$/.test(code)));
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const url = buildTencentXcxUrl(TX_XCX_KLINE_PATH, { code: txcode, ktype, limit });
    try {
      const json = await getJson(url, {
        label: '腾讯自选股 K 线',
        maxAttempts: 1,
        validate: (data) => {
          const body = data.data as { nodes?: unknown } | undefined;
          return data.code === 0 && Array.isArray(body?.nodes) && body.nodes.length > 0;
        },
      });
      const body = json.data as { nodes?: TencentXcxNode[] } | undefined;
      return (body?.nodes ?? []).map((node) => toTencentXcxBar(node, { minute, volumeInShares }));
    } catch (error) {
      const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 0;
      if (status >= 400 && status < 500) throw error;
      lastError = error instanceof Error ? error : new MarketError(String(error));
    }
  }
  throw lastError ?? new MarketError('腾讯自选股 K 线没有返回');
}

/**
 * 6 位代码 → 腾讯批量现价符号。
 * 北交所 4/8/92 用 bj；沪市股票、基金和 11 开头的转债用 sh；其余用 sz。
 * 沪市基金必须是 sh，拼成 sz 时腾讯只回短行，等于没这只。
 */
export function tencentQuoteSymbol(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  if (code.startsWith('92') || code.startsWith('4') || code.startsWith('8')) return `bj${code}`;
  if (code.startsWith('6') || code.startsWith('9') || code.startsWith('5') || code.startsWith('11')) return `sh${code}`;
  return `sz${code}`;
}

/**
 * 解析腾讯 qt.gtimg.cn 的一批现价文本。成交额字段单位是万，这里换成亿。
 * 收盘价不是正数的行丢掉。
 */
export function parseTencentQuotes(body: string): StockQuote[] {
  const out: StockQuote[] = [];
  for (const line of body.split(';')) {
    if (!line.includes('="')) continue;
    const raw = line.split('"')[1];
    if (!raw) continue;
    const vals = raw.split('~');
    if (vals.length < 53) continue;
    const code = vals[2] ?? '';
    if (!/^\d{6}$/.test(code)) continue;
    const price = num(vals[3]);
    if (!(price > 0)) continue;
    const turnover = num(vals[38]);
    const amplitude = num(vals[43]);
    const volRatio = num(vals[49]);
    const high = num(vals[33]);
    const low = num(vals[34]);
    const open = num(vals[5]);
    out.push({
      code,
      name: vals[1] ?? '',
      price,
      pct: num(vals[32]),
      prevClose: num(vals[4]),
      amount: num(vals[37]) / 1e4,
      ...(amplitude > 0 ? { amplitude } : {}),
      ...(turnover > 0 ? { turnoverRate: turnover } : {}),
      ...(volRatio > 0 ? { volumeRatio: volRatio } : {}),
      ...(open > 0 ? { open } : {}),
      ...(high > 0 ? { high } : {}),
      ...(low > 0 ? { low } : {}),
    });
  }
  return out;
}

/** 腾讯批量现价。一只都没有时抛错，交给下一家数据源 */
export async function getQuotesTencent(codes: string[]): Promise<StockQuote[]> {
  const symbols = codes.map(tencentQuoteSymbol).filter((s): s is string => !!s);
  if (symbols.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += 80) chunks.push(symbols.slice(i, i + 80));
  const parts = await Promise.all(
    chunks.map((chunk) =>
      requestText({
        sourceId: 'tencent',
        url: `https://qt.gtimg.cn/q=${chunk.join(',')}`,
        headers: { ...TX_HEADERS, 'User-Agent': 'Mozilla/5.0' },
        encoding: 'gbk',
        timeoutMs: 8000,
        maxAttempts: 2,
        retryBaseMs: 400,
        errorLabel: '腾讯现价',
        makeError: (m) => new MarketError(m),
      }),
    ),
  );
  const quotes = parseTencentQuotes(parts.join(';'));
  if (quotes.length === 0) throw new MarketError('腾讯现价没有返回');
  return quotes;
}
