import type {
  BoardBreadthItem,
  BoardBreadthOverview,
  BoardBreadthVerdict,
  BoardKind,
} from '@stock-agent/shared';
import { nowIso, shanghaiToday } from '../util';
import {
  fetchBoardConstituents,
  fetchBoards,
  fetchMarketNewHighSet,
  type BoardMeta,
  type NewHighWindow,
} from './data';
import {
  getLatestSnapshotDate,
  listRecentSnapshots,
  listSnapshotsByDate,
  upsertSnapshots,
  type BoardBreadthSnapshotRow,
} from './repo';

// 板块新高宽度主线识别（确定性、规则化、零量化知识）：
// 统计每个概念/行业板块内「创新高个股数」并横向排名，以「新高数最多且持续多日稳居榜首」判定主线。
// 绝对数仅作数量级地板（防冰点市误判），核心判据是相对排名 + 持续性。所有阈值为下方可校准常量。

// ===== 可校准阈值（跑 1-2 周后用真实快照对照通信/半导体波段微调；改这里即可）=====
/** 新高窗口口径（同花顺现成档：创月新高/半年新高/一年新高/历史新高）。默认半年，最贴中线主升浪 */
const WINDOW: NewHighWindow = '半年新高';
/** 数量级地板：新高数 ≥ 此值 视为「达标」（大板块靠它入选） */
const FLOOR_COUNT = 10;
/** 或 新高占比 ≥ 此值 % 也算达标（小题材板块靠占比入选，免被大板块绝对数挤掉） */
const FLOOR_RATIO = 20;
/** 确认主线的更高门槛：新高数 ≥ 此值 */
const CONFIRM_COUNT = 15;
/** 或 新高占比 ≥ 此值 % */
const CONFIRM_RATIO = 25;
/** 「榜首」口径：当日排名 ≤ 此值算居首（1=只认第一名；放宽改 3） */
const TOP_RANK = 1;
/** 持续性回看交易日数 */
const LOOKBACK_DAYS = 5;
/** 近 LOOKBACK_DAYS 日内居榜首 ≥ 此天数 → 确认主线（含当日） */
const PERSIST_TOP_DAYS = 3;
/** 退潮：新高数较上一交易日下降 ≥ 此 % 且曾居首，视为宽度退潮 */
const FADE_DROP_PCT = 50;
/** 榜单展示/落库上限（按新高数降序截取） */
const MAX_BOARDS = 40;

// ===== ETF 盯盘·中长期主线口径（仅供 ETF 多周期盯盘研判用，独立于上方当日/短期口径）=====
/** 中长期回看交易日窗口（约一个半月，贴中线主升浪聚焦） */
const MID_WINDOW_DAYS = 30;
/** 中长期「居前」口径：窗口内排名 ≤ 此值算居前（比当日 TOP_RANK=1 略宽，容忍轮动内的名次波动） */
const MID_TOP_RANK = 3;
/** 窗口内居前 ≥ 此天数 → 认定为中长期主线 */
const MID_PERSIST_DAYS = 10;
/** 中长期主线展示上限 */
const MID_MAX_MAINLINES = 6;
/** 板块成分并发取数上限（控制对 aktools/东财的瞬时压力，避免触发 push2 反爬 IP 限流） */
const FETCH_CONCURRENCY = 3;
/** 每次取成分前的随机抖动区间（毫秒），错峰发包，进一步降低瞬时 req/s */
const FETCH_JITTER_MS: readonly [number, number] = [50, 120];

