import type { KlineBar, KlinePeriod, MarketIndex, TrendsResult, TrendPoint } from '@stock-agent/shared';
import { getJson as getJsonRaw, MarketError, type FetchJsonOptions } from './eastmoney';
import { num } from '../datasource/codes';

// 腾讯为独立数据源：调用统计归到 sourceId=tencent（透传其余 opts）
const getJson = (url: string, opts: FetchJsonOptions = {}): Promise<Record<string, unknown>> =>
  getJsonRaw(url, { sourceId: 'tencent', ...opts });

// 腾讯财经行情（gtimg）薄封装，作为东财的更稳数据源。
// 必须带 Referer: https://gu.qq.com/，否则高频返回「schema 文档」而非数据。

const TX_MINUTE = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query';
const TX_FQKLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
const TX_MKLINE = 'https://ifzq.gtimg.cn/appstock/app/kline/mkline';
const TX_HEADERS = { Referer: 'https://gu.qq.com/' };

// 分钟级周期 → 腾讯 mkline 的 m 参数（m5/m15/m30/m60/m120）
const TX_MIN_MAP: Partial<Record<KlinePeriod, string>> = {
  '5m': 'm5',
  '15m': 'm15',
  '30m': 'm30',
  '60m': 'm60',
  '120m': 'm120',
};

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

  let prevCumVol = 0;
  const points: TrendPoint[] = rows.map((row) => {
    const [t, priceStr, cumVolStr, cumAmtStr] = row.split(' ');
    const price = num(priceStr);
    const cumVol = num(cumVolStr);
    const cumAmt = num(cumAmtStr);
    // 腾讯量额为累计值，分时点需要每分钟增量
    const volume = Math.max(cumVol - prevCumVol, 0);
    prevCumVol = cumVol;
    const avg = isIndex || cumVol <= 0 ? price : cumAmt / (cumVol * 100);
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
  };
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

/** 腾讯 K 线行（[date/time, open, close, high, low, volume, ...amount?]）→ KlineBar */
function toBar(row: unknown[], isMinute: boolean): KlineBar {
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
    volume: num(row[5]),
    // 分钟级第 8 列为成交额；日/周/月无成交额，置 0
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
    return (node[mParam] ?? []).map((row) => toBar(row, true));
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
  return rows.map((row) => toBar(row, false));
}
