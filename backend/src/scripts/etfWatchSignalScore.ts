// ETF 盯盘信号的第一张成绩单：这套买点比随便买强多少。
//
// 只读本地库，不联网、不写库、不调模型。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/etfWatchSignalScore.ts [持有天数...]
// 例：  ./node_modules/.bin/tsx src/scripts/etfWatchSignalScore.ts 5 10 20
//
// 为什么值得单独跑这一张：
// ETF 主链目前唯一的买卖依据就是多周期 MACD 金叉加均线过滤（etfwatch/engine.ts），
// 而它发出的一千多条信号从来没有人核对过结果。这里用已经发生的行情把它们逐条判分。
//
// 两个对照缺一不可，因为它们回答的是两个不同的问题：
//   · 同标的随机日：在这只 ETF 上随便挑一天买，能拿多少？→ 检验「择时」有没有本事
//   · 同一天全池：这一天买池子里任意一只，能拿多少？→ 检验「选标的」有没有本事
// 光看信号自己的收益率毫无意义——牛市里随便买都赚钱。
//
// 判分口径（写死，便于复现）：
//   · 入场价取信号当日收盘价。信号在盘中发出，收盘价是能稳定复现、且不占便宜的取法。
//   · 收益 = N 个交易日后的收盘价 / 入场收盘价 - 1，不扣手续费（对照组同样不扣，差值不受影响）。
//   · 同一只 ETF 同一天的多条信号合并成一条，否则一天刷屏十次就把那天的涨跌重复计十遍。
//   · 未来 K 线不足 N 根的信号不计入，不用短窗凑数。
import { sqlite } from '../db/client';

/** 命令行给的持有天数，缺省 5/10/20 */
const HORIZONS = (() => {
  const args = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return args.length ? args : [5, 10, 20];
})();

interface SignalRow {
  code: string;
  signal_type: string;
  verdict: string | null;
  created_at: string;
}

/** ISO（UTC）→ 上海交易日 YYYY-MM-DD */
function shanghaiDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10);
}

// ===== 取数 =====

const signals = sqlite
  .prepare(
    `select code, signal_type, verdict, created_at from etf_watch_signals order by created_at`,
  )
  .all() as SignalRow[];

/** code → 交易日升序的收盘价序列 */
const series = new Map<string, { dates: string[]; closes: number[]; idx: Map<string, number> }>();
{
  const rows = sqlite
    .prepare(
      `select code, trade_date, close from kline_daily
       where provisional = 0 group by code, trade_date order by code, trade_date`,
    )
    .all() as Array<{ code: string; trade_date: string; close: number }>;
  for (const r of rows) {
    let s = series.get(r.code);
    if (!s) {
      s = { dates: [], closes: [], idx: new Map() };
      series.set(r.code, s);
    }
    s.idx.set(r.trade_date, s.dates.length);
    s.dates.push(r.trade_date);
    s.closes.push(r.close);
  }
}

// ===== 收益计算 =====

/**
 * 某标的在某交易日买入、持有 n 个交易日的收益。
 * 该日无行情（停牌/未收录）时向后顺延到第一个有行情的交易日，仍取不到或未来不足 n 根则 null。
 */
function forwardReturn(code: string, date: string, n: number): number | null {
  const s = series.get(code);
  if (!s) return null;
  let i = s.idx.get(date);
  if (i == null) {
    i = s.dates.findIndex((d) => d >= date);
    if (i < 0) return null;
  }
  const j = i + n;
  if (j >= s.closes.length) return null;
  const a = s.closes[i];
  const b = s.closes[j];
  if (!(a > 0) || !(b > 0)) return null;
  return b / a - 1;
}

interface Stat {
  n: number;
  mean: number;
  winRate: number;
}

function summarize(xs: number[]): Stat {
  if (xs.length === 0) return { n: 0, mean: 0, winRate: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const wins = xs.filter((x) => x > 0).length;
  return { n: xs.length, mean, winRate: wins / xs.length };
}

const pct = (v: number): string => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - [...s].length * 1));

// ===== 主流程 =====

/** 去重后的信号：同一只 ETF 同一天同一类型只算一条 */
interface Uniq {
  code: string;
  date: string;
  type: string;
  /** 该 code+date 上出现过的裁决，用于分组统计 */
  verdicts: Set<string>;
}

const uniqMap = new Map<string, Uniq>();
for (const s of signals) {
  const date = shanghaiDate(s.created_at);
  if (!date) continue;
  const key = `${s.code}|${date}|${s.signal_type}`;
  let u = uniqMap.get(key);
  if (!u) {
    u = { code: s.code, date, type: s.signal_type, verdicts: new Set() };
    uniqMap.set(key, u);
  }
  if (s.verdict) u.verdicts.add(s.verdict);
}
const uniq = [...uniqMap.values()];

/** 信号覆盖的交易日范围，两个对照都限定在这个范围内取样，避免拿别的行情段做对照 */
const dates = uniq.map((u) => u.date).sort();
const from = dates[0] ?? '';
const to = dates[dates.length - 1] ?? '';
/** 信号涉及的标的集合，即「全池」 */
const pool = [...new Set(uniq.map((u) => u.code))];