/** 在区间内随机睡眠，用于错峰取数 */
function jitterDelay([lo, hi]: readonly [number, number]): Promise<void> {
  const ms = lo + Math.floor(Math.random() * Math.max(0, hi - lo));
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 板块新高宽度采集的「板块宇宙」过滤：剔除非主线的伪概念（通道/宽基/风格/交易行为类），
 * 既减半 push2 取数量（~580→~250，降低反爬风险），又避免「深股通/小盘股」等霸榜污染主线识别。
 * 命中即剔除；行业板块（industry）天然不含这些词，主要作用于概念板块。可按需增改。
 */
const JUNK_BOARD_PATTERNS: readonly RegExp[] = [
  // 资金通道 / 指数纳入（与赛道无关）
  /股通|陆股通|QFII|MSCI|富时罗素|标普道琼斯|标普|道琼斯|纳入|成份股|成分股/i,
  // 宽基 / 市值风格
  /小盘股|中盘股|大盘股|微盘股|蓝筹|白马股|绩优股|超大盘|中字头|央企|国企改革|地方国企/,
  // 交易行为 / 异动（昨日涨停、连板、振幅、新高破净等）
  /昨日|连板|涨停|跌停|触板|打板|多板|振幅|新高|新低|破净|破发|高送转|送转|举牌|回购|增持|减持|质押|商誉|预盈|预增|预亏|预减|扭亏|摘帽|ST/,
  // 上市/板块归属类（非题材）
  /次新|注册制|创业板综|科创板块?|北交所|转债|可转债|融资融券|两融|股权转让|参股|参控股/,
  // 时间/统计类噪声
  /近期|最近|破发|高股息|分红|股息/,
];

/** 板块是否为应剔除的伪概念（任一模式命中即剔除） */
function isJunkBoard(name: string): boolean {
  return JUNK_BOARD_PATTERNS.some((re) => re.test(name));
}

/** 板块名关键词 → 代表 ETF（展示用，best-effort；无命中返回 null。可按需增改） */
const BOARD_ETF_KEYWORDS: ReadonlyArray<{ kw: RegExp; code: string; name: string }> = [
  { kw: /半导体设备|芯片设备/, code: '159516', name: '半导体设备ETF' },
  { kw: /科创.*芯|芯.*科创/, code: '588200', name: '科创芯片ETF' },
  { kw: /半导体|芯片|集成电路|存储|封装/, code: '512760', name: '半导体ETF' },
  { kw: /通信|通讯|5G|光模块|光通信|CPO/, code: '515880', name: '通信ETF' },
  { kw: /算力|数据中心|云计算/, code: '516510', name: '云计算ETF' },
  { kw: /人工智能|AI|大模型/, code: '159819', name: '人工智能ETF' },
  { kw: /机器人|人形/, code: '562500', name: '机器人ETF' },
  { kw: /计算机|软件|信创/, code: '512720', name: '计算机ETF' },
  { kw: /游戏|传媒|影视/, code: '159869', name: '游戏ETF' },
  { kw: /电池|锂电|储能/, code: '561910', name: '电池ETF' },
  { kw: /新能源车|汽车整车|汽车零部件|汽车/, code: '516110', name: '汽车ETF' },
  { kw: /光伏|风电/, code: '515790', name: '光伏ETF' },
  { kw: /军工|国防|航空航天/, code: '512660', name: '军工ETF' },
  { kw: /创新药|生物医药|医疗|医药/, code: '512010', name: '医药ETF' },
  { kw: /白酒|食品饮料|消费/, code: '512690', name: '酒ETF' },
  { kw: /证券|券商/, code: '512880', name: '证券ETF' },
  { kw: /银行/, code: '512800', name: '银行ETF' },
  { kw: /有色|稀土|金属|黄金/, code: '512400', name: '有色金属ETF' },
  { kw: /煤炭/, code: '515220', name: '煤炭ETF' },
  { kw: /电力|电网/, code: '159611', name: '电力ETF' },
  { kw: /地产|房地产/, code: '512200', name: '地产ETF' },
];

function mapBoardEtf(name: string): { code: string; name: string } | null {
  for (const e of BOARD_ETF_KEYWORDS) {
    if (e.kw.test(name)) return { code: e.code, name: e.name };
  }
  return null;
}

/** 并发受限 map：控制对 aktools 的瞬时取数压力 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const ret = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      ret[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return ret;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** 达标：新高数过地板 或 占比过地板 */
function meetsFloor(count: number, ratio: number): boolean {
  return count >= FLOOR_COUNT || ratio >= FLOOR_RATIO;
}
/** 确认门槛：新高数过确认线 或 占比过确认线 */
function meetsConfirm(count: number, ratio: number): boolean {
  return count >= CONFIRM_COUNT || ratio >= CONFIRM_RATIO;
}

/** 当日某板块的横向计数结果（未含持续性/判定） */
interface RawCount {
  meta: BoardMeta;
  newHighCount: number;
  consTotal: number;
  ratio: number;
}

const VERDICT_LABEL: Record<BoardBreadthVerdict, string> = {
  none: '未达标',
  candidate: '候选主线',
  confirmed: '确认主线',
  fading: '退潮',
};

/** 持续性 + 判定结果（由当日计数 + 该板块历史快照算出） */
interface Persistence {
  streakDays: number;
  topDays: number;
  delta: number | null;
  verdict: BoardBreadthVerdict;
}

/**
 * 由「当日计数 + 该板块近端历史快照（新→旧）」算持续性与主线判定。
 * 供实时总览与今日计划底稿复用，保证两处口径一致（DRY）。
 */
function assessPersistence(
  rank: number,
  count: number,
  ratio: number,
  hist: BoardBreadthSnapshotRow[],
): Persistence {
  const prevCount = hist[0]?.newHighCount ?? null;
  const delta = prevCount != null ? count - prevCount : null;
  // 连续达标天数：今日 + 历史中连续满足地板的天数
  const flooredSeq = [meetsFloor(count, ratio), ...hist.map((h) => meetsFloor(h.newHighCount, h.ratio))];
  let streakDays = 0;
  for (const ok of flooredSeq) {
    if (!ok) break;
    streakDays += 1;
  }
  // 近端居榜首天数：今日 + 历史中排名 ≤ TOP_RANK 的天数（限 LOOKBACK_DAYS+1 窗口）
  const topSeq = [rank, ...hist.map((h) => h.rank)].slice(0, LOOKBACK_DAYS + 1);
  const topDays = topSeq.filter((rk) => rk <= TOP_RANK).length;
  const wasMainline = hist.some((h) => h.rank <= TOP_RANK);
  const verdict = judge({ count, ratio, rank, prevCount, topDays, wasMainline });
  return { streakDays, topDays, delta, verdict };
}

/** 按 boardCode 把历史快照分组并按交易日新→旧排序 */
function groupHistory(history: BoardBreadthSnapshotRow[]): Map<string, BoardBreadthSnapshotRow[]> {
  const map = new Map<string, BoardBreadthSnapshotRow[]>();
  for (const row of history) {
    const arr = map.get(row.boardCode) ?? [];
    arr.push(row);
    map.set(row.boardCode, arr);
  }
  for (const arr of map.values()) arr.sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1));
  return map;
}

