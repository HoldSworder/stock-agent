import type { EtfIndexRef } from '../symbolPlans/capability';
import { trackingIndexOf } from '../symbolPlans/capability';
import { requestJson } from '../datasource/httpClient';
import { numOrNull } from '../datasource/codes';

// 东财 ETF 筛选接口：跟踪指数名称、折溢价。
// 指数代码这张表不给，名称再走行情搜索对上 6 位代码。手工登记过的 ETF 仍以登记为准。

const SELECT_URL = 'https://datacenter.eastmoney.com/stock/etfselector/api/data/get';
const SUGGEST_URL = 'https://searchadapter.eastmoney.com/api/suggest/get';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface EtfSelectRow {
  code: string;
  name: string;
  /** 跟踪的指数名称，没有就是 null */
  indexName: string | null;
  /** 折溢价 %，正数是溢价 */
  premiumPct: number | null;
}

interface IndexCandidate {
  code: string;
  name: string;
  classify: string;
  quoteId: string;
}

const rowCache = new Map<string, { at: number; row: EtfSelectRow | null }>();
const indexCache = new Map<string, { at: number; ref: EtfIndexRef | null }>();
const ROW_TTL_MS = 60_000;
const INDEX_TTL_MS = 6 * 3600_000;

/**
 * 在同名指数里挑一个能取 K 线的。
 * 沪深两市各有一条同名指数时，优先 000 / 93 开头（中证官网用的那条）。
 * 不是 A 股 6 位指数的，只留下名称，不拿去当走势基准。
 */
export function pickIndexHit(indexName: string, rows: IndexCandidate[]): EtfIndexRef | null {
  const hits = rows.filter((r) => r.classify === 'Index' && r.name === indexName);
  if (hits.length === 0) return null;
  const score = (row: IndexCandidate): number => {
    if (!/^\d\.\d{6}$/.test(row.quoteId)) return -1;
    if (/^(000|93)/.test(row.code)) return 2;
    if (row.code.startsWith('399')) return 1;
    return 0;
  };
  const best = [...hits].sort((a, b) => score(b) - score(a))[0];
  return {
    indexCode: best.code,
    indexName: best.name,
    secid: /^\d\.\d{6}$/.test(best.quoteId) ? best.quoteId : null,
  };
}

/** 拉一只 ETF 的跟踪指数名称和折溢价。失败或没有这只时返回 null */
export async function fetchEtfSelectRow(code: string): Promise<EtfSelectRow | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const hit = rowCache.get(code);
  if (hit && Date.now() - hit.at < ROW_TTL_MS) return hit.row;
  const params = new URLSearchParams({
    type: 'RPTA_APP_ETFSELECT',
    sty: 'SECURITY_CODE,SECURITY_NAME_ABBR,INDEXNAME,PREMIUM_RATIO',
    filter: `(SECURITY_CODE="${code}")`,
    p: '1',
    ps: '1',
    source: 'SECURITIES',
    client: 'APP',
  });
  try {
    const json = await requestJson({
      sourceId: 'eastmoney',
      url: `${SELECT_URL}?${params.toString()}`,
      headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
      cacheTtlMs: ROW_TTL_MS,
      maxAttempts: 2,
      retryBaseMs: 400,
      errorLabel: 'ETF跟踪指数',
      validate: (j) => (j.success === true ? null : 'ETF跟踪指数没有数据'),
    });
    const data = (json.result as { data?: Array<Record<string, unknown>> } | null)?.data ?? [];
    const row = data[0];
    const parsed: EtfSelectRow | null = row
      ? {
          code,
          name: String(row.SECURITY_NAME_ABBR ?? ''),
          indexName: typeof row.INDEXNAME === 'string' && row.INDEXNAME.trim() ? row.INDEXNAME.trim() : null,
          premiumPct: numOrNull(row.PREMIUM_RATIO),
        }
      : null;
    rowCache.set(code, { at: Date.now(), row: parsed });
    return parsed;
  } catch {
    return null;
  }
}

async function searchIndex(name: string): Promise<IndexCandidate[]> {
  const params = new URLSearchParams({ input: name, type: '14', count: '8' });
  const json = await requestJson({
    sourceId: 'eastmoney',
    url: `${SUGGEST_URL}?${params.toString()}`,
    headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' },
    cacheTtlMs: INDEX_TTL_MS,
    maxAttempts: 2,
    errorLabel: '指数搜索',
    validate: (j) => (j.QuotationCodeTable ? null : '指数搜索没有数据'),
  });
  const table = (json.QuotationCodeTable ?? {}) as { Data?: unknown };
  const rows = Array.isArray(table.Data) ? (table.Data as Array<Record<string, unknown>>) : [];
  return rows.map((r) => ({
    code: String(r.Code ?? ''),
    name: String(r.Name ?? ''),
    classify: String(r.Classify ?? ''),
    quoteId: String(r.QuoteID ?? ''),
  }));
}

/**
 * ETF 跟踪的指数。手工表优先；没有登记的，用东财 ETF 列表里的指数名称再搜索代码。
 */
export async function resolveTrackingIndex(code: string): Promise<EtfIndexRef | null> {
  const manual = trackingIndexOf(code);
  if (manual) return manual;
  const cached = indexCache.get(code);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.ref;
  const row = await fetchEtfSelectRow(code);
  if (!row?.indexName) {
    indexCache.set(code, { at: Date.now(), ref: null });
    return null;
  }
  try {
    const ref = pickIndexHit(row.indexName, await searchIndex(row.indexName));
    indexCache.set(code, { at: Date.now(), ref });
    return ref;
  } catch {
    return null;
  }
}
