import { requestJson } from '../datasource/httpClient';
import { num, shanghaiYmd } from '../datasource/codes';

// 东财 datacenter / F10 结构化数据（龙虎榜 / 限售解禁 / 增减持 / 股权质押 / 财报主表），
// 对标 TradingAgents-astock 的 get_insider_transactions / get_fundamentals，免 MX_APIKEY、直连 HTTP。
// 东财 datacenter 有风控（实测 >5/s 或并发 ≥10 触发临时封 IP），故所有请求经串行节流（间隔 ≥1s）+ 6h 内存缓存。

const WEB_BASE = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const F10_BASE = 'https://datacenter.eastmoney.com/securities/api/data/v1/get';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/' };
const CACHE_TTL = 6 * 3600 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 串行节流：东财 datacenter 全局串行，相邻请求间隔 ≥1s，避免批量分析触发封 IP
let emChain: Promise<unknown> = Promise.resolve();
let lastEmAt = 0;
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = emChain.then(async () => {
    const wait = Math.max(0, 1000 - (Date.now() - lastEmAt));
    if (wait > 0) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastEmAt = Date.now();
    }
  });
  emChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run as Promise<T>;
}

/** 6 位代码 → F10 SECUCODE（带 .SH/.SZ 后缀） */
function toSecucode(code: string): string {
  return `${code}.${/^(6|5|9)/.test(code) ? 'SH' : 'SZ'}`;
}

