import type { StockQuote } from '@stock-agent/shared';
import { requestText } from '../datasource/httpClient';
import { num, toNetease } from '../datasource/codes';

// 网易财经实时行情（api.money.126.net feed）薄封装，作为东财之外的报价兜底源。
// 返回 JSONP：_ntes_quote_callback({"0600000":{...}})，UTF-8，名称不乱码（不同于腾讯/新浪 GBK 接口）。

const NETEASE_FEED = 'https://api.money.126.net/data/feed';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class NeteaseError extends Error {}

/**
 * 批量个股实时报价（网易 feed，一次取多只）。
 * 字段：price 现价 / yestclose 昨收 / percent 涨跌幅(小数) / turnover 成交额(元) / name 名称。
 * 网易不提供换手率/量比，turnoverRate/volumeRatio 省略。
 */
export async function getQuotesNetease(codes: string[]): Promise<StockQuote[]> {
  const valid = codes.filter((c) => /^\d{6}$/.test(c));
  if (valid.length === 0) return [];
  const ids = valid.map(toNetease);
  const url = `${NETEASE_FEED}/${ids.join(',')},money.api`;
  const text = await requestText({
    sourceId: 'netease',
    url,
    headers: { 'User-Agent': UA, Referer: 'https://quotes.money.163.com/' },
    cacheTtlMs: 15_000,
    maxAttempts: 3,
    retryBaseMs: 500,
    errorLabel: '网易行情',
    makeError: (m) => new NeteaseError(m),
  });
  // 剥离 JSONP 包裹 _ntes_quote_callback({...});
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) throw new NeteaseError('网易行情响应格式异常');
  let obj: Record<string, Record<string, unknown>>;
  try {
    obj = JSON.parse(text.slice(start + 1, end)) as Record<string, Record<string, unknown>>;
  } catch {
    throw new NeteaseError('网易行情响应解析失败');
  }
  const out: StockQuote[] = [];
  for (const c of valid) {
    const o = obj[toNetease(c)];
    if (!o) continue;
    out.push({
      code: c,
      name: String(o.name ?? ''),
      price: num(o.price),
      pct: num(o.percent) * 100,
      prevClose: num(o.yestclose),
      // turnover 成交额（元）→ 亿
      amount: num(o.turnover) / 1e8,
    });
  }
  if (out.length === 0) throw new NeteaseError('网易行情无有效数据');
  return out;
}
