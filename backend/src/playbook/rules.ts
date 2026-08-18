import { BollingerBands, EMA, MACD, RSI } from 'trading-signals';
import {
  PLAYBOOK_RULE_CAPABILITY,
  type KlineBar,
  type PlaybookOp,
  type PlaybookRule,
  type PlaybookRuleGroup,
} from '@stock-agent/shared';

// 战法规则严格求值层：把一只标的的 K 线预计算成各指标的「逐 bar 序列」，
// 规则在第 i 根上按收盘确认口径判定 true/false。
// 指标算法一律复用 trading-signals（MACD/RSI/KDJ/BOLL/EMA），不自造近似；
// 指标不足样本的 bar 一律返回 null，规则判 false —— 宁可不开仓，不用近似值凑数。

/** 单只标的的指标序列缓存，下标与 bars 对齐 */
export interface Series {
  code: string;
  bars: KlineBar[];
  /** 均线：key = `${maType}${period}` */
  ma: Map<string, Array<number | null>>;
  macd: Array<{ dif: number; dea: number; bar: number } | null>;
  kdj: Array<{ k: number; d: number; j: number } | null>;
  rsi: Map<number, Array<number | null>>;
  boll: Array<{ upper: number; mid: number; lower: number } | null>;
}

/** 持仓上下文，供 pnlPct / heldBars 这类仅卖出可用的规则取值 */
export interface HoldContext {
  entryPrice: number;
  heldBars: number;
  /** 计划生效以来的完整 bar 数，供 barsSincePlan 取值；回测语境不提供 */
  planBars?: number;
}

function cmp(actual: number, op: PlaybookOp, target: number): boolean {
  switch (op) {
    case 'gte':
      return actual >= target;
    case 'lte':
      return actual <= target;
    case 'gt':
      return actual > target;
    case 'lt':
      return actual < target;
  }
}

/** 简单移动平均序列（不足周期为 null） */
function smaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/**
 * 指数移动平均序列（复用 trading-signals 的 EMA，逐根喂入取当根值）。
 * trading-signals@7 的 EMA 自播种，第 1 根输入就返回数值（只有 getResultOrThrow 才查预热），
 * 于是 ema60 在第 1 根等于当根收盘价，`close above ema60` 会在整个预热期用垃圾值开仓。
 * 这里显式在前 period-1 根返回 null，与同文件 smaSeries 以及文件头「不足样本一律 null」的约定对齐。
 */
function emaSeries(values: number[], period: number): Array<number | null> {
  const ema = new EMA(period);
  return values.map((v, i) => {
    const r = ema.add(v) as number | null;
    if (i < period - 1 || r == null) return null;
    return Number(r);
  });
}

/** MACD(12,26,9) 认信号的最早下标：慢线 26 根 + DEA 的 EMA(9) 也要吃满 */
const MACD_STABLE_BARS = 26 + 9;

/** KDJ 参数（通达信默认 9,3,3） */
const KDJ_N = 9;

/**
 * 国内口径 KDJ(9,3,3)：RSV 的 K/D 用 1/3 权重递推（SMMA），初值 50。
 * 不能用 trading-signals 的 StochasticOscillator——它是国际口径，内部对 fastK 做 SMA 平滑，
 * 只有 j=3k-2d 这一步和国内一致；用户按通达信读数写的 `kAbove: 80` 会命中完全不同的点位。
 * 同文件 MACD 已明确标注 CN 口径，这里对齐。
 */
function kdjSeriesCn(bars: KlineBar[]): Series['kdj'] {
  const out: Series['kdj'] = [];
  let k = 50;
  let d = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i < KDJ_N - 1) {
      out.push(null);
      continue;
    }
    const win = bars.slice(i - KDJ_N + 1, i + 1);
    const hh = Math.max(...win.map((b) => b.high));
    const ll = Math.min(...win.map((b) => b.low));
    // 窗口内无振幅（连续一字板）时 RSV 无定义，沿用上一根 K/D，不用 0 或 100 顶替
    const rsv = hh > ll ? ((bars[i].close - ll) / (hh - ll)) * 100 : k;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    out.push({ k, d, j: 3 * k - 2 * d });
  }
  return out;
}