/**
 * 主线判定：
 *  - 先判退潮（曾居首 + 新高数腰斩/跌出榜首/掉地板）；
 *  - 否则达标 + 居首 + 确认门槛 + 持续 → 确认；
 *  - 否则达标 → 候选；其余未达标。
 */
function judge(args: {
  count: number;
  ratio: number;
  rank: number;
  prevCount: number | null;
  topDays: number;
  wasMainline: boolean;
}): BoardBreadthVerdict {
  const { count, ratio, rank, prevCount, topDays, wasMainline } = args;
  const isTop = rank <= TOP_RANK;
  const floored = meetsFloor(count, ratio);

  // 退潮：之前是主线/居首，如今掉地板、跌出榜首、或新高数较昨腰斩
  if (wasMainline) {
    const halved = prevCount != null && prevCount > 0 && count <= prevCount * (1 - FADE_DROP_PCT / 100);
    if (!floored || !isTop || halved) return 'fading';
  }
  if (!floored) return 'none';
  if (meetsConfirm(count, ratio) && isTop && topDays >= PERSIST_TOP_DAYS) return 'confirmed';
  return 'candidate';
}

/**
 * 组装板块新高宽度总览（确定性只读 + 落库当日快照供持续性判定）。
 * @param persist 是否写入当日快照（GET 与收盘定时均写，按 (date,code) upsert 幂等）
 */
