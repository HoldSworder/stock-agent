import type { CffexVarietyRank, MacroCffexRank } from '@stock-agent/shared';
import { record } from '../datasource/metrics';

// 中信多空单（CFFEX 股指期货持仓榜）：直连中金所每日公布的「前20会员持仓排名」原始 CSV。
// akshare get_cffex_rank_table 返回 dict-of-DataFrame，aktools 无法序列化成 JSON（HTTP 500），故不走 aktools，
// 直接抓 CFFEX 公开文件（GBK 编码、政府源、无鉴权、无反爬）。best-effort：失败返回 null。
//   文件: http://www.cffex.com.cn/sj/ccpm/{YYYYMM}/{DD}/{VARIETY}_1.csv
//   列(0-11): 交易日,合约,名次,成交量会员,成交量,成交量增减,持买单会员,持买单量,持买单增减,持卖单会员,持卖单量,持卖单增减

const BASE = 'http://www.cffex.com.cn/sj/ccpm';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SOURCE_ID = 'cffex';
const CITIC = '中信期货';

// 品种 → 展示名（顺序即展示顺序）
const VARIETIES: { variety: string; name: string }[] = [
  { variety: 'IF', name: 'IF·沪深300' },
  { variety: 'IH', name: 'IH·上证50' },
  { variety: 'IC', name: 'IC·中证500' },
  { variety: 'IM', name: 'IM·中证1000' },
];

const n = (v: string | undefined): number => {
  const x = Number(String(v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(x) ? x : 0;
};

/** 上海时区日期分段（YYYYMM / DD / YYYYMMDD），用于拼 CFFEX 文件路径 */
function shDateParts(d: Date): { ym: string; dd: string; ymd: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y, m, dd] = fmt.format(d).split('-');
  return { ym: `${y}${m}`, dd, ymd: `${y}${m}${dd}` };
}

/** 拉取单品种持仓榜 CSV（GBK 解码）。非 200（含 302 非交易日重定向）返回 null。 */
async function fetchVarietyCsv(variety: string, parts: { ym: string; dd: string }): Promise<string | null> {
  const url = `${BASE}/${parts.ym}/${parts.dd}/${variety}_1.csv`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'http://www.cffex.com.cn/' },
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status !== 200) return null;
    const buf = await res.arrayBuffer();
    const text = new TextDecoder('gbk').decode(buf);
    return text.includes(',') ? text : null;
  } catch {
    return null;
  }
}

/** 解析单品种 CSV → 该品种聚合持仓（中信单家 + 前20席位合计）；无有效数据行返回 null。 */
function parseVariety(text: string, variety: string, name: string): { rank: CffexVarietyRank; date: string } | null {
  let citicLong = 0;
  let citicLongChg = 0;
  let citicShort = 0;
  let citicShortChg = 0;
  let top20Long = 0;
  let top20LongChg = 0;
  let top20Short = 0;
  let top20ShortChg = 0;
  let date = '';
  let rows = 0;
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(',');
    if (c.length < 12 || !/^\d{8}$/.test(c[0].trim())) continue; // 跳过表头/空行
    rows += 1;
    if (!date) date = c[0].trim();
    const longMember = c[6] ?? '';
    const shortMember = c[9] ?? '';
    const longOI = n(c[7]);
    const longChg = n(c[8]);
    const shortOI = n(c[10]);
    const shortChg = n(c[11]);
    top20Long += longOI;
    top20LongChg += longChg;
    top20Short += shortOI;
    top20ShortChg += shortChg;
    if (longMember.includes(CITIC)) {
      citicLong += longOI;
      citicLongChg += longChg;
    }
    if (shortMember.includes(CITIC)) {
      citicShort += shortOI;
      citicShortChg += shortChg;
    }
  }
  if (!rows) return null;
  const fmtDate = date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
  return {
    date: fmtDate,
    rank: {
      variety,
      name,
      citicLong,
      citicShort,
      citicNet: citicLong - citicShort,
      citicNetChg: citicLongChg - citicShortChg,
      top20Long,
      top20Short,
      top20Net: top20Long - top20Short,
      top20NetChg: top20LongChg - top20ShortChg,
    },
  };
}

/**
 * 取最近交易日的中金所股指期货持仓榜（中信单家净持仓 + 前20席位净持仓，含日增减）。
 * 从上海当日起逐日回退最多 7 天定位最新有数据的交易日；best-effort，整体失败返回 null。
 */
export async function fetchCffexRank(): Promise<MacroCffexRank | null> {
  const startedAt = Date.now();
  try {
    // 先用 IF 定位最近有数据的交易日（回退最多 7 天覆盖长假）
    let parts: { ym: string; dd: string; ymd: string } | null = null;
    let ifText: string | null = null;
    for (let i = 0; i < 7; i += 1) {
      const cand = shDateParts(new Date(Date.now() - i * 86_400_000));
      const text = await fetchVarietyCsv('IF', cand);
      if (text) {
        parts = cand;
        ifText = text;
        break;
      }
    }
    if (!parts || !ifText) {
      record(SOURCE_ID, { ok: false, latencyMs: Date.now() - startedAt, error: 'CFFEX 近 7 日无持仓榜数据' });
      return null;
    }
    // 同一交易日取齐 4 个品种（IF 已取，其余并发）
    const texts: Record<string, string | null> = { IF: ifText };
    await Promise.all(
      VARIETIES.filter((v) => v.variety !== 'IF').map(async (v) => {
        texts[v.variety] = await fetchVarietyCsv(v.variety, parts as { ym: string; dd: string });
      }),
    );
    const items: CffexVarietyRank[] = [];
    let date = '';
    for (const v of VARIETIES) {
      const t = texts[v.variety];
      if (!t) continue;
      const parsed = parseVariety(t, v.variety, v.name);
      if (parsed) {
        items.push(parsed.rank);
        if (!date) date = parsed.date;
      }
    }
    if (!items.length) {
      record(SOURCE_ID, { ok: false, latencyMs: Date.now() - startedAt, error: 'CFFEX 持仓榜解析为空' });
      return null;
    }
    record(SOURCE_ID, { ok: true, latencyMs: Date.now() - startedAt });
    return {
      date,
      items,
      note: '中金所每日前20会员持仓排名。净持仓=持买−持卖；负=偏空。中信期货为最大经纪商、汇集大量机构客户，但其持仓含大量套期保值盘，单家方向不等于看空/看多，需结合前20席位合计；「日增减」比绝对值更有参考意义。仅作机构对冲背景，非择时信号。',
    };
  } catch (e) {
    record(SOURCE_ID, {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
