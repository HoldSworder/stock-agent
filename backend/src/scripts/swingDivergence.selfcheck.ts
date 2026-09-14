// 背驰检测自检：钉住四个「写错了也看不出来」的地方。
//
// 背驰是本模块唯一新增的判断，而它的失效方式全是静默的——
// 拿错的两段比、下标错位、正负柱抵消，算出来都是一个像样的数字，
// 页面上照样显示「力道在衰减」。所以这里逐个构造能证伪的场景。
//
// 特别说明第 1 项：笔严格上下交替，同向的两段一定隔一笔。
// 若实现取了相邻笔（i-1），比较的是一段下跌和一段上涨。
// 本自检构造的数据里，那样比会得出与事实相反的结论，从而暴露该错误。
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingDivergence.selfcheck.ts
import type { KlineBar } from '@stock-agent/shared';
import { buildSegments, detectDivergence, DIVERGENCE_PARAMS } from '../swing/divergence';

const line = (s: string): void => console.log(s);
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) line(`ok   ${name}`);
  else {
    line(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

/** 造一根 K 线；high/low 按 close 上下浮动，保证有振幅可供分型识别 */
function bar(i: number, close: number, span = 0.02): KlineBar {
  const d = new Date(Date.UTC(2026, 0, 5) + i * 86400_000);
  // 跳过周末，让 time 序列像真实交易日
  const day = d.getUTCDay();
  if (day === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (day === 0) d.setUTCDate(d.getUTCDate() + 1);
  const time = d.toISOString().slice(0, 10);
  return {
    time,
    open: close,
    close,
    high: close * (1 + span),
    low: close * (1 - span),
    volume: 1_000_000,
    amount: close * 1_000_000,
  };
}

/**
 * 按分段线性走势造 K 线序列。
 * segs 为 [涨跌幅, 根数] 序列，从 start 起逐段线性推进。
 */
function makeSeries(start: number, segs: Array<[number, number]>): KlineBar[] {
  const closes: number[] = [];
  let price = start;
  for (const [pct, n] of segs) {
    const step = (price * pct) / n;
    for (let i = 0; i < n; i += 1) {
      price += step;
      closes.push(Number(price.toFixed(4)));
    }
  }
  return closes.map((c, i) => bar(i, c));
}

/** 预热段：MACD 要二十几根才成型，所有场景前面都得垫一段平稳走势 */
const WARMUP: Array<[number, number]> = [
  [0.04, 12],
  [-0.03, 10],
  [0.03, 12],
  [-0.02, 10],
];

/**
 * 收尾确认段：让末段的极值点形成分型，末段笔才算走完。
 *
 * 这不是为了让自检通过而凑的数据，而是缠论的固有性质：
 * 分型要三根 K 线、中间那根是极值，所以**极值必须已经被右侧至少一根 K 线越过**。
 * 没有这一段时末段笔还停在上一段方向上，背驰压根无从判断。
 *
 * 由此带来一个实际后果，必须让使用者知道：
 * 背驰信号出现时，价格已经离开最低点一小段了。这个滞后消除不了，
 * 也正是本模块给「区间」而不给「精确点位」的原因。
 */
const CONFIRM_UP: Array<[number, number]> = [[0.03, 4]];
const CONFIRM_DOWN: Array<[number, number]> = [[-0.03, 4]];

function run(name: string, bars: KlineBar[]): ReturnType<typeof detectDivergence> {
  const segs = buildSegments(bars, 'day');
  const res = detectDivergence(bars, 'day');
  line(
    `     [${name}] 有效段 ${segs.length}，结论 ${res.kind ?? '无背驰'}` +
      `${res.areaRatio != null ? `，面积比 ${(res.areaRatio * 100).toFixed(0)}%` : ''}`,
  );
  return res;
}

function main(): void {
  line('=== 背驰检测自检 ===');
  line(`参数：力道至少减弱 ${DIVERGENCE_PARAMS.minWeakenRatio * 100}%，` +
    `段长比可比区间 ${DIVERGENCE_PARAMS.comparableBarRatio.min}~${DIVERGENCE_PARAMS.comparableBarRatio.max}`);
  line('');

  // --- 场景 1：典型底背驰 ---
  // 第一段深跌（力道足），反弹，第二段跌破前低但跌得又慢又浅（力道衰减），末尾回升确认底分型
  const bottomDiv = run(
    '底背驰',
    makeSeries(10, [...WARMUP, [-0.22, 12], [0.1, 8], [-0.12, 14], ...CONFIRM_UP]),
  );
  check(
    '典型底背驰能被识别',
    bottomDiv.kind === 'bottom',
    `实际 ${bottomDiv.kind ?? '无'}；依据 ${bottomDiv.rationale.join('｜')}；反证 ${bottomDiv.counterEvidence.join('｜')}`,
  );
  check(
    '底背驰给出 0~1 的强度',
    bottomDiv.strength != null && bottomDiv.strength >= 0 && bottomDiv.strength <= 1,
    `strength=${bottomDiv.strength}`,
  );
  check('底背驰给出判定依据', bottomDiv.rationale.length >= 3);

  // --- 场景 2：价格没创新低 → 不算背驰 ---
  // 第二段跌幅小且没破前低，即便力道弱也不构成背驰
  const noNewLow = run(
    '未创新低',
    makeSeries(10, [...WARMUP, [-0.2, 12], [0.12, 8], [-0.03, 12], ...CONFIRM_UP]),
  );
  check(
    '价格没创新低不报背驰',
    noNewLow.kind === null,
    `实际 ${noNewLow.kind}`,
  );
  check(
    '未创新低时给出反证说明',
    noNewLow.counterEvidence.length > 0 || noNewLow.rationale.length > 0,
  );

  // --- 场景 3：力道没衰减（第二段跌得更凶）→ 不算背驰 ---
  const strongerDown = run(
    '力道更强',
    makeSeries(10, [...WARMUP, [-0.08, 12], [0.06, 8], [-0.25, 12], ...CONFIRM_UP]),
  );
  check(
    '第二段跌得更凶时不报背驰',
    strongerDown.kind === null,
    `实际 ${strongerDown.kind}，面积比 ${strongerDown.areaRatio}`,
  );

  // --- 场景 4：段长差太多 → 判不可比，不报 ---
  const lopsided = run(
    '段长悬殊',
    makeSeries(10, [...WARMUP, [-0.2, 30], [0.1, 8], [-0.12, 4], ...CONFIRM_UP]),
  );
  check(
    '两段长度悬殊时判不可比而非硬比',
    lopsided.kind === null,
    `实际 ${lopsided.kind}`,
  );
  check(
    '不可比时说明原因是长度',
    lopsided.counterEvidence.some((s) => s.includes('长度')) ||
      lopsided.rationale.some((s) => s.includes('不足')),
    `依据 ${[...lopsided.rationale, ...lopsided.counterEvidence].join('｜')}`,
  );

  // --- 场景 5：笔太少 → 不判 ---
  const tooShort = run('笔太少', makeSeries(10, [[-0.05, 20], [0.05, 20]]));
  check('笔数不足时不判背驰', tooShort.kind === null);

  // --- 场景 6：顶背驰对称成立 ---
  const topDiv = run(
    '顶背驰',
    makeSeries(10, [...WARMUP, [0.22, 12], [-0.1, 8], [0.12, 14], ...CONFIRM_DOWN]),
  );
  check(
    '顶背驰能被识别（与底背驰对称）',
    topDiv.kind === 'top',
    `实际 ${topDiv.kind ?? '无'}；反证 ${topDiv.counterEvidence.join('｜')}`,
  );

  // --- 场景 7：方向交替不可破坏 ---
  // 这是「同向两段隔一段」的前提。曾经为挡短段而在造段时跳段，
  // 结果段序列变成 down/down/up，日线上全部报「末段与隔一段方向不一致」。
  // 所以这里对多种行情形态都断言交替性，防止以后再有过滤把它破坏掉。
  const shapes: Array<{ name: string; segs: Array<[number, number]> }> = [
    {
      name: '锯齿',
      segs: Array.from(
        { length: 30 },
        (_, i) => [i % 2 === 0 ? 0.01 : -0.01, 1] as [number, number],
      ),
    },
    { name: '单边上涨', segs: [[0.5, 40]] },
    { name: '深跌反弹', segs: [...WARMUP, [-0.3, 15], [0.2, 12]] },
    {
      name: '宽幅震荡',
      segs: [
        [0.15, 8],
        [-0.12, 8],
        [0.14, 8],
        [-0.11, 8],
        [0.13, 8],
      ],
    },
  ];
  for (const s of shapes) {
    const segs = buildSegments(makeSeries(10, s.segs), 'day');
    check(
      `${s.name}行情下段方向严格交替（${segs.length} 段）`,
      segs.every((seg, i) => i === 0 || seg.dir !== segs[i - 1].dir),
      `方向序列 ${segs.map((x) => x.dir).join(',')}`,
    );
  }

  // --- 场景 8：空输入与极短输入 ---
  for (const n of [0, 1, 5]) {
    const b = makeSeries(10, [[0, n]]).slice(0, n);
    let ok = true;
    try {
      const res = detectDivergence(b, 'day');
      ok = res.kind === null;
    } catch {
      ok = false;
    }
    check(`极短输入 n=${n} 不崩且不报背驰`, ok);
  }

  line('');
  line(failed === 0 ? 'PASS 背驰自检通过' : `FAIL ${failed} 项不达标`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
