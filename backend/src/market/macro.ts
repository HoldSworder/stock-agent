import type {
  MacroBasis,
  MacroBasisItem,
  MacroMargin,
  MacroOverview,
  MacroRrr,
  MacroShibor,
  MacroSouthbound,
  MacroValuation,
} from '@stock-agent/shared';
import { callAkshare } from './akshare';
import { getIndexPointMap } from './eastmoney';
import { fetchCffexRank } from './cffexRank';
import { isSourceEnabled } from '../datasource/registry';

// 宏观·资金面底稿：6 个低频全局指标（日频/EOD），全部经 aktools 透传 akshare，best-effort 降级。
// 任一块取数失败仅令该块为 null，不阻断整体。每块带固定 note（影响力 + 如何使用），
// 统一定性为「环境/背景/护栏」，非择时信号——既用于 UI 展示，也注入 agent prompt。

type Row = Record<string, unknown>;

/** 安全转 number（含千分位/百分号/字符串）；不可解析返回 null */
function n(v: unknown): number | null {
  if (v == null) return null;
  const raw = String(v).replace(/[,%\s]/g, '').trim();
  const x = Number(raw);
  return Number.isFinite(x) ? x : null;
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

function asRows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

/** 股指期货基差（IF/IH/IC/IM 主连收盘 − 对应现货指数点位） */
async function fetchBasis(): Promise<MacroBasis | null> {
  if (!isSourceEnabled('akshare')) return null;
  // 品种 → 现货指数 secid（沪深300 / 上证50 / 中证500 / 中证1000）
  const defs: { sym: string; name: string; secid: string }[] = [
    { sym: 'IF0', name: 'IF·沪深300', secid: '1.000300' },
    { sym: 'IH0', name: 'IH·上证50', secid: '1.000016' },
    { sym: 'IC0', name: 'IC·中证500', secid: '1.000905' },
    { sym: 'IM0', name: 'IM·中证1000', secid: '1.000852' },
  ];
  try {
    const spotMap = await getIndexPointMap(defs.map((d) => d.secid));
    const items: MacroBasisItem[] = [];
    let asOf = '';
    await Promise.all(
      defs.map(async (d) => {
        try {
          const rows = asRows(await callAkshare('futures_main_sina', { symbol: d.sym }));
          const last = rows[rows.length - 1];
          if (!last) return;
          const future = n(last['收盘价']);
          const spot = spotMap[d.secid] || 0;
          if (future == null || future <= 0 || spot <= 0) return;
          const basis = future - spot;
          const date = String(last['日期'] ?? '').slice(0, 10);
          if (date > asOf) asOf = date;
          items.push({
            name: d.name,
            future: r2(future),
            spot: r2(spot),
            basis: r2(basis),
            basisPct: r2((basis / spot) * 100),
          });
        } catch {
          /* 单品种失败跳过 */
        }
      }),
    );
    if (!items.length) return null;
    // 维持 IF/IH/IC/IM 顺序
    items.sort((a, b) => defs.findIndex((d) => d.name === a.name) - defs.findIndex((d) => d.name === b.name));
    return {
      asOf,
      items,
      note: '基差=期货−现货。负值=贴水（机构对冲/套保压力大、情绪偏弱），尤其 IM/IC 深贴水是中小盘情绪的温度计；贴水收敛或转升水=情绪修复、多头愿付溢价。仅作情绪背景，不做择时信号。',
    };
  } catch {
    return null;
  }
}

/** 资金面利率：SHIBOR 隔夜 / 1 周 */
async function fetchShibor(): Promise<MacroShibor | null> {
  if (!isSourceEnabled('akshare')) return null;
  try {
    const rows = asRows(await callAkshare('macro_china_shibor_all'));
    const last = rows[rows.length - 1];
    if (!last) return null;
    return {
      date: String(last['日期'] ?? '').slice(0, 10),
      overnight: n(last['O/N-定价']),
      week1: n(last['1W-定价']),
      note: '银行间资金价格（DR007 代理）。利率走高=流动性收紧、对估值与风险偏好不利；走低=流动性宽松、利于做多。季末/缴税/跨节有季节性脉冲，看趋势而非单日，作为流动性底色。',
    };
  } catch {
    return null;
  }
}

/** 最近一次降准（存款准备金率） */
async function fetchRrr(): Promise<MacroRrr | null> {
  if (!isSourceEnabled('akshare')) return null;
  try {
    const rows = asRows(await callAkshare('macro_china_reserve_requirement_ratio'));
    if (!rows.length) return null;
    // 取生效时间最新的一条
    const latest = rows.reduce((acc, cur) => {
      const a = String(acc['生效时间'] ?? '');
      const c = String(cur['生效时间'] ?? '');
      return c > a ? cur : acc;
    });
    return {
      announceDate: String(latest['公布时间'] ?? ''),
      effectiveDate: String(latest['生效时间'] ?? ''),
      bigBankAfter: n(latest['大型金融机构-调整后']),
      bigBankDelta: n(latest['大型金融机构-调整幅度']),
      note: '货币政策方向标。降准释放长期流动性、利好估值与风险偏好，是中线行情的「弹药」；方向性拐点（降准降息周期）才对中线有意义，单次效应短暂。低频背景指标。',
    };
  } catch {
    return null;
  }
}

/** 取两融某交易所融资余额序列（newest first），单位换算为亿元 */
async function fetchMarginSeries(func: 'stock_margin_sse' | 'stock_margin_szse'): Promise<
  { date: string; balance: number }[]
> {
  const end = new Date();
  const start = new Date(end.getTime() - 20 * 24 * 3600 * 1000);
  const fmt = (d: Date): string =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rows = asRows(
    await callAkshare(func, { start_date: fmt(start), end_date: fmt(end) }),
  );
  const out: { date: string; balance: number }[] = [];
  for (const row of rows) {
    const date = String(row['信用交易日期'] ?? row['日期'] ?? '');
    const bal = n(row['融资余额']);
    if (date && bal != null) out.push({ date, balance: bal / 1e8 });
  }
  // 统一为 newest first
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

/** 两融余额（融资余额合计 + 近期趋势） */
async function fetchMargin(): Promise<MacroMargin | null> {
  if (!isSourceEnabled('akshare')) return null;
  try {
    const sse = await fetchMarginSeries('stock_margin_sse').catch(() => []);
    if (!sse.length) return null;
    let szseLatest: number | null = null;
    try {
      const szse = await fetchMarginSeries('stock_margin_szse');
      if (szse.length && szse[0].date === sse[0].date) szseLatest = szse[0].balance;
    } catch {
      /* 深市 best-effort，失败仅用沪市 */
    }
    const financeBalance = sse[0].balance + (szseLatest ?? 0);
    const scope = szseLatest != null ? '沪深合计' : '仅沪市';
    const prev = sse[1]?.balance ?? null;
    const changeAmount = prev != null ? sse[0].balance - prev : null;
    // 近 5 个交易日趋势（仅看沪市序列，足够定性）
    const ref = sse[Math.min(5, sse.length - 1)]?.balance ?? sse[0].balance;
    const diff = sse[0].balance - ref;
    const trend: MacroMargin['trend'] =
      diff > ref * 0.005 ? '上升' : diff < -ref * 0.005 ? '下降' : '走平';
    return {
      date: sse[0].date,
      financeBalance: r2(financeBalance),
      scope,
      changeAmount: changeAmount != null ? r2(changeAmount) : null,
      trend,
      note: '杠杆资金=风险偏好的真金白银温度计。融资余额持续净增是主升浪的确认信号；见顶回落常领先指数走弱。看趋势持续性，作为情绪/仓位倾向的佐证。',
    };
  } catch {
    return null;
  }
}

/** 南向资金（港股通净流入，沪+深成交净买额合计） */
async function fetchSouthbound(): Promise<MacroSouthbound | null> {
  if (!isSourceEnabled('akshare')) return null;
  try {
    const rows = asRows(await callAkshare('stock_hsgt_fund_flow_summary_em'));
    const south = rows.filter((r) => String(r['资金方向'] ?? '') === '南向');
    if (!south.length) return null;
    // 取最新交易日
    let date = '';
    for (const r of south) {
      const d = String(r['交易日'] ?? '').slice(0, 10);
      if (d > date) date = d;
    }
    const todays = south.filter((r) => String(r['交易日'] ?? '').slice(0, 10) === date);
    let netInflow = 0;
    let valid = false;
    for (const r of todays) {
      const v = n(r['成交净买额']);
      if (v != null) {
        netInflow += v;
        valid = true;
      }
    }
    if (!valid) return null;
    return {
      date,
      netInflow: r2(netInflow),
      note: '南向资金=港股流动性命脉，直接关系恒生科技等港股标的（如 159740）。持续净流入=内资借道港股加配、风险偏好上行；净流出需警惕。注：北向资金 2024 起已停实时披露。',
    };
  } catch {
    return null;
  }
}

/** 沪深300 估值分位（滚动市盈率历史分位） */
async function fetchValuation(): Promise<MacroValuation | null> {
  if (!isSourceEnabled('akshare')) return null;
  try {
    const rows = asRows(await callAkshare('stock_index_pe_lg', { symbol: '沪深300' }));
    if (!rows.length) return null;
    const series = rows
      .map((r) => n(r['滚动市盈率']))
      .filter((x): x is number => x != null && x > 0);
    if (!series.length) return null;
    const last = rows[rows.length - 1];
    const pe = n(last['滚动市盈率']);
    if (pe == null || pe <= 0) return null;
    const below = series.filter((x) => x <= pe).length;
    const percentile = (below / series.length) * 100;
    return {
      date: String(last['日期'] ?? '').slice(0, 10),
      pe: r2(pe),
      percentile: r2(percentile),
      note: '沪深300 滚动 PE 的历史分位（越低越便宜）。分位<30% 多为中线底部区、性价比高；>70% 偏贵需谨慎。判断指数中线大方向位置，非短线择时。',
    };
  } catch {
    return null;
  }
}

/** 汇总宏观·资金面底稿（各块 best-effort 并发，失败为 null） */
export async function buildMacroOverview(): Promise<MacroOverview> {
  const [basis, shibor, rrr, margin, southbound, valuation, cffexRank] = await Promise.all([
    fetchBasis(),
    fetchShibor(),
    fetchRrr(),
    fetchMargin(),
    fetchSouthbound(),
    fetchValuation(),
    isSourceEnabled('cffex') ? fetchCffexRank() : Promise.resolve(null),
  ]);
  return {
    asOf: new Date().toISOString(),
    basis,
    shibor,
    rrr,
    margin,
    southbound,
    valuation,
    cffexRank,
  };
}

/** 宏观·资金面底稿文本（注入 agent prompt / market_snapshot；空块跳过，never throw） */
export function formatMacroForAgent(m: MacroOverview): string {
  const lines: string[] = ['【宏观·资金面·确定性底稿】（低频/EOD，定性为环境背景与护栏，非择时信号）'];
  if (m.basis) {
    const seg = m.basis.items
      .map((i) => `${i.name} 基差${i.basis >= 0 ? '+' : ''}${i.basis}(${i.basisPct >= 0 ? '+' : ''}${i.basisPct}%)`)
      .join('；');
    lines.push(`· 股指期货基差（${m.basis.asOf}）：${seg}。${m.basis.note}`);
  }
  if (m.shibor) {
    lines.push(
      `· 资金面 SHIBOR（${m.shibor.date}）：隔夜 ${m.shibor.overnight ?? '—'}% / 1周 ${m.shibor.week1 ?? '—'}%。${m.shibor.note}`,
    );
  }
  if (m.rrr) {
    lines.push(
      `· 最近降准：${m.rrr.announceDate} 公布、${m.rrr.effectiveDate} 生效，大型机构调整后 ${m.rrr.bigBankAfter ?? '—'}%（幅度 ${m.rrr.bigBankDelta ?? '—'}%）。${m.rrr.note}`,
    );
  }
  if (m.margin) {
    lines.push(
      `· 两融融资余额（${m.margin.date}，${m.margin.scope}）：${m.margin.financeBalance} 亿，较上日 ${m.margin.changeAmount != null ? (m.margin.changeAmount >= 0 ? '+' : '') + m.margin.changeAmount + '亿' : '—'}，近5日${m.margin.trend}。${m.margin.note}`,
    );
  }
  if (m.southbound) {
    lines.push(
      `· 南向资金（${m.southbound.date}）：净${m.southbound.netInflow >= 0 ? '流入' : '流出'} ${Math.abs(m.southbound.netInflow)} 亿。${m.southbound.note}`,
    );
  }
  if (m.valuation) {
    lines.push(
      `· 沪深300估值（${m.valuation.date}）：滚动PE ${m.valuation.pe}，历史分位 ${m.valuation.percentile}%。${m.valuation.note}`,
    );
  }
  if (m.cffexRank && m.cffexRank.items.length) {
    const sign = (x: number): string => (x >= 0 ? '+' : '');
    const seg = m.cffexRank.items
      .map(
        (i) =>
          `${i.name} 中信净${sign(i.citicNet)}${i.citicNet}(日${sign(i.citicNetChg)}${i.citicNetChg})/前20净${sign(i.top20Net)}${i.top20Net}(日${sign(i.top20NetChg)}${i.top20NetChg})`,
      )
      .join('；');
    lines.push(`· 股指期货持仓榜（${m.cffexRank.date}）：${seg}。${m.cffexRank.note}`);
  }
  if (lines.length === 1) lines.push('· 宏观底稿暂不可用（数据源未连通）。');
  return lines.join('\n');
}