/** 拉取一张 datacenter 报表，返回 result.data 行数组（空/失败返回 []） */
async function fetchRows(base: string, params: Record<string, string>, sourceId: string): Promise<Record<string, unknown>[]> {
  const qs = new URLSearchParams(params).toString();
  const url = `${base}?${qs}`;
  const json = await throttled(() =>
    requestJson({
      sourceId,
      url,
      headers: HEADERS,
      timeoutMs: 12000,
      maxAttempts: 2,
      cacheTtlMs: CACHE_TTL,
      errorLabel: '东财 datacenter',
    }),
  );
  const result = json.result as { data?: unknown } | null | undefined;
  const data = result?.data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function fmtDate(v: unknown): string {
  return String(v ?? '').slice(0, 10);
}

/**
 * 龙虎榜上榜明细（个股近 N 次）：上榜日/涨跌幅/净买入/换手/上榜原因。
 * 游资追踪师的核心资金面证据，A 股短线定价关键。
 */
export async function getDragonTiger(code: string, limit = 5): Promise<string> {
  const rows = await fetchRows(
    WEB_BASE,
    {
      reportName: 'RPT_DAILYBILLBOARD_DETAILSNEW',
      columns: 'ALL',
      filter: `(SECURITY_CODE="${code}")`,
      sortColumns: 'TRADE_DATE',
      sortTypes: '-1',
      pageSize: String(limit),
      pageNumber: '1',
      source: 'WEB',
      client: 'WEB',
    },
    'em-dc-dragon',
  );
  if (!rows.length) return '近期无龙虎榜上榜记录。';
  const name = String(rows[0].SECURITY_NAME_ABBR ?? code);
  const lines = rows.map((r) => {
    const net = num(r.BILLBOARD_NET_AMT) / 1e4;
    const reason = String(r.EXPLANATION || r.EXPLAIN || '').trim();
    return (
      `${fmtDate(r.TRADE_DATE)} 涨跌${num(r.CHANGE_RATE).toFixed(2)}% ` +
      `净买入${net >= 0 ? '+' : ''}${net.toFixed(0)}万 换手${num(r.TURNOVERRATE).toFixed(2)}%` +
      (reason ? ` 原因:${reason}` : '')
    );
  });
  return `${name}(${code}) 近 ${rows.length} 次龙虎榜：\n${lines.join('\n')}`;
}

/**
 * 限售解禁 + 大股东增减持 + 股权质押概况。
 * 解禁监控师的供给冲击证据（A 股特有）。
 */
export async function getLockupAndHolders(code: string): Promise<string> {
  const today = shanghaiYmd().ymd;
  const [lifts, holders, pledges] = await Promise.all([
    fetchRows(
      WEB_BASE,
      {
        reportName: 'RPT_LIFT_STAGE',
        columns: 'ALL',
        filter: `(SECURITY_CODE="${code}")(FREE_DATE>='${today}')`,
        sortColumns: 'FREE_DATE',
        sortTypes: '1',
        pageSize: '5',
        source: 'WEB',
        client: 'WEB',
      },
      'em-dc-lift',
    ).catch(() => [] as Record<string, unknown>[]),
    fetchRows(
      WEB_BASE,
      {
        reportName: 'RPT_SHARE_HOLDER_INCREASE',
        columns: 'ALL',
        filter: `(SECURITY_CODE="${code}")`,
        sortColumns: 'NOTICE_DATE',
        sortTypes: '-1',
        pageSize: '5',
        source: 'WEB',
        client: 'WEB',
      },
      'em-dc-holder',
    ).catch(() => [] as Record<string, unknown>[]),
    fetchRows(
      WEB_BASE,
      {
        reportName: 'RPT_CSDC_LIST',
        columns: 'ALL',
        filter: `(SECURITY_CODE="${code}")`,
        sortColumns: 'TRADE_DATE',
        sortTypes: '-1',
        pageSize: '1',
        source: 'WEB',
        client: 'WEB',
      },
      'em-dc-pledge',
    ).catch(() => [] as Record<string, unknown>[]),
  ]);

  const parts: string[] = [];
  if (lifts.length) {
    parts.push(
      '即将解禁：\n' +
        lifts
          .map(
            (r) =>
              `${fmtDate(r.FREE_DATE)} 解禁${num(r.CURRENT_FREE_SHARES).toFixed(0)}万股 ` +
              `占总股本${(num(r.TOTAL_RATIO) * 100).toFixed(2)}% 市值${(num(r.LIFT_MARKET_CAP) / 1e4).toFixed(2)}亿 ` +
              `类型${String(r.FREE_SHARES_TYPE ?? '')}`,
          )
          .join('\n'),
    );
  } else {
    parts.push('近期无限售解禁安排。');
  }
  if (holders.length) {
    parts.push(
      '大股东增减持（近期）：\n' +
        holders
          .map(
            (r) =>
              `${fmtDate(r.NOTICE_DATE)} ${String(r.HOLDER_NAME ?? '')} ${String(r.DIRECTION ?? '')} ` +
              `${num(r.CHANGE_NUM).toFixed(2)}万股 均价${num(r.TRADE_AVERAGE_PRICE).toFixed(2)}`,
          )
          .join('\n'),
    );
  }
  if (pledges.length) {
    const p = pledges[0];
    parts.push(`股权质押：截至${fmtDate(p.TRADE_DATE)} 质押比例${num(p.PLEDGE_RATIO).toFixed(2)}% 质押${num(p.PLEDGE_DEAL_NUM).toFixed(0)}笔`);
  }
  return parts.join('\n\n') || '暂无解禁/增减持/质押数据。';
}

/**
 * 财报主表（F10 主要财务指标，跨三表精华）：营收/归母净利/毛利/EPS/BPS/每股经营现金流/ROE 及同比。
 * 基本面分析师的结构化盈利与成长性证据，替代妙想自然语言近似。
 */
export async function getFinancialStatements(code: string): Promise<string> {
  const rows = await fetchRows(
    F10_BASE,
    {
      reportName: 'RPT_F10_FINANCE_MAINFINADATA',
      columns: 'ALL',
      filter: `(SECUCODE="${toSecucode(code)}")`,
      sortColumns: 'REPORT_DATE',
      sortTypes: '-1',
      pageSize: '4',
      source: 'HSF10',
      client: 'PC',
    },
    'em-dc-finance',
  );
  if (!rows.length) return '暂无财报数据。';
  const latest = rows[0];
  const name = String(latest.SECURITY_NAME_ABBR ?? code);
  const yi = (v: unknown): string => (num(v) / 1e8).toFixed(2);
  const pct = (v: unknown): string => `${num(v) >= 0 ? '+' : ''}${num(v).toFixed(2)}%`;
  const head =
    `${name}(${code}) 最新 ${String(latest.REPORT_DATE_NAME ?? '')}：\n` +
    `营收 ${yi(latest.TOTALOPERATEREVE)}亿(同比${pct(latest.TOTALOPERATEREVETZ)})\n` +
    `归母净利 ${yi(latest.PARENTNETPROFIT)}亿(同比${pct(latest.PARENTNETPROFITTZ)})\n` +
    `毛利 ${yi(latest.MLR)}亿 ｜ 负债总额 ${yi(latest.LIABILITY)}亿\n` +
    `EPS ${num(latest.EPSJB).toFixed(2)} ｜ BPS ${num(latest.BPS).toFixed(2)} ｜ 每股经营现金流 ${num(latest.MGJYXJJE).toFixed(2)}\n` +
    `ROE(加权) ${num(latest.ROEJQ).toFixed(2)}%`;
  const trend =
    rows.length > 1
      ? '\n近几期营收/归母净利：\n' +
        rows
          .map((r) => `${String(r.REPORT_DATE_NAME ?? '')}: 营收${yi(r.TOTALOPERATEREVE)}亿 / 净利${yi(r.PARENTNETPROFIT)}亿`)
          .join('\n')
      : '';
  return head + trend;
}

/**
 * 个股当前估值快照（东财 datacenter RPT_VALUEANALYSIS_DET，免 MX）：PE(TTM)/PE(静)/PB/PEG/PS/PCF + 所属行业 + 总市值。
 * 注意：东财该报表仅给「当前值」，不含历史分位；历史分位与同业中位数对比由上层用妙想增补。
 */
export async function getStockValuation(code: string): Promise<string> {
  const rows = await fetchRows(
    WEB_BASE,
    {
      reportName: 'RPT_VALUEANALYSIS_DET',
      columns:
        'SECURITY_CODE,SECURITY_NAME_ABBR,TRADE_DATE,PE_TTM,PE_LAR,PB_MRQ,PEG_CAR,PS_TTM,PCF_OCF_TTM,BOARD_NAME,CLOSE_PRICE,TOTAL_MARKET_CAP',
      filter: `(SECURITY_CODE="${code}")`,
      sortColumns: 'TRADE_DATE',
      sortTypes: '-1',
      pageSize: '1',
      source: 'WEB',
      client: 'WEB',
    },
    'em-dc-valuation',
  );
  if (!rows.length) return '暂无估值数据。';
  const r = rows[0];
  const name = String(r.SECURITY_NAME_ABBR ?? code);
  // PE/PB/PS/PCF 负值（亏损/负现金流）无估值意义，置 —；PEG 可为负，照实显示
  const pos = (v: unknown): string => {
    const n = num(v);
    return n > 0 ? n.toFixed(2) : '—';
  };
  const peg = num(r.PEG_CAR);
  return (
    `${name}(${code}) 当前估值（${fmtDate(r.TRADE_DATE)}，东财）：\n` +
    `PE(TTM) ${pos(r.PE_TTM)} ｜ PE(静) ${pos(r.PE_LAR)} ｜ PB ${pos(r.PB_MRQ)} ｜ PEG ${peg !== 0 ? peg.toFixed(2) : '—'}\n` +
    `PS(TTM) ${pos(r.PS_TTM)} ｜ PCF(TTM) ${pos(r.PCF_OCF_TTM)} ｜ 行业 ${String(r.BOARD_NAME ?? '—')} ｜ 总市值 ${(num(r.TOTAL_MARKET_CAP) / 1e8).toFixed(0)}亿`
  );
}
