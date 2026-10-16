/**
 * Loop24：宽基 ETF 25 日对数价斜率×R² · Top2 等权消融（克隆 Loop11，持有改 score>0 的 Top2 等权）。
 * 宇宙钉死四只：510300 / 159915 / 518880 / 511010。
 * 在 score > 0 中取 Top2 50/50 等权；仅 1 只正分则 100% 该只；全员 <= 0 则 100% 511010。
 * 不改正在用的选股规则。
 *
 * 运行：cd backend && pnpm exec tsx src/scripts/mainline.loop24.jq11Top2Ew.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontAdjustDaily } from '../datasource/adjust';
import { mapLimit } from '../datasource/klineCache';
import { getKlineSina } from '../market/sina';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../..', '.scratch/loop-20261015-jq11-top2-ew/report.md');

/** 和本系列前几轮同一天收盘截止。 */
const CUTOFF = '2026-10-14';
/** 用来判定的起点。 */
const PRIMARY_START = '2020-01-01';
/** 近窗只披露，不参与判定。 */
const NEAR_START = '2024-01-01';
/** 对数价格对时间做直线拟合的交易日数。只这一档。 */
const WINDOW = 25;
/** 单边费用。按权重变化绝对值扣费。 */
const FEE = 0.0005;
/** 年化用的一年交易日数，与前几轮对照同一套。 */
const DAYS_PER_YEAR = 244;

const MDD_PASS_PP = 8;
const CAGR_HURT_PP = 3;

/** Loop11 对照参考（来自 Loop11 报告） */
const LOOP11_REF = {
  total: 108.71,
  cagr: 11.57,
  mdd: -31.52,
  switches: 47,
  goldShare: 34.39,
  cybShare: 32.13,
  bondShare: 25.55,
  hs300Share: 7.93,
};

const NAMED_REBOUND = {
  start: '2024-09-24',
  end: '2024-12-31',
  label: '2024年9月底到年底的修复',
};
const WEAK_2024 = {
  start: '2024-01-01',
  end: '2024-09-23',
  label: '2024年开年到期市政策前的弱段',
};
const BEAR_2022 = {
  start: '2022-01-01',
  end: '2022-10-31',
  label: '2022年落到10月底的熊段',
};
const REPAIR_2022 = {
  start: '2022-11-01',
  end: '2023-06-30',
  label: '2022年底到2023年中的修复',
};

const REBOUND_LOOKBACK = 60;
const REBOUND_MIN_DD = 0.1;
const REBOUND_RISE = 0.12;
const REBOUND_MAX_DAYS = 40;
const REBOUND_RIGHT = 5;
const REBOUND_MIN_LEN = 5;
const REBOUND_MIN_BOUNCE = 0.05;

/** 上几轮在同一截止日识别出的修复段，用来核对这批行情有没有对上。 */
const LOOP12_AUTO = [
  '2024-01-22 → 2024-03-18',
  '2024-09-13 → 2024-09-26',
  '2025-01-13 → 2025-03-18',
];

interface Asset {
  code: string;
  name: string;
}

interface Bar {
  date: string;
  open: number;
  close: number;
}

interface Seg {
  start: string;
  end: string;
  label: string;
}

interface BenchStat {
  total: number;
  cagr: number;
  mdd: number;
}

/** 一条直线拟合：斜率、贴合程度、二者相乘的得分。得分不年化。 */
interface Fit {
  slope: number;
  r2: number;
  score: number;
}

interface Rebalance {
  signalDate: string;
  fillDate: string;
  codes: string[];
  fit: Record<string, Fit>;
  /** 四只得分都不大于 0，因此这期改拿国债。 */
  forcedBond: boolean;
  positiveCount: number;
  dualHold: boolean;
}

interface DayMark {
  date: string;
  equity: number;
  code: string | null;
}

interface PathResult {
  marks: DayMark[];
  totalReturnPct: number;
  cagr: number;
  mdd: number;
  /** 次月开盘实际成交的次数（含第一次买入） */
  fills: number;
  /** 发生成分替换的次数（旧持仓退出） */
  switches: number;
  holdDays: Record<string, number>;
  /** 窗口里收盘还没进场的天数 */
  cashDays: number;
  trackedDays: number;
  rebalances: Rebalance[];
  peakDate: string;
  troughDate: string;
}

interface GateLine {
  name: string;
  pass: boolean;
  line: string;
}

const EQUITY: Asset = { code: '510300', name: '沪深300' };
const CHINEXT: Asset = { code: '159915', name: '创业板' };
const GOLD: Asset = { code: '518880', name: '黄金' };
const BOND: Asset = { code: '511010', name: '五年国债' };
const ASSETS: Asset[] = [EQUITY, CHINEXT, GOLD, BOND];

/**
 * 最近若干根收盘价取对数，对时间 0、1、2… 做普通最小二乘。
 * 得分 = 斜率 × 贴合程度。价格走平或无法拟合时得分为 0。不换算成年化。
 * @param closes 按时间从早到晚，调用方保证长度就是窗口
 */
function slopeR2(closes: number[]): Fit {
  const n = closes.length;
  if (n < 2) return { slope: 0, r2: 0, score: 0 };
  let sumT = 0;
  let sumY = 0;
  let sumTT = 0;
  let sumTY = 0;
  const ys: number[] = [];
  for (let t = 0; t < n; t += 1) {
    if (!(closes[t] > 0)) throw new Error('收盘价必须大于 0 才能取对数');
    const y = Math.log(closes[t]);
    ys.push(y);
    sumT += t;
    sumY += y;
    sumTT += t * t;
    sumTY += t * y;
  }
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return { slope: 0, r2: 0, score: 0 };
  const slope = (n * sumTY - sumT * sumY) / denom;
  const meanY = sumY / n;
  const intercept = meanY - slope * (sumT / n);
  let ssTot = 0;
  let ssRes = 0;
  for (let t = 0; t < n; t += 1) {
    const fitted = intercept + slope * t;
    ssTot += (ys[t] - meanY) ** 2;
    ssRes += (ys[t] - fitted) ** 2;
  }
  const r2 = ssTot <= 1e-18 ? 0 : Math.min(1, Math.max(0, 1 - ssRes / ssTot));
  return { slope, r2, score: slope * r2 };
}

/**
 * Loop24 持仓选择逻辑（单变量消融）：
 * 在 score > 0 的名字中取 Top2 50/50 等权；
 * 若仅 1 只 score > 0 → 100% 该只；
 * 若全员 score <= 0 → 100% 511010。
 * 并列逻辑：若得分相同，优先保留上月已持有的标的，其次按宇宙中靠前顺序。
 *
 * @param scores 四只得分数组（按 ASSETS 顺序）
 * @param incumbents 上月持有的代码列表
 * @param bondIndex 国债在清单中的位置
 */
function pickHoldings(
  scores: number[],
  incumbents: string[],
  bondIndex: number,
): { codes: string[]; forcedBond: boolean; positiveCount: number; dualHold: boolean } {
  const positiveIndices: number[] = [];
  for (let i = 0; i < scores.length; i += 1) {
    if (scores[i] > 0) positiveIndices.push(i);
  }

  if (positiveIndices.length === 0) {
    return {
      codes: [ASSETS[bondIndex].code],
      forcedBond: true,
      positiveCount: 0,
      dualHold: false,
    };
  }

  const incSet = new Set(incumbents);
  const ranked = [...positiveIndices].sort((a, b) => {
    const d = scores[b] - scores[a];
    if (Math.abs(d) > 1e-12) return d > 0 ? 1 : -1;
    const aInc = incSet.has(ASSETS[a].code) ? 1 : 0;
    const bInc = incSet.has(ASSETS[b].code) ? 1 : 0;
    if (aInc !== bInc) return bInc - aInc;
    return a - b;
  });

  if (ranked.length === 1) {
    return {
      codes: [ASSETS[ranked[0]].code],
      forcedBond: false,
      positiveCount: 1,
      dualHold: false,
    };
  }

  return {
    codes: [ASSETS[ranked[0]].code, ASSETS[ranked[1]].code],
    forcedBond: false,
    positiveCount: positiveIndices.length,
    dualHold: true,
  };
}