/** 遍历规则收集需要预计算的均线，避免为未用到的周期做无谓计算 */
function collectMaKeys(rules: PlaybookRule[], into: Set<string>): void {
  for (const r of rules) {
    if (r.kind === 'ma') {
      into.add(`${r.maType}${r.period}`);
      if (r.left === 'ma' && r.leftPeriod) into.add(`${r.maType}${r.leftPeriod}`);
    } else if (r.kind === 'maAlign') {
      for (const p of r.periods) into.add(`${r.maType}${p}`);
    }
  }
}

function collectRsiPeriods(rules: PlaybookRule[], into: Set<number>): void {
  for (const r of rules) if (r.kind === 'rsi') into.add(r.period);
}

function needs(rules: PlaybookRule[], kind: PlaybookRule['kind']): boolean {
  return rules.some((r) => r.kind === kind);
}

/** 预计算一只标的的全部指标序列（只算规则真正用到的部分） */
export function buildSeries(code: string, bars: KlineBar[], groups: PlaybookRuleGroup[]): Series {
  const rules = groups.flatMap((g) => g.rules);
  const closes = bars.map((b) => b.close);

  const maKeys = new Set<string>();
  collectMaKeys(rules, maKeys);
  const ma = new Map<string, Array<number | null>>();
  for (const key of maKeys) {
    const maType = key.startsWith('ema') ? 'ema' : 'sma';
    const period = Number(key.slice(maType.length));
    if (!Number.isFinite(period) || period < 1) continue;
    ma.set(key, maType === 'ema' ? emaSeries(closes, period) : smaSeries(closes, period));
  }

  const rsi = new Map<number, Array<number | null>>();
  const rsiPeriods = new Set<number>();
  collectRsiPeriods(rules, rsiPeriods);
  for (const p of rsiPeriods) {
    const ind = new RSI(p);
    rsi.set(
      p,
      closes.map((c) => {
        const r = ind.add(c) as number | null;
        return r == null ? null : Number(r);
      }),
    );
  }

  const macd: Series['macd'] = [];
  if (needs(rules, 'macd')) {
    const ind = new MACD(new EMA(12), new EMA(26), new EMA(9));
    closes.forEach((c, i) => {
      const r = ind.add(c) as { macd: number; signal: number } | null;
      // MACD.update 从第 26 根就产出结果，但那时内部的 EMA(9) 只吃过 1 个 DIF，
      // dea 近似等于 dif，金叉/死叉判在一条无意义的信号线上。等 DEA 也吃满 9 个样本再认。
      if (!r || i < MACD_STABLE_BARS) {
        macd.push(null);
        return;
      }
      // CN 口径：DIF=快慢线差、DEA=DIF 的 9 日 EMA、柱=2×(DIF-DEA)
      macd.push({ dif: r.macd, dea: r.signal, bar: 2 * (r.macd - r.signal) });
    });
  } else {
    macd.push(...bars.map(() => null));
  }

  const kdj: Series['kdj'] = needs(rules, 'kdj') ? kdjSeriesCn(bars) : bars.map(() => null);

  const boll: Series['boll'] = [];
  if (needs(rules, 'boll')) {
    const ind = new BollingerBands(20, 2);
    for (const c of closes) {
      const r = ind.add(c) as { upper: number; middle: number; lower: number } | null;
      boll.push(
        r ? { upper: Number(r.upper), mid: Number(r.middle), lower: Number(r.lower) } : null,
      );
    }
  } else {
    boll.push(...bars.map(() => null));
  }

  return { code, bars, ma, macd, kdj, rsi, boll };
}