console.log('# ETF 盯盘信号成绩单');
console.log();
console.log(`原始信号 ${signals.length} 条，同标的同日同类型合并后 ${uniq.length} 条`);
console.log(`区间 ${from} ~ ${to}，涉及 ${pool.length} 只 ETF`);
console.log(`入场价取信号当日收盘价，收益不扣手续费（对照组同样不扣）`);
console.log();

for (const type of ['buy_layer', 'sell_layer', 'hard_stop']) {
  const group = uniq.filter((u) => u.type === type);
  if (group.length === 0) continue;
  const typeName =
    type === 'buy_layer' ? '买点' : type === 'sell_layer' ? '减仓点' : '硬止损';
  // 卖出类信号的价值方向是反的：发出之后价格越跌，说明「该卖」这个判断越对。
  // 不做这个翻转，表里「跑输基准 9 个百分点」会被读成信号很差，实际含义正好相反。
  const dir = type === 'buy_layer' ? 1 : -1;

  console.log(`## ${typeName}（${group.length} 条）`);
  console.log();
  if (dir < 0) {
    console.log('（卖出类信号：下面的收益是「假如当时没卖、继续持有」的结果，');
    console.log('　所以收益越低说明当初该卖这个判断越对。价值两列已按此方向换算。）');
    console.log();
  }
  console.log(
    `${pad('持有', 6)}${pad('可判', 6)}${pad('后续走势', 11)}${pad('上涨占比', 10)}` +
      `${pad('同标的随机日', 14)}${pad('同日全池', 11)}${pad('对比随机日', 12)}${pad('对比全池', 10)}`,
  );

  for (const n of HORIZONS) {
    // 信号组
    const sig: number[] = [];
    for (const u of group) {
      const r = forwardReturn(u.code, u.date, n);
      if (r != null) sig.push(r);
    }

    // 对照一：同标的随机日。用该标的在信号区间内所有交易日的均值，
    // 即「随便挑一天买」的数学期望本身，比抽样更准且不引入随机噪声。
    const byCode: number[] = [];
    for (const u of group) {
      const s = series.get(u.code);
      if (!s) continue;
      const rs: number[] = [];
      for (let i = 0; i < s.dates.length; i += 1) {
        const d = s.dates[i];
        if (d < from || d > to) continue;
        const r = forwardReturn(u.code, d, n);
        if (r != null) rs.push(r);
      }
      if (rs.length) byCode.push(rs.reduce((a, b) => a + b, 0) / rs.length);
    }

    // 对照二：同一天买全池任意一只。控制住了大盘环境，单独检验「挑对了标的没有」。
    const byDate: number[] = [];
    for (const u of group) {
      const rs: number[] = [];
      for (const c of pool) {
        const r = forwardReturn(c, u.date, n);
        if (r != null) rs.push(r);
      }
      if (rs.length) byDate.push(rs.reduce((a, b) => a + b, 0) / rs.length);
    }

    const a = summarize(sig);
    const b = summarize(byCode);
    const c = summarize(byDate);
    console.log(
      `${pad(`${n}日`, 6)}${pad(String(a.n), 6)}${pad(pct(a.mean), 11)}` +
        `${pad(`${(a.winRate * 100).toFixed(0)}%`, 10)}` +
        `${pad(pct(b.mean), 14)}${pad(pct(c.mean), 11)}` +
        `${pad(pct(dir * (a.mean - b.mean)), 12)}${pad(pct(dir * (a.mean - c.mean)), 10)}`,
    );
  }
  console.log();

  // 裁决分组：只对买点做。它检验的是模型那一层——
  // 如果「建仓」和「放弃」的事后收益没有差别，说明这层裁决没有增加信息。
  if (type === 'buy_layer') {
    const verdicts = [...new Set(group.flatMap((u) => [...u.verdicts]))].sort();
    if (verdicts.length > 1) {
      const n = HORIZONS[0];
      console.log(`### 按裁决分组（持有 ${n} 日）`);
      console.log();
      console.log(`${pad('裁决', 10)}${pad('可判', 6)}${pad('收益', 11)}${pad('胜率', 8)}`);
      for (const v of verdicts) {
        const rs: number[] = [];
        for (const u of group) {
          if (!u.verdicts.has(v)) continue;
          const r = forwardReturn(u.code, u.date, n);
          if (r != null) rs.push(r);
        }
        const st = summarize(rs);
        console.log(
          `${pad(v, 10)}${pad(String(st.n), 6)}${pad(pct(st.mean), 11)}` +
            `${pad(`${(st.winRate * 100).toFixed(0)}%`, 8)}`,
        );
      }
      console.log();
    }
  }
}

console.log('---');
console.log('怎么读：只看「对比随机日」和「对比全池」两列，它们已按信号方向换算成价值。');
console.log('后续走势那一列本身说明不了任何问题——区间里大盘怎么走，随便买也是那个结果。');
console.log('两列都明显为正，这套信号才算有本事；接近零或为负，说明它还不如瞎买。');