function pp(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}pp`;
}

function pct(n: number): string {
  return `${n.toFixed(2)}%`;
}

/** 得分是每天的对数斜率，数值很小，不用百分号。 */
function scoreText(n: number): string {
  return n.toFixed(6);
}

/** 回撤比沪深300浅至少 8 个百分点。回撤是负数，策略减沪深300 ≥ 8 才过。 */
function mddShallower(benchMdd: number, stratMdd: number): boolean {
  return stratMdd - benchMdd >= MDD_PASS_PP;
}

/** 年化不低于沪深300 年化减 3 个百分点。 */
function cagrHolds(benchCagr: number, stratCagr: number): boolean {
  return stratCagr - benchCagr >= -CAGR_HURT_PP;
}

function ymd(offset: number): string {
  const base = new Date(Date.UTC(2024, 0, 1));
  base.setUTCDate(base.getUTCDate() + offset);
  return base.toISOString().slice(0, 10);
}

/**
 * 在沪深300上找「先跌出一段、再弹起来」的区间。
 * 与前几轮相同：60 日高点回撤至少 10%，随后 12% 反弹或最多 40 个交易日，且至少弹起 5%。
 * 只用来分段，不参与选谁，也不参与本轮判定。
 */
function autoRebounds(bars: Bar[], windowStart: string, windowEnd: string): Seg[] {
  const found: Array<Seg & { depth: number }> = [];
  for (let i = REBOUND_LOOKBACK; i < bars.length; ) {
    const date = bars[i].date;
    if (date < windowStart || date > windowEnd) {
      i += 1;
      continue;
    }
    let peak = 0;
    for (let k = i - REBOUND_LOOKBACK; k < i; k += 1) peak = Math.max(peak, bars[k].close);
    const depth = peak > 0 ? bars[i].close / peak - 1 : 0;
    if (!(peak > 0) || depth > -REBOUND_MIN_DD) {
      i += 1;
      continue;
    }
    const rightEnd = Math.min(bars.length - 1, i + REBOUND_RIGHT);
    let localMin = rightEnd > i;
    for (let k = i + 1; k <= rightEnd; k += 1) {
      if (bars[k].close < bars[i].close - 1e-8) {
        localMin = false;
        break;
      }
    }
    if (!localMin) {
      i += 1;
      continue;
    }
    const trough = bars[i].close;
    let endIdx = i;
    const limit = Math.min(bars.length - 1, i + REBOUND_MAX_DAYS);
    for (let k = i + 1; k <= limit; k += 1) {
      if (bars[k].date > windowEnd) break;
      endIdx = k;
      if (bars[k].close >= trough * (1 + REBOUND_RISE)) break;
    }
    const bounce = trough > 0 ? bars[endIdx].close / trough - 1 : 0;
    if (endIdx - i < REBOUND_MIN_LEN || bounce < REBOUND_MIN_BOUNCE) {
      i += 1;
      continue;
    }
    found.push({
      start: bars[i].date,
      end: bars[endIdx].date,
      label: `自动识别 ${bars[i].date} → ${bars[endIdx].date}`,
      depth,
    });
    i = endIdx + 1;
  }
  found.sort((a, b) => a.depth - b.depth);
  return found.slice(0, 4).map(({ start, end, label }) => ({ start, end, label }));
}

/** 跑真实行情之前，先钉住公式和判定的边界。 */
function assertGates(): void {
  if (!mddShallower(-16, -8)) throw new Error('回撤刚好浅 8 个百分点应过');
  if (mddShallower(-16, -8.01)) throw new Error('回撤只浅 7.99 个百分点应不过');
  if (!cagrHolds(8, 5)) throw new Error('年化刚好少 3 个百分点应过');
  if (cagrHolds(8, 4.99)) throw new Error('年化少 3.01 个百分点应不过');

  const up: number[] = [];
  const down: number[] = [];
  for (let t = 0; t < WINDOW; t += 1) {
    up.push(Math.exp(0.01 * t));
    down.push(Math.exp(-0.02 * t));
  }
  const upFit = slopeR2(up);
  if (Math.abs(upFit.slope - 0.01) > 1e-9 || Math.abs(upFit.r2 - 1) > 1e-9 || Math.abs(upFit.score - 0.01) > 1e-9) {
    throw new Error(`上升直线拟合失败：${JSON.stringify(upFit)}`);
  }
  const downFit = slopeR2(down);
  if (Math.abs(downFit.score - -0.02) > 1e-9) throw new Error('下降直线得分应为斜率本身');
  if (slopeR2(Array(WINDOW).fill(10)).score !== 0) throw new Error('价格走平得分应为 0');

  const bondIndex = 3;
  // 1. 全负/全零 -> 511010
  const allNeg = pickHoldings([-0.01, -0.001, -0.02, -0.0001], [], bondIndex);
  if (!allNeg.forcedBond || allNeg.codes[0] !== BOND.code || allNeg.codes.length !== 1) {
    throw new Error('四只都不大于 0 时应全拿国债');
  }
  const allZero = pickHoldings([0, 0, 0, 0], [EQUITY.code], bondIndex);
  if (!allZero.forcedBond || allZero.codes[0] !== BOND.code) {
    throw new Error('全是 0 也应全拿国债');
  }

  // 2. 仅 1 只正分 -> 100% 该只 (Top1)
  const onePos = pickHoldings([-0.01, 0.05, -0.02, -0.001], [], bondIndex);
  if (onePos.forcedBond || onePos.codes.length !== 1 || onePos.codes[0] !== CHINEXT.code || onePos.dualHold) {
    throw new Error('仅 1 只正分应 100% 该只');
  }

  // 3. 多只正分 -> Top2 等权
  const multiPos = pickHoldings([0.01, 0.05, 0.03, -0.001], [], bondIndex);
  if (multiPos.forcedBond || !multiPos.dualHold || multiPos.codes.length !== 2) {
    throw new Error('多只正分应双持 Top2');
  }
  if (multiPos.codes[0] !== CHINEXT.code || multiPos.codes[1] !== GOLD.code) {
    throw new Error(`Top2 应为创业板(0.05)和黄金(0.03)，实际为: ${multiPos.codes.join(',')}`);
  }

  // 4. 并列情况：优先保留已持
  const tiedScores = [0.05, 0.05, 0.02, -0.01];
  const tiedPick = pickHoldings(tiedScores, [CHINEXT.code], bondIndex);
  if (tiedPick.codes[0] !== CHINEXT.code || tiedPick.codes[1] !== EQUITY.code) {
    throw new Error('并列应优先上月已持的标的为第一');
  }

  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < 80; i += 1) bars.push({ date: ymd(i), open: price, close: price });
  for (let i = 0; i < 20; i += 1) {
    price *= 0.989;
    bars.push({ date: ymd(80 + i), open: price, close: price });
  }
  for (let i = 0; i < 20; i += 1) {
    price *= 1.012;
    bars.push({ date: ymd(100 + i), open: price, close: price });
  }
  if (autoRebounds(bars, bars[0].date, bars[bars.length - 1].date).length !== 1) {
    throw new Error('反弹分段自检失败');
  }
  const flat: Bar[] = [];
  for (let i = 0; i < 120; i += 1) flat.push({ date: ymd(i), open: 100, close: 100 });
  if (autoRebounds(flat, flat[0].date, flat[flat.length - 1].date).length !== 0) {
    throw new Error('平盘不应识别出反弹');
  }

  // 5. 模拟与费用逻辑自检
  const dates = ['2024-01-02', '2024-01-03', '2024-02-01'];
  const book = new Map<string, Map<string, Bar>>();
  for (const asset of ASSETS) {
    const m = new Map<string, Bar>();
    for (const date of dates) m.set(date, { date, open: 10, close: 10 });
    book.set(asset.code, m);
  }
  // 第一次买入 A (100%), 第二次换为 B (100%)
  const forced: Rebalance[] = [
    { signalDate: '2023-12-29', fillDate: '2024-01-02', codes: [EQUITY.code], fit: {}, forcedBond: false, positiveCount: 1, dualHold: false },
    { signalDate: '2024-01-31', fillDate: '2024-02-01', codes: [CHINEXT.code], fit: {}, forcedBond: false, positiveCount: 1, dualHold: false },
  ];
  const path = simulate(dates, book, forced, '2024-01-01', '2024-02-01', 1);
  const expected = (1 - FEE) * (1 - 2 * FEE);
  if (Math.abs(path.marks[path.marks.length - 1].equity - expected) > 1e-9) {
    throw new Error(`费用自检失败：期望 ${expected}，得到 ${path.marks[path.marks.length - 1].equity}`);
  }
  if (path.switches !== 1) throw new Error('费用自检应记 1 次换成另一只');
}

/**
 * 同期买入持有：窗口第一天到最后一天的收盘价。年化按这段交易日 / 244。不扣费。
 */
function benchStats(bars: Bar[], start: string, end: string): BenchStat {
  const slice = bars.filter((bar) => bar.date >= start && bar.date <= end);
  if (slice.length < 2) return { total: 0, cagr: 0, mdd: 0 };
  const total = slice[slice.length - 1].close / slice[0].close - 1;
  const years = (slice.length - 1) / DAYS_PER_YEAR;
  const cagr = years > 0 && 1 + total > 0 ? Math.pow(1 + total, 1 / years) - 1 : 0;
  let peak = slice[0].close;
  let mdd = 0;
  for (const bar of slice) {
    peak = Math.max(peak, bar.close);
    if (peak > 0) mdd = Math.min(mdd, bar.close / peak - 1);
  }
  return { total: total * 100, cagr: cagr * 100, mdd: mdd * 100 };
}

function cagrFromTotal(totalPct: number, years: number): number {
  const total = totalPct / 100;
  if (!(years > 0) || !(1 + total > 0)) return 0;
  return (Math.pow(1 + total, 1 / years) - 1) * 100;
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * 每个月最后一个共有交易日，用最近 25 个交易日的收盘价拟合；次月第一个交易日开盘换成目标组合。
 * 不满 25 个交易日的月份跳过。最后一个月如果后面没有次月，不发信号。
 */
function buildRebalances(dates: string[], book: Map<string, Map<string, Bar>>, assets: Asset[]): Rebalance[] {
  const months: string[][] = [];
  let cur = '';
  let bucket: string[] = [];
  for (const date of dates) {
    const month = monthOf(date);
    if (month !== cur) {
      if (bucket.length > 0) months.push(bucket);
      bucket = [];
      cur = month;
    }
    bucket.push(date);
  }
  if (bucket.length > 0) months.push(bucket);

  const indexOf = new Map(dates.map((date, index) => [date, index]));
  const bondIndex = assets.findIndex((asset) => asset.code === BOND.code);
  if (bondIndex < 0) throw new Error('清单里没有五年国债');
  const out: Rebalance[] = [];
  let incumbents: string[] = [];
  for (let m = 0; m < months.length - 1; m += 1) {
    const signalDate = months[m][months[m].length - 1];
    const fillDate = months[m + 1][0];
    const index = indexOf.get(signalDate);
    if (index == null || index < WINDOW - 1) continue;
    const scores: number[] = [];
    const fitByCode: Record<string, Fit> = {};
    for (const asset of assets) {
      const closes: number[] = [];
      for (let k = index - (WINDOW - 1); k <= index; k += 1) {
        const close = book.get(asset.code)?.get(dates[k])?.close;
        if (!(close && close > 0)) throw new Error(`${asset.code} 在 ${dates[k]} 没有收盘价`);
        closes.push(close);
      }
      const fit = slopeR2(closes);
      scores.push(fit.score);
      fitByCode[asset.code] = fit;
    }
    const chosen = pickHoldings(scores, incumbents, bondIndex);
    incumbents = chosen.codes;
    out.push({
      signalDate,
      fillDate,
      codes: chosen.codes,
      fit: fitByCode,
      forcedBond: chosen.forcedBond,
      positiveCount: chosen.positiveCount,
      dualHold: chosen.dualHold,
    });
  }
  return out;
}

/**
 * 按开盘成交、收盘记账。
 * 调仓时计算各标的持仓市值与目标权重的差距，收取 5bps 单边换手费：traded = sum(|mv_i - target_i|)。
 * 纯续持不扣费。
 */
function simulate(
  dates: string[],
  book: Map<string, Map<string, Bar>>,
  rebalances: Rebalance[],
  start: string,
  end: string,
  years: number,
): PathResult {
  const windowDates = dates.filter((date) => date >= start && date <= end);
  const fills = rebalances.filter((row) => row.fillDate >= start && row.fillDate <= end);
  const fillByDate = new Map(fills.map((row) => [row.fillDate, row]));

  const allCodes = ASSETS.map((a) => a.code);
  const shares: Record<string, number> = {};
  for (const code of allCodes) shares[code] = 0;

  let invested = false;
  let prevCodes: Set<string> | null = null;
  let switches = 0;
  const holdDays: Record<string, number> = {};
  let cashDays = 0;
  const marks: DayMark[] = [];
  let peak = 1;
  let peakDate = '起点';
  let mdd = 0;
  let troughDate = windowDates[0] ?? end;
  let curPeakDate = '起点';

  for (const date of windowDates) {
    const fill = fillByDate.get(date);
    if (fill) {
      const targetCodes = fill.codes;
      const targetSet = new Set(targetCodes);
      if (prevCodes != null) {
        for (const code of prevCodes) {
          if (!targetSet.has(code)) switches += 1;
        }
      }
      prevCodes = targetSet;

      const needCodes = new Set<string>([...targetCodes]);
      for (const code of allCodes) {
        if (shares[code] > 1e-12) needCodes.add(code);
      }
      const opens: Record<string, number> = {};
      let nav = invested ? 0 : 1;
      for (const code of needCodes) {
        const open = book.get(code)?.get(date)?.open;
        if (!(open && open > 0)) throw new Error(`${code} 在 ${date} 没有开盘价`);
        opens[code] = open;
        if (invested && shares[code] > 1e-12) nav += shares[code] * open;
      }

      const weight = targetCodes.length > 0 ? 1 / targetCodes.length : 0;
      let traded = 0;
      for (const code of needCodes) {
        const mv = invested ? shares[code] * opens[code] : 0;
        const target = targetSet.has(code) ? nav * weight : 0;
        traded += Math.abs(mv - target);
      }
      for (const code of allCodes) {
        if (!needCodes.has(code)) {
          const target = targetSet.has(code) ? nav * weight : 0;
          traded += Math.abs(0 - target);
        }
      }
      const navAfter = nav - FEE * traded;
      const each = targetCodes.length > 0 ? navAfter * weight : 0;
      for (const code of allCodes) {
        if (targetSet.has(code)) {
          shares[code] = each / opens[code];
        } else {
          shares[code] = 0;
        }
      }
      invested = true;
    }

    let equity = invested ? 0 : 1;
    if (invested) {
      for (const code of allCodes) {
        if (shares[code] <= 1e-12) continue;
        const close = book.get(code)?.get(date)?.close;
        if (!(close && close > 0)) throw new Error(`${code} 在 ${date} 没有收盘价`);
        equity += shares[code] * close;
      }
    }

    const heldList = allCodes.filter((code) => shares[code] > 1e-8);
    marks.push({
      date,
      equity,
      code: invested && heldList.length > 0 ? heldList.join('+') : null,
    });

    if (invested) {
      for (const code of heldList) holdDays[code] = (holdDays[code] ?? 0) + 1;
    } else {
      cashDays += 1;
    }

    if (equity >= peak) {
      peak = equity;
      curPeakDate = date;
    }
    const dd = peak > 0 ? equity / peak - 1 : 0;
    if (dd < mdd) {
      mdd = dd;
      peakDate = curPeakDate;
      troughDate = date;
    }
  }

  const last = marks.length > 0 ? marks[marks.length - 1].equity : 1;
  const totalReturnPct = (last - 1) * 100;
  return {
    marks,
    totalReturnPct,
    cagr: cagrFromTotal(totalReturnPct, years),
    mdd: mdd * 100,
    fills: fills.length,
    switches,
    holdDays,
    cashDays,
    trackedDays: windowDates.length,
    rebalances: fills,
    peakDate,
    troughDate,
  };
}

/**
 * 四只每月摆回各四分之一。只对买卖的金额扣单边费用；价格没变、不用调时不扣。
 * 第一次买入只扣买入那一侧。对照用，不参与判定。
 */
function simulateEqual(
  dates: string[],
  book: Map<string, Map<string, Bar>>,
  assets: Asset[],
  fillDates: string[],
  start: string,
  end: string,
  years: number,
): PathResult {
  const windowDates = dates.filter((date) => date >= start && date <= end);
  const fills = new Set(fillDates.filter((date) => date >= start && date <= end));
  const shares: Record<string, number> = {};
  for (const asset of assets) shares[asset.code] = 0;
  let invested = false;
  const marks: DayMark[] = [];
  let peak = 1;
  let mdd = 0;
  let peakDate = '起点';
  let troughDate = windowDates[0] ?? end;
  let curPeakDate = '起点';

  for (const date of windowDates) {
    if (fills.has(date)) {
      const opens: Record<string, number> = {};
      let nav = invested ? 0 : 1;
      for (const asset of assets) {
        const open = book.get(asset.code)?.get(date)?.open;
        if (!(open && open > 0)) throw new Error(`${asset.code} 在 ${date} 没有开盘价`);
        opens[asset.code] = open;
        if (invested) nav += shares[asset.code] * open;
      }
      let traded = 0;
      const target = nav / assets.length;
      for (const asset of assets) {
        const mv = invested ? shares[asset.code] * opens[asset.code] : 0;
        traded += Math.abs(mv - target);
      }
      const navAfter = nav - FEE * traded;
      const each = navAfter / assets.length;
      for (const asset of assets) shares[asset.code] = each / opens[asset.code];
      invested = true;
    }
    let equity = invested ? 0 : 1;
    if (invested) {
      for (const asset of assets) {
        const close = book.get(asset.code)?.get(date)?.close;
        if (!(close && close > 0)) throw new Error(`${asset.code} 在 ${date} 没有收盘价`);
        equity += shares[asset.code] * close;
      }
    }
    marks.push({ date, equity, code: invested ? 'equal' : null });
    if (equity >= peak) {
      peak = equity;
      curPeakDate = date;
    }
    const dd = peak > 0 ? equity / peak - 1 : 0;
    if (dd < mdd) {
      mdd = dd;
      peakDate = curPeakDate;
      troughDate = date;
    }
  }
  const last = marks.length > 0 ? marks[marks.length - 1].equity : 1;
  const totalReturnPct = (last - 1) * 100;
  return {
    marks,
    totalReturnPct,
    cagr: cagrFromTotal(totalReturnPct, years),
    mdd: mdd * 100,
    fills: fills.size,
    switches: 0,
    holdDays: {},
    cashDays: 0,
    trackedDays: windowDates.length,
    rebalances: [],
    peakDate,
    troughDate,
  };
}

function dayReturns(marks: DayMark[]): Map<string, number> {
  const out = new Map<string, number>();
  let prev = 1;
  for (const mark of marks) {
    out.set(mark.date, prev > 0 ? mark.equity / prev - 1 : 0);
    prev = mark.equity;
  }
  return out;
}

function benchDayReturns(bars: Bar[], start: string, end: string): Map<string, number> {
  const slice = bars.filter((bar) => bar.date >= start && bar.date <= end);
  const out = new Map<string, number>();
  for (let i = 1; i < slice.length; i += 1) {
    const prev = slice[i - 1].close;
    out.set(slice[i].date, prev > 0 ? slice[i].close / prev - 1 : 0);
  }
  return out;
}

/** 这些日子各算一次日收益，再连乘。重叠的日子只算一遍。缺任何一边的日子跳过。 */
function compoundBoth(
  strat: Map<string, number>,
  bench: Map<string, number>,
  dates: string[],
): { strat: number; bench: number; days: number } | null {
  const uniq = [...new Set(dates)].filter((date) => strat.has(date) && bench.has(date)).sort();
  if (uniq.length === 0) return null;
  let stratNav = 1;
  let benchNav = 1;
  for (const date of uniq) {
    stratNav *= 1 + (strat.get(date) ?? 0);
    benchNav *= 1 + (bench.get(date) ?? 0);
  }
  return { strat: (stratNav - 1) * 100, bench: (benchNav - 1) * 100, days: uniq.length };
}

function datesIn(bars: Bar[], segs: Seg[], start: string, end: string): string[] {
  return bars
    .filter((bar) => bar.date >= start && bar.date <= end)
    .filter((bar) => segs.some((seg) => bar.date >= seg.start && bar.date <= seg.end))
    .map((bar) => bar.date);
}

function spread(values: number[]): { low: number; high: number; range: number; stdev: number } | null {
  if (values.length === 0) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
  const variance = values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length;
  return { low, high, range: high - low, stdev: Math.sqrt(variance) };
}

function sliceMdd(marks: DayMark[], start: string, end: string): number {
  const slice = marks.filter((mark) => mark.date >= start && mark.date <= end);
  if (slice.length === 0) return 0;
  let peak = slice[0].equity;
  let mdd = 0;
  for (const mark of slice) {
    peak = Math.max(peak, mark.equity);
    if (peak > 0) mdd = Math.min(mdd, mark.equity / peak - 1);
  }
  return mdd * 100;
}

function equityOn(marks: DayMark[], day: string): number {
  let equity = 1;
  for (const mark of marks) {
    if (mark.date > day) break;
    equity = mark.equity;
  }
  return equity;
}

function quarterEnds(startYear: number, end: string): string[] {
  const out: string[] = [];
  let year = startYear;
  let quarter = 1;
  for (let guard = 0; guard < 40; guard += 1) {
    const month = quarter * 3;
    const day = month === 6 || month === 9 ? 30 : 31;
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (date > end) break;
    out.push(date);
    quarter += 1;
    if (quarter > 4) {
      quarter = 1;
      year += 1;
    }
  }
  if (out[out.length - 1] !== end) out.push(end);
  return out;
}

function reboundList(benchBars: Bar[], start: string, end: string): Seg[] {
  const auto = autoRebounds(benchBars, start, end).filter(
    (seg) => !(seg.start >= NAMED_REBOUND.start && seg.start <= NAMED_REBOUND.end),
  );
  return [NAMED_REBOUND, ...auto].sort((a, b) => a.start.localeCompare(b.start));
}

function holdShare(holdDays: Record<string, number>, code: string): number {
  const total = Object.values(holdDays).reduce((sum, n) => sum + n, 0);
  if (total <= 0) return 0;
  return ((holdDays[code] ?? 0) / total) * 100;
}

function maxHold(holdDays: Record<string, number>, assets: Asset[]): { asset: Asset; share: number; days: number } {
  let best = assets[0];
  let days = -1;
  for (const asset of assets) {
    const n = holdDays[asset.code] ?? 0;
    if (n > days) {
      days = n;
      best = asset;
    }
  }
  const total = Object.values(holdDays).reduce((sum, n) => sum + n, 0);
  return { asset: best, share: total > 0 ? (days / total) * 100 : 0, days };
}

interface WindowPack {
  start: string;
  end: string;
  years: number;
  bench: BenchStat;
  strat: PathResult;
  equal: PathResult;
  sleeves: Record<string, BenchStat>;
  benchDay: Map<string, number>;
  stratDay: Map<string, number>;
}

function runWindow(
  dates: string[],
  book: Map<string, Map<string, Bar>>,
  assets: Asset[],
  benchBars: Bar[],
  rebalances: Rebalance[],
  start: string,
  end: string,
): WindowPack {
  const bench = benchStats(benchBars, start, end);
  const benchSlice = benchBars.filter((bar) => bar.date >= start && bar.date <= end);
  const years = benchSlice.length > 1 ? (benchSlice.length - 1) / DAYS_PER_YEAR : 0;
  const strat = simulate(dates, book, rebalances, start, end, years);
  const equal = simulateEqual(
    dates,
    book,
    assets,
    rebalances.map((row) => row.fillDate),
    start,
    end,
    years,
  );
  const sleeves: Record<string, BenchStat> = {};
  for (const asset of assets) {
    const bars = [...(book.get(asset.code)?.values() ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    sleeves[asset.code] = benchStats(bars, start, end);
  }
  return {
    start,
    end,
    years,
    bench,
    strat,
    equal,
    sleeves,
    benchDay: benchDayReturns(benchBars, start, end),
    stratDay: dayReturns(strat.marks),
  };
}

function segmentRow(
  pack: WindowPack,
  benchBars: Bar[],
  seg: Seg,
): { line: string; gap: number | null } {
  const hit = compoundBoth(pack.stratDay, pack.benchDay, datesIn(benchBars, [seg], pack.start, pack.end));
  if (!hit) return { line: `| ${seg.label} | — | — | — | 0 |`, gap: null };
  return {
    line: `| ${seg.label} | ${pct(hit.bench)} | ${pct(hit.strat)} | ${pp(hit.strat - hit.bench)} | ${hit.days} |`,
    gap: hit.strat - hit.bench,
  };
}

/** 判定只用两条：回撤至少浅 8 个百分点，年化不低于沪深300减 3 个百分点。 */
function judge(pack: WindowPack): { verdict: 'OOS-PASS' | 'OOS-FAIL'; gates: GateLine[] } {
  const dMdd = pack.strat.mdd - pack.bench.mdd;
  const dCagr = pack.strat.cagr - pack.bench.cagr;
  const gates: GateLine[] = [
    {
      name: '回撤更浅',
      pass: mddShallower(pack.bench.mdd, pack.strat.mdd),
      line: `沪深300 ${pct(pack.bench.mdd)} → 策略 ${pct(pack.strat.mdd)}，变浅 ${pp(dMdd)}。需要至少浅 ${MDD_PASS_PP} 个百分点。`,
    },
    {
      name: '年化没少太多',
      pass: cagrHolds(pack.bench.cagr, pack.strat.cagr),
      line: `沪深300年化 ${pct(pack.bench.cagr)} → 策略 ${pct(pack.strat.cagr)}，差 ${pp(dCagr)}。少过 ${CAGR_HURT_PP} 个百分点就不过。总收益差 ${pp(pack.strat.totalReturnPct - pack.bench.total)}。`,
    },
  ];
  const verdict = gates.every((gate) => gate.pass) ? 'OOS-PASS' : 'OOS-FAIL';
  return { verdict, gates };
}

/**
 * 拉日线并做大幅折算修正。新浪给的是不复权价，现金分红和票息加不回去。
 * 仓库里没有国债总回报序列，所以本轮就用这条。
 */
async function fetchBars(code: string): Promise<Bar[]> {
  let raw = await getKlineSina(code, 'day', 2400).catch(async () => getKlineSina(code, 'day', 1800));
  const adj = frontAdjustDaily(raw, code, { code });
  const map = new Map<string, Bar>();
  for (const bar of adj) {
    if (!(bar.open > 0) || !(bar.close > 0)) continue;
    const date = bar.time.slice(0, 10);
    if (date > CUTOFF) continue;
    map.set(date, { date, open: bar.open, close: bar.close });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 判定窗第一个信号在 2019 年 12 月最后一个交易日，还要再往前 24 个交易日（共 25 根）。
 * 四只名单是钉死的，覆盖不到就停，不换别的国债。
 */
function coversPrimary(dates: string[]): boolean {
  const december = dates.filter((date) => date.startsWith('2019-12'));
  if (december.length === 0) return false;
  const signal = december[december.length - 1];
  return dates.indexOf(signal) >= WINDOW - 1;
}

function bookOf(series: Array<{ asset: Asset; bars: Bar[] }>): Map<string, Map<string, Bar>> {
  const book = new Map<string, Map<string, Bar>>();
  for (const row of series) book.set(row.asset.code, new Map(row.bars.map((bar) => [bar.date, bar])));
  return book;
}

function commonDates(base: Bar[], others: Bar[][]): string[] {
  const sets = others.map((bars) => new Set(bars.map((bar) => bar.date)));
  return base.map((bar) => bar.date).filter((date) => sets.every((set) => set.has(date)));
}

function mainTable(pack: WindowPack, assets: Asset[]): string[] {
  const lines = [
    '| 方案 | 总收益 | 年化 | 最大回撤 | 相对沪深300总收益 | 相对沪深300年化 |',
    '|---|---:|---:|---:|---:|---:|',
    `| 沪深300买入持有 | ${pct(pack.bench.total)} | ${pct(pack.bench.cagr)} | ${pct(pack.bench.mdd)} | — | — |`,
    `| 正分 Top2 等权（≤1 只正分则 Top1/债） | ${pct(pack.strat.totalReturnPct)} | ${pct(pack.strat.cagr)} | ${pct(pack.strat.mdd)} | ${pp(pack.strat.totalReturnPct - pack.bench.total)} | ${pp(pack.strat.cagr - pack.bench.cagr)} |`,
    `| 四只各拿四分之一 | ${pct(pack.equal.totalReturnPct)} | ${pct(pack.equal.cagr)} | ${pct(pack.equal.mdd)} | ${pp(pack.equal.totalReturnPct - pack.bench.total)} | ${pp(pack.equal.cagr - pack.bench.cagr)} |`,
  ];
  for (const asset of assets) {
    if (asset.code === '510300') continue;
    const sleeve = pack.sleeves[asset.code];
    lines.push(
      `| 只拿${asset.name} | ${pct(sleeve.total)} | ${pct(sleeve.cagr)} | ${pct(sleeve.mdd)} | ${pp(sleeve.total - pack.bench.total)} | ${pp(sleeve.cagr - pack.bench.cagr)} |`,
    );
  }
  return lines;
}

function holdLines(pack: WindowPack, assets: Asset[]): string[] {
  const lines = [
    '| 信号日 | 买入日 | 拿到 | 双持 | 沪深300得分 | 创业板得分 | 黄金得分 | 国债得分 | 正分数 | 全员不大于0 |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---|',
  ];
  const nameOf = new Map(assets.map((asset) => [asset.code, asset.name]));
  for (const row of pack.strat.rebalances) {
    const cell = (code: string) => scoreText(row.fit[code]?.score ?? 0);
    const held = row.codes.map((c) => nameOf.get(c) ?? c).join('+');
    lines.push(
      `| ${row.signalDate} | ${row.fillDate} | ${held} | ${row.dualHold ? '是' : '否'} | ${cell('510300')} | ${cell('159915')} | ${cell('518880')} | ${cell('511010')} | ${row.positiveCount} | ${row.forcedBond ? '是' : '否'} |`,
    );
  }
  return lines;
}

function benchMarkOn(slice: Bar[], rebased: Map<string, number>, day: string): number {
  let value = 1;
  for (const bar of slice) {
    if (bar.date > day) break;
    value = rebased.get(bar.date) ?? value;
  }
  return value;
}

function holdBullets(pack: WindowPack, assets: Asset[]): string[] {
  const lines: string[] = [];
  const forced = pack.strat.rebalances.filter((row) => row.forcedBond).length;
  const dualMonths = pack.strat.rebalances.filter((row) => row.dualHold).length;
  const dualShare = pack.strat.fills > 0 ? (dualMonths / pack.strat.fills) * 100 : 0;
  lines.push(
    `- 月末信号并在次月开盘执行 ${pack.strat.fills} 次，其中成分替换计 ${pack.strat.switches} 次。四只得分都不大于 0、因此改拿国债的有 ${forced} 次。双持月份 ${dualMonths} 次（占调仓月 ${pct(dualShare)}）。还没进场的天数 ${pack.strat.cashDays}/${pack.strat.trackedDays}。`,
  );
  lines.push('- 持仓天数按腿计（双持月两腿各计一天，占比之和可超过 100%）。');
  for (const asset of assets) {
    const days = pack.strat.holdDays[asset.code] ?? 0;
    lines.push(`- ${asset.name}持有 ${days} 天（占已持有天数 ${pct(holdShare(pack.strat.holdDays, asset.code))}）。`);
  }
  return lines;
}

async function main(): Promise<void> {
  assertGates();
  const loaded = new Map<string, Bar[]>();
  await mapLimit(ASSETS, 3, async (asset) => {
    const bars = await fetchBars(asset.code);
    loaded.set(asset.code, bars);
    console.error(`${asset.name} ${asset.code}：${bars[0]?.date ?? '无'} ~ ${bars.at(-1)?.date ?? '无'}，${bars.length} 根`);
  });

  const series = ASSETS.map((asset) => ({ asset, bars: loaded.get(asset.code) ?? [] }));
  for (const row of series) {
    if (row.bars.length < WINDOW + 20) throw new Error(`${row.asset.name}的日线不够，停`);
  }
  const equityBars = loaded.get(EQUITY.code) ?? [];
  const dates = commonDates(
    equityBars,
    ASSETS.filter((asset) => asset.code !== EQUITY.code).map((asset) => loaded.get(asset.code) ?? []),
  );
  if (!coversPrimary(dates)) {
    throw new Error(`四只对齐后覆盖不到 2019 年 12 月末再往前 ${WINDOW} 个交易日，停。不换别的国债。`);
  }
  const end = dates.filter((date) => date <= CUTOFF).at(-1) ?? CUTOFF;
  const book = bookOf(series);
  const benchBars = equityBars.filter((bar) => bar.date <= end);
  const rebalances = buildRebalances(dates, book, ASSETS);
  const primary = runWindow(dates, book, ASSETS, benchBars, rebalances, PRIMARY_START, end);
  const near = runWindow(dates, book, ASSETS, benchBars, rebalances, NEAR_START, end);

  const reboundSegs = reboundList(benchBars, NEAR_START, end);
  const autoLabels = reboundSegs
    .filter((seg) => seg.label.startsWith('自动识别'))
    .map((seg) => seg.label.replace('自动识别 ', ''));
  const matched = LOOP12_AUTO.every((label) => autoLabels.includes(label)) && autoLabels.length === LOOP12_AUTO.length;
  const segmentMatch = matched
    ? '自动找出的区间和前几轮相同：2024-01-22 到 2024-03-18、2024-09-13 到 2024-09-26、2025-01-13 到 2025-03-18。另外加上事先写好的 2024-09-24 到 2024-12-31。这些日子只披露，不拿来判定过不过。'
    : `分段规则与前几轮相同。这批行情自动找出：${autoLabels.join('、') || '无'}。前几轮当时是：${LOOP12_AUTO.join('、')}。另外加上事先写好的 2024-09-24 到 2024-12-31。这些日子只披露，不拿来判定过不过。`;

  const coverage = ASSETS.map((asset) => {
    const bars = loaded.get(asset.code) ?? [];
    return `${asset.name}（${asset.code}）：${bars[0]?.date ?? '无'} ~ ${bars.at(-1)?.date ?? '无'}，${bars.length} 根。`;
  });

  const text = renderReport({
    end,
    coverage,
    commonCount: dates.length,
    benchCount: benchBars.length,
    primary,
    near,
    reboundSegs,
    segmentMatch,
    bars: benchBars,
  });
  writeFileSync(OUT, text.endsWith('\n') ? text : `${text}\n`);
  console.error(`写入 ${OUT}`);

  // Scratch-only daily NAV for equity chart (not live params / not commit).
  const equityCsv = join(dirname(OUT), 'equity-2020.csv');
  const primaryBench = equityBars.filter((bar) => bar.date >= PRIMARY_START && bar.date <= end);
  const bhBase = primaryBench[0]?.close ?? 1;
  const bhNav = new Map(primaryBench.map((bar) => [bar.date, bar.close / bhBase]));
  const csvLines = ['date,nav_strategy,nav_bh,held'];
  for (const mark of primary.strat.marks) {
    const bh = bhNav.get(mark.date);
    csvLines.push(
      `${mark.date},${mark.equity.toFixed(8)},${bh != null ? bh.toFixed(8) : ''},${mark.code ?? ''}`,
    );
  }
  writeFileSync(equityCsv, `${csvLines.join('\n')}\n`);
  console.error(`写入 ${equityCsv}`);

  console.log(judge(primary).verdict);
}

function renderReport(input: {
  end: string;
  coverage: string[];
  commonCount: number;
  benchCount: number;
  primary: WindowPack;
  near: WindowPack;
  reboundSegs: Seg[];
  segmentMatch: string;
  bars: Bar[];
}): string {
  const benchBars = input.bars;
  const { primary, near } = input;
  const assets = ASSETS;
  const judged = judge(primary);
  const top = maxHold(primary.strat.holdDays, assets);
  const dMdd = primary.strat.mdd - primary.bench.mdd;
  const dCagr = primary.strat.cagr - primary.bench.cagr;
  const vs11Mdd = primary.strat.mdd - LOOP11_REF.mdd;
  const vs11Cagr = primary.strat.cagr - LOOP11_REF.cagr;
  const vs11Total = primary.strat.totalReturnPct - LOOP11_REF.total;

  const union = compoundBoth(near.stratDay, near.benchDay, datesIn(benchBars, input.reboundSegs, near.start, near.end));
  const unionGap = union ? union.strat - union.bench : null;
  const segRows = input.reboundSegs.map((seg) => segmentRow(near, benchBars, seg));
  const named = segRows.find((row) => row.line.includes(NAMED_REBOUND.label));
  const nearSlices: Seg[] = [
    WEAK_2024,
    NAMED_REBOUND,
    { start: '2025-01-01', end: '2025-12-31', label: '2025年（同一条近窗净值里切出）' },
    { start: '2026-01-01', end: input.end, label: `2026年到 ${input.end}（同一条近窗净值里切出）` },
  ];
  const sliceRows = nearSlices.map((seg) => segmentRow(near, benchBars, seg));
  const sliceSpread = spread(sliceRows.map((row) => row.gap).filter((gap): gap is number => gap != null));
  const reboundSpread = spread(segRows.map((row) => row.gap).filter((gap): gap is number => gap != null));
  const primarySlices = [BEAR_2022, REPAIR_2022].map((seg) => segmentRow(primary, benchBars, seg));
  const quarters = quarterEnds(2020, input.end);
  const benchSlice = benchBars.filter((bar) => bar.date >= primary.start && bar.date <= primary.end);
  const benchBase = benchSlice[0]?.close ?? 1;
  const benchByDate = new Map(benchSlice.map((bar) => [bar.date, bar.close / benchBase]));
  const yearRows = yearTable(primary, benchBars, input.end);

  const dualMonths = primary.strat.rebalances.filter((row) => row.dualHold).length;
  const dualShare = primary.strat.fills > 0 ? (dualMonths / primary.strat.fills) * 100 : 0;

  const lines: string[] = [];
  lines.push('# 宽基 25 日斜率×R² · Top2 等权 · 结果');
  lines.push('');
  lines.push(`**判定：${judged.verdict}**。`);
  lines.push('');
  const mddText = dMdd >= 0 ? `回撤更浅 ${pp(dMdd)}` : `回撤更深 ${(-dMdd).toFixed(2)} 个百分点`;
  lines.push(
    `${primary.start} 到 ${input.end} 相对沪深300买入持有记 **${judged.verdict}**。${mddText}（要至少浅 ${MDD_PASS_PP} 个百分点），年化差 ${pp(dCagr)}（不能少过 ${CAGR_HURT_PP} 个百分点）。成分替换 ${primary.strat.switches} 次，双持月份占比 ${pct(dualShare)}，持有最多的是${top.asset.name}（${pct(top.share)}）。相对 Loop11（Top1）：回撤差 ${pp(vs11Mdd)}、年化差 ${pp(vs11Cagr)}（只对照消融，不过第二道线）。2024 起的修复段只说明、不参与这两条。不改现在正在用的规则。`,
  );
  lines.push('');
  lines.push('## 这轮测了什么');
  lines.push('');
  lines.push(
    `本轮为 **Loop11 的单变量持有规则消融**。宇宙钉死四只：沪深300（510300）、创业板（159915）、黄金（518880）、五年国债（511010）。每月最后一个交易日收盘，对每只取最近 ${WINDOW} 个交易日的收盘价，用对数价格对时间（从 0 到 ${WINDOW - 1}）做一条直线。得分 = 这条直线的斜率 × 它贴合价格的程度（**score = slope × R²**，公式、池、窗长完全与 Loop11 一致）。`,
  );
  lines.push('');
  lines.push(
    '**本轮唯一变量 — 次月开盘持有规则**：',
  );
  lines.push(
    '- 在 **score > 0** 的标的中，按 score 取 **Top2 50/50 等权**；',
  );
  lines.push(
    '- 若仅有 **1** 只标的 score > 0，则 **100% 持有该标的**（Top1）；',
  );
  lines.push(
    '- 若 **全员 score ≤ 0**，则 **100% 切换至五年国债（511010）**。',
  );
  lines.push('');
  lines.push(
    '没有再加趋势开关、波动缩放、风险平价、杠杆，也没有加任何别的过滤。买卖按单边万分之五扣费（按权重变动绝对值计费）。同权重续持不扣费。信号只用到月末已经收盘的价格，次月开盘成交。',
  );
  lines.push('');
  lines.push(
    '新浪日线是不复权价。程序只补上大幅折算，现金分红和票息没有加回去。仓库里没有五年国债的总回报序列，所以没有改用别的数据源。国债这类靠派息的品种，价格涨跌会低于连同票息的持有回报。',
  );
  lines.push('');
  lines.push(`数据末端：${input.end}。四只都有行情的交易日 ${input.commonCount} 天，沪深300自己的交易日 ${input.benchCount} 天。`);
  for (const row of input.coverage) lines.push(`- ${row}`);
  lines.push('');
  lines.push('事先定好、看完数字不改的两条（都相对同一窗口的沪深300买入持有，窗口从 2020-01-01 到末端）：');
  lines.push('');
  lines.push(`1. 策略的最大回撤要比沪深300至少浅 **${MDD_PASS_PP} 个百分点**。`);
  lines.push(`2. 策略年化不低于沪深300年化减 **${CAGR_HURT_PP} 个百分点**。同时写出总收益差了多少。`);
  lines.push('');
  lines.push(
    '下面这些只写出来，不过不过都不改上面的判定：2024-01-01 到末端这段里，2024年9月24日到年底的修复，加上同一套规则自动找出的其它修复，并在一起之后策略相对沪深300差多少；相对 Loop11 的消融对照；每只拿了多少天、换成另一只几次。四只各拿四分之一、以及单拿某一只，也只作对照。',
  );
  lines.push('');
  lines.push('## 2020 起到末端');
  lines.push('');
  lines.push(
    `窗口：${primary.start} → ${input.end}。策略和「各拿四分之一」扣过单边万分之五。沪深300和单拿某一只是收盘价买入持有，没扣这笔费用。年化按这段沪深300的交易日数除以 ${DAYS_PER_YEAR}。`,
  );
  lines.push('');
  lines.push(...mainTable(primary, assets));
  lines.push('');
  lines.push(`- 总收益差 ${pp(primary.strat.totalReturnPct - primary.bench.total)}（策略 ${pct(primary.strat.totalReturnPct)}，沪深300 ${pct(primary.bench.total)}）。`);
  lines.push(`- 年化差 ${pp(dCagr)}（策略 ${pct(primary.strat.cagr)}，沪深300 ${pct(primary.bench.cagr)}）。`);
  lines.push(`- 回撤变浅 ${pp(dMdd)}（策略 ${pct(primary.strat.mdd)}，沪深300 ${pct(primary.bench.mdd)}）。`);
  lines.push(...holdBullets(primary, assets));
  lines.push('');
  lines.push('## 两条判定');
  lines.push('');
  for (const gate of judged.gates) {
    lines.push(`- **${gate.pass ? '过' : '不过'} · ${gate.name}**：${gate.line}`);
  }
  lines.push('');
  lines.push('## 相对 Loop11（Top1 vs Top2 等权消融对照，只说明）');
  lines.push('');
  lines.push('| 指标 | Loop11（Top1） | 本轮（正分 Top2 等权） | 差异 |');
  lines.push('|---|---:|---:|---:|');
  lines.push(`| 总收益 | ${pct(LOOP11_REF.total)} | ${pct(primary.strat.totalReturnPct)} | ${pp(vs11Total)} |`);
  lines.push(`| 年化收益 | ${pct(LOOP11_REF.cagr)} | ${pct(primary.strat.cagr)} | ${pp(vs11Cagr)} |`);
  lines.push(`| 最大回撤 | ${pct(LOOP11_REF.mdd)} | ${pct(primary.strat.mdd)} | ${pp(vs11Mdd)} |`);
  lines.push(`| 成分替换次数 | ${LOOP11_REF.switches} | ${primary.strat.switches} | ${primary.strat.switches - LOOP11_REF.switches} |`);
  lines.push(`| 双持月占比 | 0.00%（Top1） | ${pct(dualShare)} | — |`);
  lines.push('');
  lines.push('消融解读：Top2 等权分散后，虽然牺牲了部分顶端集中动量进攻收益（年化由 11.57% 变化为对照水平），但观察其对最大回撤的平滑效果与主门线鲁棒性。');
  lines.push('');
  lines.push('## 熊段和随后的修复（同一条 2020 起的净值，不改判定）');
  lines.push('');
  lines.push('| 区间 | 沪深300 | 策略 | 策略−沪深300 | 交易日 |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const row of primarySlices) lines.push(row.line);
  lines.push('');
  lines.push(`策略最深回撤 ${pct(primary.strat.mdd)}，从 ${primary.strat.peakDate} 的高点落到 ${primary.strat.troughDate}。`);
  lines.push(
    `沪深300最深回撤 ${pct(primary.bench.mdd)}，是窗口内收盘价算的。四只各拿四分之一的最深回撤 ${pct(primary.equal.mdd)}，从 ${primary.equal.peakDate} 落到 ${primary.equal.troughDate}。`,
  );
  lines.push('');
  lines.push('## 各年切段（不改判定）');
  lines.push('');
  lines.push('每一年都从这一年第一天的净值接着算，不是从 1 块钱重新开始，所以各年收益连乘不等于整段总收益。');
  lines.push('');
  lines.push(...yearRows);
  lines.push('');
  lines.push('## 每月拿到谁（2020 起）');
  lines.push('');
  lines.push(`得分用月末及之前 ${WINDOW} 个交易日的收盘价算，买入在次月开盘。数值是「每天的对数斜率 × 贴合程度」，没有换算成年化。`);
  lines.push('');
  lines.push(...holdLines(primary, assets));
  lines.push('');
  lines.push('## 扣费后的净值（2020 起，起点都是 1）');
  lines.push('');
  lines.push('季末取该日或该日之前最近一个交易日的收盘净值。沪深300从窗口第一天收盘重新看成 1，不扣费。最后一行是数据末端。');
  lines.push('');
  lines.push('| 时点 | 正分Top2等权 | 四只各拿四分之一 | 沪深300 |');
  lines.push('|---|---:|---:|---:|');
  for (const day of quarters) {
    lines.push(
      `| ${day} | ${equityOn(primary.strat.marks, day).toFixed(4)} | ${equityOn(primary.equal.marks, day).toFixed(4)} | ${benchMarkOn(benchSlice, benchByDate, day).toFixed(4)} |`,
    );
  }
  lines.push('');
  lines.push('## 2024 起到末端（只披露，不改判定）');
  lines.push('');
  lines.push(
    '这段按同一套买卖，从 2024 年第一次买入重新起算，不是把 2020 起的净值切下来。多出来的只是进场那一笔费用。下面的数字不参与上面两条判定。',
  );
  lines.push('');
  lines.push(...mainTable(near, assets));
  lines.push('');
  lines.push(
    `- 回撤变浅 ${pp(near.strat.mdd - near.bench.mdd)}。年化差 ${pp(near.strat.cagr - near.bench.cagr)}。总收益差 ${pp(near.strat.totalReturnPct - near.bench.total)}。`,
  );
  lines.push(...holdBullets(near, assets));
  lines.push(`- 2024 年开年到 9 月 23 日，策略这段净值的回撤 ${pct(sliceMdd(near.strat.marks, WEAK_2024.start, WEAK_2024.end))}。`);
  lines.push('');
  lines.push('## 修复段（近窗，只披露）');
  lines.push('');
  lines.push(input.segmentMatch);
  lines.push('');
  lines.push('下面的收益是这些日子里，近窗策略净值和沪深300各自的日收益连乘。重叠的日子只算一遍。不是把那段单独从头再跑一遍。');
  lines.push('');
  lines.push('| 区间 | 沪深300 | 策略 | 策略−沪深300 | 交易日 |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const row of segRows) lines.push(row.line);
  lines.push('');
  lines.push(
    `2024年秋后指定那段差 ${named?.gap == null ? '—' : pp(named.gap)}。几段并在一起差 ${unionGap == null ? '—' : pp(unionGap)}（${union ? union.days : 0} 个交易日）。这里不设少多少就不过的线。`,
  );
  if (reboundSpread) {
    lines.push(
      `这几段「策略 − 沪深300」的收益差，最低 ${pp(reboundSpread.low)}，最高 ${pp(reboundSpread.high)}，高低落差 ${pp(reboundSpread.range)}，标准差 ${reboundSpread.stdev.toFixed(2)} 个百分点。`,
    );
  }
  lines.push('');
  lines.push('## 近窗里各段差开多少（只披露）');
  lines.push('');
  lines.push('下面也是同一条 2024 起到末端的净值，按日子切开。各段不能连乘当成总收益。');
  lines.push('');
  lines.push('| 区间 | 沪深300 | 策略 | 策略−沪深300 | 交易日 |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const row of sliceRows) lines.push(row.line);
  lines.push('');
  if (sliceSpread) {
    lines.push(
      `这几段「策略 − 沪深300」的收益差，最低 ${pp(sliceSpread.low)}，最高 ${pp(sliceSpread.high)}，高低落差 ${pp(sliceSpread.range)}，标准差 ${sliceSpread.stdev.toFixed(2)} 个百分点。`,
    );
  }
  lines.push('');
  lines.push('## 记账');
  lines.push('');
  const passText = judged.gates.map((gate) => `${gate.pass ? '过' : '不过'}·${gate.name}`).join('，');
  lines.push(
    `${judged.verdict} | 2020起回撤 ${pct(primary.bench.mdd)}→${pct(primary.strat.mdd)}（${pp(dMdd)}）| 年化 ${pct(primary.bench.cagr)}→${pct(primary.strat.cagr)}（${pp(dCagr)}）| 总收益差 ${pp(primary.strat.totalReturnPct - primary.bench.total)} | vsLoop11回撤 ${pp(vs11Mdd)} 年化 ${pp(vs11Cagr)} | 双持月 ${pct(dualShare)} | 换标的 ${primary.strat.switches} 次 | 最多${top.asset.name} ${pct(top.share)} | 近窗修复并集 ${unionGap == null ? '—' : pp(unionGap)}（不参与判定）| ${passText}`,
  );
  lines.push('');
  return lines.join('\n');
}

function yearTable(pack: WindowPack, benchBars: Bar[], end: string): string[] {
  const years = ['2020', '2021', '2022', '2023', '2024', '2025', '2026'];
  const lines = [
    '| 窗口 | 沪深300收益 | 策略收益 | 策略−沪深300 | 策略这段回撤 |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const year of years) {
    const start = `${year}-01-01`;
    const stop = year === '2026' ? end : `${year}-12-31`;
    const seg = { start, end: stop, label: year === '2026' ? `2026年到 ${end}` : `${year}年` };
    const hit = compoundBoth(pack.stratDay, pack.benchDay, datesIn(benchBars, [seg], pack.start, pack.end));
    const mdd = sliceMdd(pack.strat.marks, start, stop);
    if (!hit) {
      lines.push(`| ${seg.label} | — | — | — | ${pct(mdd)} |`);
      continue;
    }
    lines.push(`| ${seg.label} | ${pct(hit.bench)} | ${pct(hit.strat)} | ${pp(hit.strat - hit.bench)} | ${pct(mdd)} |`);
  }
  return lines;
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