/** 按代码段判定涨跌停幅度（%）：创业板/科创板 20%，北交所 30%，其余主板 10% */
function limitPct(code: string): number {
  if (/^(30|68)/.test(code)) return 20;
  if (/^(43|83|87|88|92)/.test(code)) return 30;
  return 10;
}

function maAt(s: Series, maType: string, period: number, i: number): number | null {
  return s.ma.get(`${maType}${period}`)?.[i] ?? null;
}

/**
 * 求值单条规则在第 i 根 bar（收盘确认）上是否成立。
 * 所需指标缺样本一律返回 false，绝不用替代值近似。
 */
export function evalRule(rule: PlaybookRule, s: Series, i: number, hold?: HoldContext): boolean {
  const bars = s.bars;
  const bar = bars[i];
  if (!bar) return false;

  switch (rule.kind) {
    case 'ma': {
      const right = maAt(s, rule.maType, rule.period, i);
      const left = rule.left === 'close' ? bar.close : maAt(s, rule.maType, rule.leftPeriod ?? 0, i);
      if (right == null || left == null) return false;
      if (rule.relation === 'above') return left > right;
      if (rule.relation === 'below') return left < right;
      // 穿越需要上一根同样有值，否则无法判定
      if (i < 1) return false;
      const prevRight = maAt(s, rule.maType, rule.period, i - 1);
      const prevLeft =
        rule.left === 'close' ? bars[i - 1].close : maAt(s, rule.maType, rule.leftPeriod ?? 0, i - 1);
      if (prevRight == null || prevLeft == null) return false;
      return rule.relation === 'crossUp'
        ? prevLeft <= prevRight && left > right
        : prevLeft >= prevRight && left < right;
    }

    case 'maAlign': {
      if (rule.periods.length < 2) return false;
      const vals: number[] = [];
      for (const p of rule.periods) {
        const v = maAt(s, rule.maType, p, i);
        if (v == null) return false;
        vals.push(v);
      }
      for (let k = 1; k < vals.length; k++) {
        if (rule.dir === 'up' ? !(vals[k - 1] > vals[k]) : !(vals[k - 1] < vals[k])) return false;
      }
      return true;
    }

    case 'pctChange': {
      const base = bars[i - rule.days]?.close;
      if (base == null || base <= 0) return false;
      return cmp(((bar.close - base) / base) * 100, rule.op, rule.value);
    }

    case 'extreme': {
      // 需要完整的 days 根历史窗口（不含当根），窗口不足不判定
      if (i < rule.days) return false;
      const win = bars.slice(i - rule.days, i).map((b) => b.close);
      return rule.extreme === 'newHigh'
        ? bar.close > Math.max(...win)
        : bar.close < Math.min(...win);
    }

    case 'volRatio': {
      if (i < rule.days) return false;
      const win = bars.slice(i - rule.days, i);
      const avg = win.reduce((sum, b) => sum + b.volume, 0) / rule.days;
      if (!(avg > 0)) return false;
      return cmp(bar.volume / avg, rule.op, rule.value);
    }

    case 'macd': {
      const cur = s.macd[i];
      if (!cur) return false;
      if (rule.signal === 'barAbove0') return cur.bar > 0;
      if (rule.signal === 'barBelow0') return cur.bar < 0;
      const prev = s.macd[i - 1];
      if (!prev) return false;
      const curDiff = cur.dif - cur.dea;
      const prevDiff = prev.dif - prev.dea;
      return rule.signal === 'goldCross'
        ? prevDiff <= 0 && curDiff > 0
        : prevDiff >= 0 && curDiff < 0;
    }

    case 'kdj': {
      const cur = s.kdj[i];
      if (!cur) return false;
      if (rule.signal === 'kAbove') return rule.value != null && cur.k > rule.value;
      if (rule.signal === 'kBelow') return rule.value != null && cur.k < rule.value;
      const prev = s.kdj[i - 1];
      if (!prev) return false;
      return rule.signal === 'goldCross'
        ? prev.k <= prev.d && cur.k > cur.d
        : prev.k >= prev.d && cur.k < cur.d;
    }

    case 'rsi': {
      const v = s.rsi.get(rule.period)?.[i];
      if (v == null) return false;
      return cmp(v, rule.op, rule.value);
    }

    case 'boll': {
      const b = s.boll[i];
      if (!b) return false;
      if (rule.pos === 'aboveUpper') return bar.close > b.upper;
      if (rule.pos === 'belowLower') return bar.close < b.lower;
      return rule.pos === 'aboveMid' ? bar.close > b.mid : bar.close < b.mid;
    }

    case 'drawdown': {
      if (i < rule.days) return false;
      const hi = Math.max(...bars.slice(i - rule.days + 1, i + 1).map((b) => b.close));
      if (!(hi > 0)) return false;
      // 回撤取正数：距高点跌了多少
      return cmp(((hi - bar.close) / hi) * 100, rule.op, rule.value);
    }

    case 'consecutive': {
      if (i < rule.bars) return false;
      for (let k = 0; k < rule.bars; k++) {
        const cur = bars[i - k];
        const prev = bars[i - k - 1];
        if (!prev || prev.close <= 0) return false;
        if (rule.dir === 'up' ? !(cur.close > prev.close) : !(cur.close < prev.close)) return false;
      }
      return true;
    }

    case 'limit': {
      const prev = bars[i - 1];
      if (!prev || prev.close <= 0) return false;
      const pct = ((bar.close - prev.close) / prev.close) * 100;
      const cap = limitPct(s.code);
      // 涨跌停以收盘价相对昨收达到幅度上限判定（含四舍五入误差余量 0.5%）
      return rule.dir === 'up' ? pct >= cap - 0.5 : pct <= -(cap - 0.5);
    }

    case 'pnlPct': {
      if (!hold || !(hold.entryPrice > 0)) return false;
      return cmp(((bar.close - hold.entryPrice) / hold.entryPrice) * 100, rule.op, rule.value);
    }

    case 'heldBars': {
      if (!hold) return false;
      return cmp(hold.heldBars, rule.op, rule.value);
    }

    case 'amountRatio': {
      // 分母为前 days 根成交额中位数，不含当根（计划 4.2）
      if (i < rule.days) return false;
      const win = bars.slice(i - rule.days, i).map((b) => b.amount);
      const med = median(win);
      if (!(med > 0) || !(bar.amount > 0)) return false;
      return cmp(bar.amount / med, rule.op, rule.value);
    }

    case 'closeLocation': {
      const range = bar.high - bar.low;
      // 一字板等零振幅 bar 无法定义收盘位置，不判定
      if (!(range > 0)) return false;
      return cmp((bar.close - bar.low) / range, rule.op, rule.value);
    }

    case 'priceLevel': {
      const lv = rule.level;
      if (!(lv > 0)) return false;
      if (rule.relation === 'holdAbove') return bar.close > lv;
      if (rule.relation === 'holdBelow') return bar.close < lv;
      if (rule.relation === 'touch') return bar.low <= lv && bar.high >= lv;
      const prev = bars[i - 1];
      if (!prev) return false;
      return rule.relation === 'crossUp'
        ? prev.close <= lv && bar.close > lv
        : prev.close >= lv && bar.close < lv;
    }

    case 'barsSincePlan': {
      // 依赖计划锚点，回测语境无从取值。assertRunnableSpec 会先拒绝含此规则的 spec，
      // 走到这里说明是实时求值路径未提供 planBars，按不成立处理而非近似。
      if (hold?.planBars == null) return false;
      return cmp(hold.planBars, rule.op, rule.value);
    }
  }
}