export async function buildBreadthOverview(persist = true): Promise<BoardBreadthOverview> {
  const tradeDate = shanghaiToday();
  let stale = false;

  // 1) 全市场创新高集合（一次取数）
  let newHighSet: Set<string>;
  try {
    newHighSet = await fetchMarketNewHighSet(WINDOW);
  } catch {
    newHighSet = new Set();
  }
  if (newHighSet.size === 0) stale = true;

  // 2) 板块清单（行业 + 概念）；剔除通道/宽基/风格/交易行为类伪概念，减半取数量并净化主线榜单
  const [industries, concepts] = await Promise.all([
    fetchBoards('industry').catch(() => [] as BoardMeta[]),
    fetchBoards('concept').catch(() => [] as BoardMeta[]),
  ]);
  const rawBoards = [...industries, ...concepts];
  const boards = rawBoards.filter((b) => !isJunkBoard(b.name));
  if (rawBoards.length > 0) {
    console.info(
      `[breadth] 板块宇宙：原始 ${rawBoards.length} → 剔除伪概念 ${rawBoards.length - boards.length} → 取成分 ${boards.length}`,
    );
  }
  if (boards.length === 0) stale = true;

  // 3) 逐板块取成分并与创新高集合求交集计数（并发受限 + 错峰抖动，best-effort）
  const counts: RawCount[] = newHighSet.size === 0 || boards.length === 0
    ? []
    : (
        await mapLimit(boards, FETCH_CONCURRENCY, async (meta): Promise<RawCount | null> => {
          await jitterDelay(FETCH_JITTER_MS); // 错峰发包，降低对 push2 的瞬时 req/s
          const cons = await fetchBoardConstituents(meta.kind, meta.name).catch(() => [] as string[]);
          if (cons.length === 0) return null; // 成分取数失败/为空，不参与排名
          let newHighCount = 0;
          for (const code of cons) if (newHighSet.has(code)) newHighCount += 1;
          const consTotal = cons.length;
          const ratio = consTotal > 0 ? (newHighCount / consTotal) * 100 : 0;
          return { meta, newHighCount, consTotal, ratio };
        })
      ).filter((x): x is RawCount => x != null && x.newHighCount > 0);

  // 4) 横向排名：新高数降序，平手按占比降序
  counts.sort((a, b) => b.newHighCount - a.newHighCount || b.ratio - a.ratio);

  // 5) 历史快照（近 LOOKBACK_DAYS 交易日）按 boardCode 分组（新→旧）
  const histByBoard = groupHistory(listRecentSnapshots(tradeDate, LOOKBACK_DAYS));

  // 6) 逐项算持续性 + 判定 + 映射 ETF
  const items: BoardBreadthItem[] = counts.map((c, i) => {
    const rank = i + 1;
    const { streakDays, topDays, delta, verdict } = assessPersistence(
      rank,
      c.newHighCount,
      c.ratio,
      histByBoard.get(c.meta.code) ?? [],
    );

    const deltaText = delta == null ? '' : `·较昨${delta >= 0 ? '+' : ''}${delta}`;
    const note =
      `新高 ${c.newHighCount} 只（占比 ${r1(c.ratio)}%）·当日第 ${rank} 名` +
      `·近${LOOKBACK_DAYS}日居首 ${topDays} 日${deltaText}·【${VERDICT_LABEL[verdict]}】`;

    return {
      boardCode: c.meta.code,
      boardName: c.meta.name,
      kind: c.meta.kind,
      newHighCount: c.newHighCount,
      consTotal: c.consTotal,
      ratio: c.consTotal > 0 ? r1(c.ratio) : null,
      rank,
      streakDays,
      topDays,
      delta,
      verdict,
      etf: mapBoardEtf(c.meta.name),
      note,
    };
  });

  // 7) 落库（仅当有真实计数；按上限截取，控制每日行数）
  if (persist && items.length > 0) {
    upsertSnapshots(
      items.slice(0, Math.max(MAX_BOARDS, 60)).map((it) => ({
        tradeDate,
        boardCode: it.boardCode,
        boardName: it.boardName,
        kind: it.kind as BoardKind,
        newHighCount: it.newHighCount,
        consTotal: it.consTotal,
        ratio: it.ratio ?? 0,
        rank: it.rank,
      })),
    );
  }

  const mainlines = items.filter((it) => it.verdict === 'confirmed');

  return {
    asOf: nowIso(),
    tradeDate,
    window: WINDOW,
    marketNewHighTotal: newHighSet.size,
    items: items.slice(0, MAX_BOARDS),
    mainlines,
    note:
      '板块新高宽度（主线识别，确定性只读，仅供参考，不构成投资建议）：' +
      `按板块内${WINDOW}个股数横向排名，"最多且持续多日稳居榜首"判定主线。` +
      (stale ? '⚠️ 创新高/板块成分取数降级，榜为不完整估计（请到数据源页检查 AKShare 配置）。' : ''),
    stale,
  };
}

