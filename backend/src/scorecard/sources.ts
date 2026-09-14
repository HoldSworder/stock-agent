import type { ScorableSignal } from '@stock-agent/shared';
import { sqlite } from '../db/client';

// 信号来源注册表：哪些模块的产出可以被判分。
//
// 这张表就是「明码标价」的名册。规矩很简单：
// 一个模块想让自己的产出进操作台的建议区，就得在这里登记一个来源，
// 把它的观点表达成「标的 + 日期 + 方向」这种事后能判对错的形态。
// 登记不了的，说明它的产出无法被证伪，那它只能留在看图辅助那一层。
//
// 新增来源时只加一条 entry，不要在别处另写判分逻辑——
// 判分口径必须唯一，否则各模块各算一套，成绩之间没法比较。

export interface SignalSource {
  /** 稳定标识，形如 模块.信号类型 */
  id: string;
  /** 人读名称，会显示在成绩单上 */
  label: string;
  /** 看涨还是看跌。看跌信号的价值方向在判分时自动取反 */
  side: 'long' | 'short';
  /** 一句话说明这批信号是怎么产生的，供事后复查 */
  origin: string;
  /**
   * 对照池的归属。同一个 poolKey 的来源共享池子（取它们涉及标的的并集）。
   *
   * 为什么不是每个来源各用自己的：减仓点只在 30 只上触发过，
   * 用这 30 只当「同日全池」基准，等于拿信号偏爱的标的做对照，会低估它的优势。
   * 也不能跨模块合并：把波段覆盖的几百只个股混进 ETF 的基准，
   * 拿 ETF 跟个股比涨跌说明不了任何事。
   * 模块级正好——它就是这套规则实际工作的标的范围。
   */
  poolKey: string;
  load: () => ScorableSignal[];
}

/** ISO（UTC）→ 上海交易日 YYYY-MM-DD */
function shanghaiDate(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * ETF 盯盘信号。
 *
 * 三类分开登记而不是合成一个来源：买点与卖出类的方向相反，
 * 混在一起会互相抵消，得出一个「大致持平」的假象——
 * 而实测这两侧的成绩差得很远（买点看不出本事，卖出类稳定有效）。
 */
function loadEtfWatch(signalType: string): ScorableSignal[] {
  const rows = sqlite
    .prepare(
      `select code, verdict, created_at from etf_watch_signals
       where signal_type = ? order by created_at`,
    )
    .all(signalType) as Array<{ code: string; verdict: string | null; created_at: string }>;
  const side = signalType === 'buy_layer' ? 'long' : 'short';
  return rows
    .map((r) => ({
      code: r.code,
      tradeDate: shanghaiDate(r.created_at),
      side: side as 'long' | 'short',
      tag: r.verdict ?? undefined,
    }))
    .filter((s) => s.tradeDate !== '');
}

/**
 * 波段扫描信号。
 *
 * `swing_snapshots` 每个交易日给池里每只标的落一行，`grade` 是信号等级：
 * `*_bottom` 看涨、`*_top` 看跌、`none` 无信号（不登记，无信号不是判断）。
 * 一级（risk_easing）与二级（turn_confirmed）用 tag 分开出分——
 * 规则本身就规定只有二级能决定是否放大仓位，那这两级的成绩本来就该分开看。
 */
function loadSwing(dir: 'bottom' | 'top'): ScorableSignal[] {
  const rows = sqlite
    .prepare(
      `select code, trade_date, grade from swing_snapshots
       where grade like ? order by trade_date`,
    )
    .all(`%_${dir}`) as Array<{ code: string; trade_date: string; grade: string }>;
  const side = dir === 'bottom' ? 'long' : 'short';
  return rows.map((r) => ({
    code: r.code,
    tradeDate: r.trade_date,
    side: side as 'long' | 'short',
    tag: r.grade.startsWith('turn_confirmed') ? '二级·转折确认' : '一级·风险缓解',
  }));
}

export const SIGNAL_SOURCES: readonly SignalSource[] = [
  {
    id: 'etfwatch.buy',
    label: 'ETF 盯盘买点',
    side: 'long',
    origin: '多周期 MACD 金叉 + 均线过滤（etfwatch/engine.ts），ETF 主链目前唯一的买入依据',
    poolKey: 'etfwatch',
    load: () => loadEtfWatch('buy_layer'),
  },
  {
    id: 'etfwatch.sell',
    label: 'ETF 盯盘减仓点',
    side: 'short',
    origin: '多周期 MACD 死叉 + 层位撤出（etfwatch/engine.ts）',
    poolKey: 'etfwatch',
    load: () => loadEtfWatch('sell_layer'),
  },
  {
    id: 'etfwatch.stop',
    label: 'ETF 盯盘硬止损',
    side: 'short',
    origin: '固定比例硬止损（etfwatch/engine.ts）',
    poolKey: 'etfwatch',
    load: () => loadEtfWatch('hard_stop'),
  },
  {
    id: 'swing.bottom',
    label: '波段观察·看涨信号',
    side: 'long',
    origin: 'MACD 背驰识别 + 信号定级（swing/divergence.ts、judge.ts），一级/二级分组出分',
    poolKey: 'swing',
    load: () => loadSwing('bottom'),
  },
  {
    id: 'swing.top',
    label: '波段观察·看跌信号',
    side: 'short',
    origin: 'MACD 背驰识别 + 信号定级（swing/divergence.ts、judge.ts），一级/二级分组出分',
    poolKey: 'swing',
    load: () => loadSwing('top'),
  },
];

export function findSource(id: string): SignalSource | undefined {
  return SIGNAL_SOURCES.find((s) => s.id === id);
}

/**
 * 某来源的对照池：同 poolKey 全部来源涉及标的的并集。
 *
 * 池子由信号机械推导，不存在人为挑选的空间；同时因为合并了同模块的买卖两侧，
 * 它接近这套规则实际工作的标的范围，而不是「信号偏爱的那些」。
 */
export function poolFor(source: SignalSource): string[] {
  const codes = new Set<string>();
  for (const s of SIGNAL_SOURCES) {
    if (s.poolKey !== source.poolKey) continue;
    for (const sig of s.load()) codes.add(sig.code);
  }
  return [...codes];
}