/** 中位数（升序取中，偶数取两中值均值） */
function median(values: number[]): number {
  const arr = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

/** 求值规则组；空规则组返回 false（不成立），避免「无条件」导致每根都触发 */
export function evalGroup(
  group: PlaybookRuleGroup,
  s: Series,
  i: number,
  hold?: HoldContext,
): boolean {
  if (!group?.rules?.length) return false;
  return group.mode === 'any'
    ? group.rules.some((r) => evalRule(r, s, i, hold))
    : group.rules.every((r) => evalRule(r, s, i, hold));
}

/** 规则的中文描述，用于回测记录 notes 与前端只读展示 */
export function describeRule(rule: PlaybookRule): string {
  const opText: Record<PlaybookOp, string> = { gte: '>=', lte: '<=', gt: '>', lt: '<' };
  switch (rule.kind) {
    case 'ma': {
      const t = rule.maType.toUpperCase();
      const left = rule.left === 'close' ? '收盘价' : `${t}${rule.leftPeriod}`;
      const rel = { above: '在上方', below: '在下方', crossUp: '上穿', crossDown: '下穿' }[
        rule.relation
      ];
      return `${left} ${rel} ${t}${rule.period}`;
    }
    case 'maAlign':
      return `${rule.maType.toUpperCase()}${rule.periods.join('/')} ${rule.dir === 'up' ? '多头' : '空头'}排列`;
    case 'pctChange':
      return `近 ${rule.days} 根涨跌幅 ${opText[rule.op]} ${rule.value}%`;
    case 'extreme':
      return `创 ${rule.days} 根${rule.extreme === 'newHigh' ? '新高' : '新低'}（收盘）`;
    case 'volRatio':
      return `量比（对前 ${rule.days} 根均量） ${opText[rule.op]} ${rule.value}`;
    case 'macd':
      return `MACD ${{ goldCross: '金叉', deadCross: '死叉', barAbove0: '柱翻红', barBelow0: '柱翻绿' }[rule.signal]}`;
    case 'kdj':
      return `KDJ ${{ goldCross: '金叉', deadCross: '死叉', kAbove: `K > ${rule.value}`, kBelow: `K < ${rule.value}` }[rule.signal]}`;
    case 'rsi':
      return `RSI${rule.period} ${opText[rule.op]} ${rule.value}`;
    case 'boll':
      return `BOLL ${{ aboveUpper: '上穿上轨', belowLower: '跌破下轨', aboveMid: '中轨上方', belowMid: '中轨下方' }[rule.pos]}`;
    case 'drawdown':
      return `距近 ${rule.days} 根高点回撤 ${opText[rule.op]} ${rule.value}%`;
    case 'consecutive':
      return `连续 ${rule.bars} 根${rule.dir === 'up' ? '阳' : '阴'}线`;
    case 'limit':
      return rule.dir === 'up' ? '当根涨停' : '当根跌停';
    case 'pnlPct':
      return `浮动盈亏 ${opText[rule.op]} ${rule.value}%`;
    case 'heldBars':
      return `已持有 ${opText[rule.op]} ${rule.value} 根`;
    case 'amountRatio':
      return `成交额比（对前 ${rule.days} 根中位数） ${opText[rule.op]} ${rule.value}`;
    case 'closeLocation':
      return `收盘位置 ${opText[rule.op]} ${rule.value}`;
    case 'priceLevel': {
      const rel = {
        crossUp: '上穿',
        crossDown: '下穿',
        holdAbove: '收在上方',
        holdBelow: '收在下方',
        touch: '触及',
      }[rule.relation];
      // level 由 agent 编译填入，可能缺值；evalRule 已按脏值处理，这里同样不能直接 toFixed
      return `价格${rel} ${Number(rule.level ?? 0).toFixed(3)}`;
    }
    case 'barsSincePlan':
      return `计划生效已 ${opText[rule.op]} ${rule.value} 根`;
  }
}

/** 规则是否可在历史 bar 上回测（R18）。未注册的 kind 视为不可回测。 */
export function isBacktestableRule(rule: PlaybookRule): boolean {
  return PLAYBOOK_RULE_CAPABILITY[rule.kind] === 'backtest';
}