/**
 * 今日计划底稿：读「最新一份持久化板块新高快照」格式化为确定性文本块（不现场重跑，与情绪/复盘等源一致）。
 * 计划 agent 据此把"哪个板块新高最多且持续"作为主线判断的确定性证据之一。无快照时显式说明，由上层据时效降权。
 */
export function formatBreadthForPlan(): string {
  const date = getLatestSnapshotDate();
  if (!date) {
    return '【板块新高宽度·最新】无快照（板块新高模块未启用或未落库；到调度页启用「收盘快照」后次日起可用）。';
  }
  const rows = listSnapshotsByDate(date);
  if (rows.length === 0) return '【板块新高宽度·最新】无快照数据。';

  const histByBoard = groupHistory(listRecentSnapshots(date, LOOKBACK_DAYS));
  const enriched = rows.map((r) => ({
    ...r,
    ...assessPersistence(r.rank, r.newHighCount, r.ratio, histByBoard.get(r.boardCode) ?? []),
    etf: mapBoardEtf(r.boardName),
  }));
  const mains = enriched.filter((e) => e.verdict === 'confirmed');
  const top = enriched.slice(0, 8);

  const fresh = date === shanghaiToday() ? '' : `（${date}，非当日产出，注意时效）`;
  const lines: string[] = [
    `【板块新高宽度·最新】${fresh}（${WINDOW}口径，板块内创新高个股数横向排名；"最多且持续多日稳居榜首"判主线，确定性只读）`,
  ];
  if (mains.length > 0) {
    lines.push(
      '确认主线：' +
        mains
          .map(
            (m) =>
              `${m.boardName}(新高${m.newHighCount}/占比${r1(m.ratio)}%·居首${m.topDays}日${m.etf ? `→${m.etf.name}${m.etf.code}` : ''})`,
          )
          .join('；'),
    );
  } else {
    lines.push('确认主线：暂无（无板块稳居榜首足够天数，或市场处于冰点/普跌）。');
  }
  lines.push(
    '新高榜Top：' +
      top
        .map(
          (t) =>
            `${t.rank}.${t.boardName}(${t.newHighCount}/${r1(t.ratio)}%${t.delta != null ? `·较昨${t.delta >= 0 ? '+' : ''}${t.delta}` : ''})`,
        )
        .join('  '),
  );
  return lines.join('\n');
}

/** 中长期主线单板块聚合（窗口内统计，不复用当日 verdict 口径） */
interface MidlineAgg {
  boardCode: string;
  boardName: string;
  appearDays: number;
  topDays: number;
  confirmDays: number;
  latestRank: number;
  avgRank: number;
  latestNewHigh: number;
  earliestNewHigh: number;
}

