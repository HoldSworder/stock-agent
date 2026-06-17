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
  listRecentSnapshots,
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
/** 板块成分并发取数上限（控制对 aktools 的瞬时压力） */
const FETCH_CONCURRENCY = 8;

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
  streakDays: number;
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

  // 2) 板块清单（行业 + 概念）
  const [industries, concepts] = await Promise.all([
    fetchBoards('industry').catch(() => [] as BoardMeta[]),
    fetchBoards('concept').catch(() => [] as BoardMeta[]),
  ]);
  const boards = [...industries, ...concepts];
  if (boards.length === 0) stale = true;

  // 3) 逐板块取成分并与创新高集合求交集计数（并发受限，best-effort）
  const counts: RawCount[] = newHighSet.size === 0 || boards.length === 0
    ? []
    : (
        await mapLimit(boards, FETCH_CONCURRENCY, async (meta): Promise<RawCount | null> => {
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

  // 5) 历史快照（近 LOOKBACK_DAYS 交易日）按 boardCode 分组，旧→新无所谓，取值即可
  const history = listRecentSnapshots(tradeDate, LOOKBACK_DAYS);
  const histByBoard = new Map<string, BoardBreadthSnapshotRow[]>();
  for (const row of history) {
    const arr = histByBoard.get(row.boardCode) ?? [];
    arr.push(row);
    histByBoard.set(row.boardCode, arr);
  }
  // 每个板块历史按交易日倒序（新→旧）
  for (const arr of histByBoard.values()) arr.sort((a, b) => (a.tradeDate < b.tradeDate ? 1 : -1));

  // 6) 逐项算持续性 + 判定 + 映射 ETF
  const items: BoardBreadthItem[] = counts.map((c, i) => {
    const rank = i + 1;
    const hist = histByBoard.get(c.meta.code) ?? [];
    const prev = hist[0] ?? null;
    const prevCount = prev ? prev.newHighCount : null;
    const delta = prevCount != null ? c.newHighCount - prevCount : null;

    // 连续达标天数：今日 + 历史（新→旧）中连续满足地板的天数
    const flooredSeq = [
      meetsFloor(c.newHighCount, c.ratio),
      ...hist.map((h) => meetsFloor(h.newHighCount, h.ratio)),
    ];
    let streakDays = 0;
    for (const ok of flooredSeq) {
      if (!ok) break;
      streakDays += 1;
    }
    // 近端居榜首天数：今日 + 历史中排名 ≤ TOP_RANK 的天数（限 LOOKBACK_DAYS+1 个窗口）
    const topSeq = [rank, ...hist.map((h) => h.rank)].slice(0, LOOKBACK_DAYS + 1);
    const topDays = topSeq.filter((rk) => rk <= TOP_RANK).length;
    const wasMainline = hist.some((h) => h.rank <= TOP_RANK);

    const verdict = judge({
      count: c.newHighCount,
      ratio: c.ratio,
      rank,
      prevCount,
      streakDays,
      topDays,
      wasMainline,
    });

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
