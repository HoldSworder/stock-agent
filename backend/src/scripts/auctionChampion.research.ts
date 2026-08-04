// 竞价冠军 Top3 战法 · 小样本点验证取数（一次性研究脚本，非站内模块）。
//
// 目的：在新浪分笔可回溯的窗口内（约最近 14 个交易日），为每个信号日产出
// 「候选特征表 + 前向收益」，供任意打分公式做秒级后处理。
// 之所以不在脚本里直接算 Top3：战法原文只明确了竞价倍率的加分数值（0/2/5/7），
// 对数加分、形态分、聚类分、炸板扣分的系数都没给，编系数就成了近似。
//
// 口径（全部可验算，不做近似）：
//   - 竞价涨幅 / 前向收益：一律用东财前复权日线（open 即 9:25 竞价成交价），复权因子一致；
//   - 竞价成交额：用新浪分笔当日首笔（09:25 撮合）价×量，真实资金额，不受复权影响；
//   - 9:30 后首个可成交价：同一份分笔里 09:30 之后第一笔，用「首价/竞价价」比例折算到复权基准，
//     用于对照战法自己强调的「不得把 9:25 竞价价当可成交价」；
//   - Gate：战法的 SKIP 需「上涨家数占比 < 9%」且「跌停家数 >= 100」同时成立。上涨家数占比无历史源，
//     故只要跌停家数 < 100 即可确定不 SKIP；跌停家数 >= 100 的日子标 unknown 并剔除，不猜。
//
// 运行：cd backend && pnpm exec tsx src/scripts/auctionChampion.research.ts [--days=14] [--max-ticks=20]
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { KlineBar } from '@stock-agent/shared';
import { callAkshare } from '../market/akshare';
import { getKline } from '../market/eastmoney';

const OUT_DIR = join(import.meta.dirname, '../../../mode/auction-champion-top3');
const CACHE_DIR = join(OUT_DIR, 'cache');

const arg = (name: string, dflt: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) || dflt : dflt;
};
/** 回看几个交易日作为信号日 */
const DAYS = arg('days', 14);
/** 每个信号日最多对多少只候选取分笔（控制耗时；按竞价涨幅接近 6% 排序优先） */
const MAX_TICKS = arg('max-ticks', 20);

/** 竞价涨幅硬口径 2%~9% */
const PCT_MIN = 2;
const PCT_MAX = 9;
/** 竞价成交额硬口径 2000 万元 */
const AMOUNT_MIN = 20_000_000;