/**
 * ETF 多周期盯盘专属：把板块新高宽度的「中长期主线」格式化为确定性文本块。
 * 不同于 formatBreadthForPlan 的当日/短期（5日）口径——这里跨 MID_WINDOW_DAYS（约30交易日）窗口聚合，
 * 以「窗口内多数时间居前」判定中长期主线，契合 ETF 中线主升浪聚焦。仅读历史快照、不现场重跑、不落库。
 */
export function formatMidlineBreadthForEtf(windowDays = MID_WINDOW_DAYS): string {
  const date = getLatestSnapshotDate();
  if (!date) {
    return '【中长期主线·板块新高宽度】无历史快照（板块新高模块未启用或未落库；启用「收盘快照」积累数日后可用）。';
  }
  // 窗口快照 = 最新一日 + 其之前的 windowDays-1 个交易日
  const rows = [...listSnapshotsByDate(date), ...listRecentSnapshots(date, Math.max(0, windowDays - 1))];
  if (rows.length === 0) return '【中长期主线·板块新高宽度】无历史快照数据。';

  // 按 boardCode 聚合（区分新→旧用于趋势：rows 中 latest 在前，但混入 recent 未严格排序，按 tradeDate 求极值更稳）
  const byBoard = new Map<string, BoardBreadthSnapshotRow[]>();
  for (const r of rows) {
    const arr = byBoard.get(r.boardCode) ?? [];
    arr.push(r);
    byBoard.set(r.boardCode, arr);
  }

  const aggs: MidlineAgg[] = [];
  for (const [boardCode, arr] of byBoard) {
    arr.sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1)); // 新→旧
    const appearDays = arr.length;
    const topDays = arr.filter((r) => r.rank <= MID_TOP_RANK).length;
    const confirmDays = arr.filter((r) => meetsConfirm(r.newHighCount, r.ratio)).length;
    const avgRank = arr.reduce((s, r) => s + r.rank, 0) / appearDays;
    aggs.push({
      boardCode,
      boardName: arr[0].boardName,
      appearDays,
      topDays,
      confirmDays,
      latestRank: arr[0].rank,
      avgRank,
      latestNewHigh: arr[0].newHighCount,
      earliestNewHigh: arr[arr.length - 1].newHighCount,
    });
  }

  // 中长期主线：窗口内居前天数达标，按居前天数降序、均名升序
  const mains = aggs
    .filter((a) => a.topDays >= MID_PERSIST_DAYS)
    .sort((a, b) => b.topDays - a.topDays || a.avgRank - b.avgRank)
    .slice(0, MID_MAX_MAINLINES);

  const fresh = date === shanghaiToday() ? '' : `（最新快照 ${date}，注意时效）`;
  const lines: string[] = [
    `【中长期主线·板块新高宽度】${fresh}（${WINDOW}口径，回看约${windowDays}个交易日；"窗口内多数时间居前${MID_TOP_RANK}名"判定中长期主线，确定性只读，仅供参考）`,
  ];
  if (mains.length > 0) {
    lines.push(
      '中长期主线：' +
        mains
          .map((m) => {
            const etf = mapBoardEtf(m.boardName);
            const trend = m.latestNewHigh >= m.earliestNewHigh ? '走强' : '趋缓';
            return `${m.boardName}(居前${m.topDays}/${m.appearDays}日·达标${m.confirmDays}日·最新第${m.latestRank}名·${trend}${etf ? `→${etf.name}${etf.code}` : ''})`;
          })
          .join('；'),
    );
  } else {
    lines.push('中长期主线：暂无（窗口内无板块多数时间稳居前列，可能处于轮动散乱/普跌阶段，主线聚焦需谨慎）。');
  }

  // 近端最强对照：按最新排名取前 5，供 agent 区分「当日异动」与「中长期主线」
  const recent = [...aggs].sort((a, b) => a.latestRank - b.latestRank).slice(0, 5);
  lines.push(
    '近端最强(对照·勿等同主线)：' +
      recent.map((r) => `${r.latestRank}.${r.boardName}(新高${r.latestNewHigh})`).join('  '),
  );
  return lines.join('\n');
}