const ymd = (d: string): string => d.replace(/-/g, '');
const sinaSymbol = (code: string): string => (/^(60|68|900)/.test(code) ? `sh${code}` : `sz${code}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- 分笔缓存（一只一天一个文件，断点续跑不重复拉）----

interface TickInfo {
  /** 09:25 撮合成交价（未复权） */
  auctionPrice: number;
  /** 09:25 撮合成交量（股） */
  auctionShares: number;
  /** 09:30 之后首笔成交价（未复权），无则 null */
  firstAfterOpen: number | null;
}

function cachePath(code: string, date: string): string {
  return join(CACHE_DIR, `${code}-${ymd(date)}.json`);
}

async function getTickInfo(code: string, date: string): Promise<TickInfo | null> {
  const p = cachePath(code, date);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf-8')) as TickInfo;
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await callAkshare('stock_intraday_sina', {
      symbol: sinaSymbol(code),
      date: ymd(date),
    })) as Array<Record<string, unknown>>;
  } catch {
    return null; // 超出新浪回溯窗口 / 当日停牌
  }
  if (!rows.length) return null;
  const t = (r: Record<string, unknown>): string => String(r.ticktime ?? '');
  // 首笔须落在 09:25 区间，否则该股当日无集合竞价成交，不参与
  const head = rows[0];
  if (!t(head).startsWith('09:2')) return null;
  const after = rows.find((r) => t(r) >= '09:30:00');
  const info: TickInfo = {
    auctionPrice: Number(head.price),
    auctionShares: Number(head.volume),
    firstAfterOpen: after ? Number(after.price) : null,
  };
  writeFileSync(p, JSON.stringify(info), 'utf-8');
  return info;
}

// ---- 日线缓存 ----

const klineCache = new Map<string, KlineBar[]>();
async function bars(code: string): Promise<KlineBar[]> {
  const hit = klineCache.get(code);
  if (hit) return hit;
  let b: KlineBar[] = [];
  try {
    b = await getKline(code, 'day', 120);
  } catch {
    b = [];
  }
  klineCache.set(code, b);
  return b;
}

/** 战法定义的 RSI6：D-1 及之前收盘序列 + D 的竞价价，取最近 6 段涨跌 */
function rsi6(closesBeforeD: number[], auctionAdj: number): number | null {
  const seq = [...closesBeforeD.slice(-7), auctionAdj];
  if (seq.length < 7) return null;
  const diffs: number[] = [];
  for (let i = seq.length - 6; i < seq.length; i++) diffs.push(seq[i] - seq[i - 1]);
  const up = diffs.filter((d) => d > 0).reduce((s, d) => s + d, 0);
  const abs = diffs.reduce((s, d) => s + Math.abs(d), 0);
  return abs > 0 ? (up / abs) * 100 : 0;
}

interface Row {
  date: string;
  code: string;
  name: string;
  auctionPct: number;
  auctionAmountWan: number;
  auctionRatio: number | null;
  rsi6: number | null;
  prevBoards: number;
  prevBreaks: number;
  prevSealTime: string;
  /** 9:30 后首个可成交价相对竞价价的溢价（%），正数=开盘就比竞价贵 */
  slipPct: number | null;
  fwd: Array<number | null>;
  fwdReal: Array<number | null>;
}

async function main(): Promise<void> {
  mkdirSync(CACHE_DIR, { recursive: true });

  // 交易日轴：用一只主板长期交易的票取日线日期（前复权不影响日期）
  const axisBars = await bars('600519');
  const axis = axisBars.map((b) => b.time);
  if (axis.length < DAYS + 5) throw new Error('交易日轴不足');
  // 信号日 D 需要 D-1（候选池）与 D+1..D+3（前向收益），末尾预留 3 天
  const signalDays = axis.slice(-(DAYS + 3), -3);
  console.log(`信号日 ${signalDays.length} 个：${signalDays[0]} ~ ${signalDays[signalDays.length - 1]}`);

  const rows: Row[] = [];
  const dayLog: string[] = [];

  for (const D of signalDays) {
    const di = axis.indexOf(D);
    const prev = axis[di - 1];

    // Gate：跌停家数 < 100 即可确定不 SKIP
    let dtCount = -1;
    try {
      const dt = (await callAkshare('stock_zt_pool_dtgc_em', { date: ymd(prev) })) as unknown[];
      dtCount = dt.length;
    } catch {
      dtCount = -1;
    }
    if (dtCount >= 100) {
      dayLog.push(`${D} 跳过：${prev} 跌停 ${dtCount} 家，Gate 的上涨家数占比无历史源，无法判定 SKIP`);
      continue;
    }

    // 候选池：D-1 涨停股（战法评分要用昨日连板/炸板/封板时间），限沪深纯主板、排除 ST
    let pool: Array<Record<string, unknown>> = [];
    try {
      pool = (await callAkshare('stock_zt_pool_em', { date: ymd(prev) })) as Array<Record<string, unknown>>;
    } catch {
      dayLog.push(`${D} 跳过：${prev} 涨停池取数失败`);
      continue;
    }
    const cands = pool
      .map((r) => ({
        code: String(r.代码 ?? ''),
        name: String(r.名称 ?? ''),
        boards: Number(r.连板数 ?? 0),
        breaks: Number(r.炸板次数 ?? 0),
        sealTime: String(r.首次封板时间 ?? ''),
      }))
      .filter((c) => /^(00|60)/.test(c.code) && !c.name.includes('ST'));

    // 用前复权日线算竞价涨幅，先筛 2%~9%（便宜），再决定谁值得花分笔请求
    const screened: Array<{
      code: string; name: string; boards: number; breaks: number; sealTime: string;
      openAdj: number; prevClose: number; pct: number; closesBefore: number[]; b: KlineBar[]; di: number;
    }> = [];
    for (const c of cands) {
      const b = await bars(c.code);
      const i = b.findIndex((x) => x.time === D);
      if (i < 1) continue;
      const openAdj = b[i].open;
      const prevClose = b[i - 1].close;
      if (!(openAdj > 0) || !(prevClose > 0)) continue;
      const pct = (openAdj / prevClose - 1) * 100;
      if (pct < PCT_MIN || pct > PCT_MAX) continue;
      screened.push({
        ...c,
        openAdj,
        prevClose,
        pct,
        closesBefore: b.slice(0, i).map((x) => x.close),
        b,
        di: i,
      });
    }
    // 战法评分里有「竞价涨幅靠近 6% 的形态分」，故按贴近 6% 优先花分笔预算
    screened.sort((a, b2) => Math.abs(a.pct - 6) - Math.abs(b2.pct - 6));
    const picked = screened.slice(0, MAX_TICKS);
    dayLog.push(
      `${D}：${prev} 涨停主板非ST ${cands.length} 只 → 竞价涨幅 ${PCT_MIN}~${PCT_MAX}% ${screened.length} 只 → 取分笔 ${picked.length} 只（${prev} 跌停 ${dtCount} 家，Gate 不 SKIP）`,
    );

    for (const c of picked) {
      const cur = await getTickInfo(c.code, D);
      if (!cur) continue;
      const amount = cur.auctionPrice * cur.auctionShares;
      if (amount < AMOUNT_MIN) continue;

      // 竞价倍率：需要前一交易日的竞价额（同源同法）
      const before = await getTickInfo(c.code, prev);
      const prevAmount = before ? before.auctionPrice * before.auctionShares : 0;
      const ratio = prevAmount > 0 ? amount / prevAmount : null;

      // 前向收益：基准=竞价价（复权口径 open），对照基准=9:30 后首价（按未复权比例折算）
      const entryAdj = c.openAdj;
      const realEntry =
        cur.firstAfterOpen && cur.auctionPrice > 0
          ? c.openAdj * (cur.firstAfterOpen / cur.auctionPrice)
          : null;
      const fwd: Array<number | null> = [];
      const fwdReal: Array<number | null> = [];
      for (const n of [1, 2, 3]) {
        const bar = c.b[c.di + n];
        fwd.push(bar ? (bar.close / entryAdj - 1) * 100 : null);
        fwdReal.push(bar && realEntry ? (bar.close / realEntry - 1) * 100 : null);
      }

      rows.push({
        date: D,
        code: c.code,
        name: c.name,
        auctionPct: c.pct,
        auctionAmountWan: amount / 1e4,
        auctionRatio: ratio,
        rsi6: rsi6(c.closesBefore, c.openAdj),
        prevBoards: c.boards,
        prevBreaks: c.breaks,
        prevSealTime: c.sealTime,
        slipPct:
          cur.firstAfterOpen && cur.auctionPrice > 0
            ? (cur.firstAfterOpen / cur.auctionPrice - 1) * 100
            : null,
        fwd,
        fwdReal,
      });
      await sleep(200); // 对新浪温和一点
    }
  }

  // ---- 落盘 ----
  const r2 = (v: number | null): string => (v == null ? '' : (Math.round(v * 100) / 100).toString());
  const header = [
    '信号日', '代码', '名称', '竞价涨幅%', '竞价额(万)', '竞价倍率', 'RSI6',
    '昨连板', '昨炸板', '昨首封时间', '开盘首价溢价%',
    'T+1%(竞价基准)', 'T+2%(竞价基准)', 'T+3%(竞价基准)',
    'T+1%(可成交基准)', 'T+2%(可成交基准)', 'T+3%(可成交基准)',
  ].join(',');
  const csv = [
    header,
    ...rows.map((r) =>
      [
        r.date, r.code, r.name, r2(r.auctionPct), r2(r.auctionAmountWan), r2(r.auctionRatio), r2(r.rsi6),
        r.prevBoards, r.prevBreaks, r.prevSealTime, r2(r.slipPct),
        ...r.fwd.map(r2), ...r.fwdReal.map(r2),
      ].join(','),
    ),
  ].join('\n');
  writeFileSync(join(OUT_DIR, 'candidates.csv'), `${csv}\n`, 'utf-8');

  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + 1);
  const md = [
    '# 竞价冠军 Top3 · 候选特征表（小样本点验证）',
    '',
    `- 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    `- 候选行数：${rows.length}；覆盖信号日：${byDay.size} 个`,
    `- 硬口径：沪深纯主板非 ST、竞价涨幅 ${PCT_MIN}~${PCT_MAX}%、竞价额 ≥ ${AMOUNT_MIN / 1e4} 万`,
    `- 候选来源：前一交易日涨停池（战法评分需昨日连板/炸板/封板时间），每日最多取 ${MAX_TICKS} 只分笔`,
    '',
    '## 取数口径',
    '',
    '- 竞价涨幅与前向收益用东财前复权日线（open 即 9:25 竞价成交价），复权因子一致。',
    '- 竞价成交额用新浪分笔当日首笔（09:25 撮合）价×量，真实资金额，不受复权影响。',
    '- 「可成交基准」= 分笔里 09:30 之后首笔价，按其相对竞价价的比例折算到复权基准，',
    '  用于检验战法自己提示的「不得把 9:25 竞价价当可成交价」这一乐观偏差。',
    '- Gate：SKIP 需「上涨家数占比 < 9%」且「跌停家数 ≥ 100」同时成立；上涨家数占比无历史源，',
    '  故只在跌停家数 < 100（可确定不 SKIP）的日子取样，跌停 ≥ 100 的日子直接剔除，不做猜测。',
    '- 未实现战法的打分公式：原文只给了竞价倍率加分数值（0/2/5/7），对数加分/形态分/聚类分/',
    '  炸板扣分的系数均缺失，故本表只产出打分所需的原始特征，Top-N 选取留作后处理。',
    '',
    '## 逐日取数日志',
    '',
    ...dayLog.map((l) => `- ${l}`),
    '',
  ].join('\n');
  writeFileSync(join(OUT_DIR, 'README.md'), md, 'utf-8');

  console.log(`\n候选 ${rows.length} 行 → ${join(OUT_DIR, 'candidates.csv')}`);
  for (const l of dayLog) console.log(' ', l);
}

main().catch((e) => {
  console.error('FAIL', e instanceof Error ? e.message : e);
  process.exit(1);
});
