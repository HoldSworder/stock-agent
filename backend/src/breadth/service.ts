import type {
  BoardBreadthItem,
  BoardBreadthOverview,
  BoardBreadthVerdict,
  BoardKind,
  BoardMainlineStage,
  BoardStageAction,
  CoreContinuity,
} from '@stock-agent/shared';
import { nowIso, shanghaiToday } from '../util';
import { isTradingDay, prevTradingDay } from '../market/calendar';
import {
  fetchBoardConstituents,
  fetchBoards,
  fetchMarketNewHighSet,
  type BoardMeta,
  type NewHighWindow,
} from './data';
import { canPersistSnapshot } from '../scheduling/snapshotWindow';
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
/** 每板块落库的核心股（板块内创新高成分）上限，控制单行体积 */
const CORE_CODES_CAP = 30;
/**
 * 跨日确认要求的核心股重叠率下限：今日与上一交易日的板块内新高集合重叠 ≥ 此比例才算「同一批股在延续」。
 * 只比新高数量会把「每天换一批股轮流冲高」的普涨/轮动噪声误判成持续主线，那种主线追进去大概率立刻分歧。
 */
const CORE_CONTINUITY_MIN = 0.5;

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
  // 平台自造的聚合桶：不是行业也不是题材，成分每天换一批，
  // 「热股里有 12 只创新高」说明不了任何赛道在走强，却会挤掉真板块的位置
  /热股|热门|人气|龙虎榜|游资|机构重仓|基金重仓|北向/,
  /^题材股$|^概念股$|^其他$/,
];

/** 板块是否为应剔除的伪概念（任一模式命中即剔除） */
export function isJunkBoard(name: string): boolean {
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
  /** 板块内创新高的成分股代码（升序，已截断到 CORE_CODES_CAP） */
  coreCodes: string[];
}

const VERDICT_LABEL: Record<BoardBreadthVerdict, string> = {
  none: '未达标',
  candidate: '候选主线',
  confirmed: '确认主线',
  fading: '退潮',
};

/** 阶段中文名（前端与文本产出共用） */
export const STAGE_LABEL: Record<BoardMainlineStage, string> = {
  none: '未入场景',
  brewing: '主线酝酿',
  advancing: '主线主升',
  diverging: '主线分歧',
  fading: '主线退幕',
};

/** 阶段允许动作的中文说明（硬路由，只收紧不放大） */
export const STAGE_ACTION_LABEL: Record<BoardStageAction, string> = {
  none: '不参与',
  probe: '可试仓',
  lead: '可追领涨',
  hold_only: '只减不加',
  exit_only: '只退出',
};

/** verdict → 阶段。两者同源，阶段只是把判定翻译成面向操作的语义 */
function toStage(verdict: BoardBreadthVerdict, wasMainline: boolean): BoardMainlineStage {
  if (verdict === 'fading') return 'fading';
  if (verdict === 'confirmed') return 'advancing';
  if (verdict === 'candidate') return wasMainline ? 'diverging' : 'brewing';
  return 'none';
}

/**
 * 阶段 → 允许的开仓动作（硬路由）。
 * 只做收紧：酝酿只给试仓额度、主升才允许追领涨、分歧一律只减不加、退幕只退出。
 * 不存在「判定为主升就放大仓位」的分支——阶段判定滞后于价格，用它加码等于系统性高位加仓。
 */
export function stageAction(stage: BoardMainlineStage): BoardStageAction {
  switch (stage) {
    case 'brewing':
      return 'probe';
    case 'advancing':
      return 'lead';
    case 'diverging':
      return 'hold_only';
    case 'fading':
      return 'exit_only';
    default:
      return 'none';
  }
}

/**
 * 核心股延续度：上一交易日的核心股今天还有多少留在新高名单里（留存率）。
 *
 * 分母必须是 prevCodes.length 而不是 min(today, prev)：取 min 时「昨天 30 只、今天只剩 3 只且都在昨天名单里」
 * 会算出 100% 延续，而那恰恰是主线退潮最该报警的形态——同一批股大面积消失。
 *
 * 上一交易日快照缺该字段（改造前的历史行）时 overlap 返回 null —— 未知不阻断确认，
 * 否则改造当天全部主线会集体退回候选。真实延续判定从积累出第一份带 coreCodes 的快照起生效。
 */
function assessContinuity(today: string[], prev: string[] | undefined): CoreContinuity {
  const prevCodes = prev ?? [];
  if (prevCodes.length === 0 || today.length === 0) {
    return { kept: 0, prevCount: prevCodes.length, overlap: null };
  }
  const prevSet = new Set(prevCodes);
  const kept = today.filter((c) => prevSet.has(c)).length;
  return { kept, prevCount: prevCodes.length, overlap: kept / prevCodes.length };
}

/** 持续性 + 判定结果（由当日计数 + 该板块历史快照算出） */
interface Persistence {
  streakDays: number;
  topDays: number;
  delta: number | null;
  verdict: BoardBreadthVerdict;
  stage: BoardMainlineStage;
  action: BoardStageAction;
  continuity: CoreContinuity;
}

/**
 * 由「当日计数 + 该板块近端历史快照（新→旧）」算持续性与主线判定。
 * 供实时总览与今日计划底稿复用，保证两处口径一致（DRY）。
 *
 * @param tradeDate 当日交易日。传入时会校验 hist[0] 确实是上一交易日的快照，
 *   否则核心股延续度与「较昨」环比一并按未知处理——收盘快照漏跑时 hist[0] 可能是三天前的行，
 *   拿它做跨日比对得出的「较昨 -12」「腰斩」都是假的。不传则跳过校验（自检脚本直接喂构造数据）。
 * @param recentDates 近端快照实际存在的交易日序列（新→旧，不含当日）。
 *   连续达标天数必须按它对齐：hist 只含该板块出现过的行，某天缺席时直接把前后两天接起来，
 *   会把「达标—缺席—达标」报成连续 2 日。缺省则退回按 hist 逐行计算（自检构造数据用）。
 */
export function assessPersistence(
  rank: number,
  count: number,
  ratio: number,
  hist: BoardBreadthSnapshotRow[],
  coreCodes: string[] = [],
  tradeDate?: string,
  recentDates?: string[],
): Persistence {
  const prevRow = hist[0];
  const prevIsYesterday =
    tradeDate == null || (prevRow != null && prevRow.tradeDate === prevTradingDay(tradeDate));
  // 环比/腰斩判据与 continuity 共用同一个新鲜度口径：不是上一交易日的行一律不当「昨天」用
  const prevCount = prevIsYesterday ? prevRow?.newHighCount ?? null : null;
  const delta = prevCount != null ? count - prevCount : null;
  const continuity = prevIsYesterday
    ? assessContinuity(coreCodes, prevRow?.coreCodes)
    : { kept: 0, prevCount: 0, overlap: null };
  // 连续达标天数：今日 + 历史中连续满足地板的天数（缺席日按未达标断开）
  const histByDate = new Map(hist.map((h) => [h.tradeDate, h]));
  const flooredSeq =
    recentDates != null
      ? [
          meetsFloor(count, ratio),
          ...recentDates.map((d) => {
            const row = histByDate.get(d);
            return row != null && meetsFloor(row.newHighCount, row.ratio);
          }),
        ]
      : [meetsFloor(count, ratio), ...hist.map((h) => meetsFloor(h.newHighCount, h.ratio))];
  let streakDays = 0;
  for (const ok of flooredSeq) {
    if (!ok) break;
    streakDays += 1;
  }
  // 近端居榜首天数：今日 + 近 LOOKBACK_DAYS 个**交易日**里排名 ≤ TOP_RANK 的天数。
  // 与 streakDays 同样对着交易日日历数：直接取 hist 的前 N 行，会把缺口两侧接起来，
  // 让三周前的几条旧记录冒充「近 5 日」。那天没有快照就是没居首，不能跳过去接下一条。
  const topSeq =
    recentDates != null
      ? [rank, ...recentDates.map((d) => histByDate.get(d)?.rank ?? Number.POSITIVE_INFINITY)]
      : [rank, ...hist.map((h) => h.rank)].slice(0, LOOKBACK_DAYS + 1);
  const topDays = topSeq.filter((rk) => rk <= TOP_RANK).length;
  const wasMainline = hist.some((h) => h.rank <= TOP_RANK);
  const verdict = judge({ count, ratio, rank, prevCount, topDays, wasMainline, continuity });
  const stage = toStage(verdict, wasMainline);
  return { streakDays, topDays, delta, verdict, stage, action: stageAction(stage), continuity };
}

/**
 * 单板块阶段动作（只读最新持久化快照，不现场重跑、不联网）。
 * 供标的计划的板块闸门使用：R3 纪律要求这条链路只读快照，
 * 现场重跑要遍历全部板块成分，绝不能挂在「生成一份标的计划」的路径上。
 * @returns 无快照或该板块当日未入榜时返回 null（由调用方显式标未覆盖，不得当成 none 收紧）
 */
export function boardStageActionOf(
  boardCode: string,
): { action: BoardStageAction; stage: BoardMainlineStage; tradeDate: string } | null {
  const date = getLatestSnapshotDate();
  if (!date) return null;
  const row = listSnapshotsByDate(date).find((r) => r.boardCode === boardCode);
  if (!row) return null;
  const recent = listRecentSnapshots(date, LOOKBACK_DAYS);
  const hist = groupHistory(recent).get(boardCode) ?? [];
  const { stage, action } = assessPersistence(
    row.rank,
    row.newHighCount,
    row.ratio,
    hist,
    row.coreCodes,
    date,
    expectedRecentDates(date, LOOKBACK_DAYS),
  );
  return { action, stage, tradeDate: date };
}

/**
 * 并列第一的上限：超过这么多个板块新高数打平，就没有「主线」可言。
 * 不设上限时 TOP_RANK=1 的独占语义会被悄悄放宽成「所有并列第一」——
 * wasMainline 的命中面跟着变宽，次日它们只要掉出并列第一或环比腰斩就被判 fading → exit_only，
 * 而这是标的计划的板块闸门。
 */
const MAX_TOP_TIES = 3;

/**
 * 竞争排名：新高数相同即并列同名次（1,1,3,4…）。
 * 严格递增序号会让「新高数并列第一、占比低 0.1pt」的板块拿到 rank=2，
 * 在 TOP_RANK=1 口径下它一天都不计入 topDays/wasMainline，PERSIST_TOP_DAYS>=3 永远无法满足。
 * 但并列第一超过 MAX_TOP_TIES 个时视为当日无明确主线，整组降到 TOP_RANK 之外（谁都不给 isTop）。
 * @param countsDesc 已按新高数降序排好的计数序列
 * @returns 与入参等长的名次数组（非递减，后续名次仍按位次给）
 */
export function competitiveRanks(countsDesc: number[]): number[] {
  let tieCount = Number.NaN;
  let tieRank = 0;
  const topTies = countsDesc.filter((c) => c === countsDesc[0]).length;
  const noMainline = topTies > MAX_TOP_TIES;
  return countsDesc.map((count, i) => {
    if (count !== tieCount) {
      tieCount = count;
      tieRank = i + 1;
    }
    return noMainline && tieRank === 1 ? TOP_RANK + 1 : tieRank;
  });
}

/**
 * 今日新高归零的板块是否仍要保留进榜（参与判定并落库）。
 * 只保留「近端曾居榜首」的那几个——它们正处在最该报警的退潮形态；
 * 全市场几百个从未成为主线的零值板块仍然排除，否则响应会被灌爆。
 * @param hist 该板块近端历史快照（新→旧）
 */
export function shouldKeepFadedBoard(hist: BoardBreadthSnapshotRow[]): boolean {
  return hist.some((h) => h.rank <= TOP_RANK);
}

/**
 * 展示/落库截取：先取前 limit 名，再把被截掉的退幕板块补回来。
 * 退幕板块（尤其今日归零的）排在末尾，直接 slice 会连同「只退出」提示一起抹掉，
 * 而持仓还在里面的人恰恰只需要这一条。
 */
export function takeWithFading<T extends { stage: BoardMainlineStage }>(
  items: T[],
  limit: number,
): T[] {
  return [...items.slice(0, limit), ...items.slice(limit).filter((it) => it.stage === 'fading')];
}

/** 近端快照集里实际存在的 distinct 交易日（新→旧），作为连续达标天数的对齐基准 */
/**
 * 「本该有快照」的近 n 个交易日（新→旧，不含当日）。
 *
 * 连续性判定必须对着这个日历数，不能对着库里实际存在的日期数。
 * 快照整天没跑时，实际日期序列会把缺口两侧直接接起来——
 * 实测库里存在 8-06 之后直接断到 8-28 的情况，按实际日期算会把三周前的
 * 三条记录报成「连续达标 3 日」。对着日历数则缺席那天查不到行，链条自然断开。
 */
function expectedRecentDates(tradeDate: string, n: number): string[] {
  const out: string[] = [];
  let cursor = tradeDate;
  for (let i = 0; i < n; i += 1) {
    cursor = prevTradingDay(cursor);
    out.push(cursor);
  }
  return out;
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
 *  - 否则达标 + 居首 + 确认门槛 + 持续 + 核心股延续 → 确认；
 *  - 否则达标 → 候选；其余未达标。
 */
function judge(args: {
  count: number;
  ratio: number;
  rank: number;
  prevCount: number | null;
  topDays: number;
  wasMainline: boolean;
  continuity: CoreContinuity;
}): BoardBreadthVerdict {
  const { count, ratio, rank, prevCount, topDays, wasMainline, continuity } = args;
  const isTop = rank <= TOP_RANK;
  const floored = meetsFloor(count, ratio);

  // 退潮：之前是主线/居首，如今掉地板、跌出榜首、或新高数较昨腰斩
  if (wasMainline) {
    const halved = prevCount != null && prevCount > 0 && count <= prevCount * (1 - FADE_DROP_PCT / 100);
    if (!floored || !isTop || halved) return 'fading';
  }
  if (!floored) return 'none';
  // 核心股换了一批（重叠率不足）→ 只能是候选，不给确认：数量还在但换了主力，属于轮动噪声而非资金聚焦
  const continued = continuity.overlap == null || continuity.overlap >= CORE_CONTINUITY_MIN;
  if (meetsConfirm(count, ratio) && isTop && topDays >= PERSIST_TOP_DAYS && continued) return 'confirmed';
  return 'candidate';
}

/**
 * 组装板块新高宽度总览（确定性只读 + 落库当日快照供持续性判定）。
 *
 * @param persist 是否写入当日快照。默认 false：落库只由收盘任务负责。
 *   页面/agent 的随机时点访问一旦落库，盘中会把半天的部分计数写成当日定盘值，
 *   周末/节假日更会写出「非交易日快照」——它会挤占 listRecentSnapshots 的最近 5 个交易日窗口，
 *   并让周一的 prevIsYesterday 恒为 false（核心股延续度永久停在「待积累」）。
 *   传 true 时仍会再过一道交易日闸门，非交易日一律不写。
 */
export async function buildBreadthOverview(persist = false): Promise<BoardBreadthOverview> {
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
  const raw: RawCount[] = newHighSet.size === 0 || boards.length === 0
    ? []
    : (
        await mapLimit(boards, FETCH_CONCURRENCY, async (meta): Promise<RawCount | null> => {
          await jitterDelay(FETCH_JITTER_MS); // 错峰发包，降低对 push2 的瞬时 req/s
          const cons = await fetchBoardConstituents(meta.kind, meta.name).catch(() => [] as string[]);
          if (cons.length === 0) return null; // 成分取数失败/为空：这是数据缺失，不是「真的 0 只新高」，不参与排名
          // 记下「哪些股在创新高」而不只是「几只在创新高」：跨日确认要比对是不是同一批股
          const hits = cons.filter((code) => newHighSet.has(code)).sort();
          const newHighCount = hits.length;
          const consTotal = cons.length;
          const ratio = consTotal > 0 ? (newHighCount / consTotal) * 100 : 0;
          return { meta, newHighCount, consTotal, ratio, coreCodes: hits.slice(0, CORE_CODES_CAP) };
        })
      ).filter((x): x is RawCount => x != null);

  // 4) 历史快照（近 LOOKBACK_DAYS 交易日）按 boardCode 分组（新→旧）
  const recentSnapshots = listRecentSnapshots(tradeDate, LOOKBACK_DAYS);
  const histByBoard = groupHistory(recentSnapshots);
  // 对着交易日日历取近端日期，而不是库里实际存在的日期——缺口不得被跳过
  const recentDates = expectedRecentDates(tradeDate, LOOKBACK_DAYS);

  // 5) 排名池：当日有新高的板块。新高数降序，平手按占比降序，
  //    但名次用竞争排名（并列同名次 1,1,3）——按序号严格递增时，「新高数并列第一、占比低 0.1pt」
  //    的板块会拿到 rank=2，在 TOP_RANK=1 口径下一天都不计入 topDays，PERSIST_TOP_DAYS 永远达不到。
  const active = raw.filter((c) => c.newHighCount > 0);
  active.sort((a, b) => b.newHighCount - a.newHighCount || b.ratio - a.ratio);
  const ranks = competitiveRanks(active.map((c) => c.newHighCount));
  const rankByCode = new Map(active.map((c, i) => [c.meta.code, ranks[i]]));

  // 6) 退幕补入：历史上曾居榜首、今日新高归零的板块。整条丢弃的话「昨日 30 只、今日 0 只」
  //    这个最该报警的退潮形态既进不了榜也不落库，judge 的 fading 分支永远拿不到当日记录，
  //    次日 hist[0] 还会变成两天前的行导致延续性判定失真；持仓者也就看不到「只退出」提示。
  //    普通零值板块（全市场几百个）仍然排除，只补曾是主线的那几个。
  const fadedOut = raw.filter(
    (c) => c.newHighCount === 0 && shouldKeepFadedBoard(histByBoard.get(c.meta.code) ?? []),
  );
  // 归零板块统一给排名池之后的名次（不占用真实名次，也保证 isTop 为假）
  const outRank = active.length + 1;
  for (const c of fadedOut) rankByCode.set(c.meta.code, outRank);
  const counts = [...active, ...fadedOut];

  // 7) 逐项算持续性 + 判定 + 映射 ETF
  const items: BoardBreadthItem[] = counts.map((c) => {
    const rank = rankByCode.get(c.meta.code) ?? outRank;
    const { streakDays, topDays, delta, verdict, stage, action, continuity } = assessPersistence(
      rank,
      c.newHighCount,
      c.ratio,
      histByBoard.get(c.meta.code) ?? [],
      c.coreCodes,
      tradeDate,
      recentDates,
    );

    const deltaText = delta == null ? '' : `·较昨${delta >= 0 ? '+' : ''}${delta}`;
    const contText =
      continuity.overlap == null
        ? '·核心股延续待积累'
        : `·核心股延续 ${continuity.kept}/${continuity.prevCount}`;
    const note =
      `新高 ${c.newHighCount} 只（占比 ${r1(c.ratio)}%）·当日第 ${rank} 名` +
      `·近${LOOKBACK_DAYS}日居首 ${topDays} 日${deltaText}${contText}` +
      `·【${STAGE_LABEL[stage]} → ${STAGE_ACTION_LABEL[action]}】`;

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
      stage,
      stageAction: action,
      continuity,
      etf: mapBoardEtf(c.meta.name),
      note,
    };
  });

  // 8) 落库（仅当有真实计数；按上限截取，控制每日行数）
  // 时刻与完整性两道门见 canPersistSnapshot 的说明：宁可这天没有快照，
  // 也不要一份「看起来是当日定盘值、其实是半天或缺数据」的行——后者事后无从分辨
  if (persist) {
    const gate = canPersistSnapshot('breadth');
    if (!gate.ok) throw new Error(gate.reason);
    if (stale) {
      throw new Error('创新高或板块成分没取全，本次不写快照，保留上一份');
    }
    if (items.length === 0) {
      throw new Error('今日没有任何板块计数，本次不写快照');
    }
  }
  if (persist && items.length > 0) {
    const coreByCode = new Map(counts.map((c) => [c.meta.code, c.coreCodes]));
    upsertSnapshots(
      takeWithFading(items, Math.max(MAX_BOARDS, 60)).map((it) => ({
        tradeDate,
        boardCode: it.boardCode,
        boardName: it.boardName,
        kind: it.kind as BoardKind,
        newHighCount: it.newHighCount,
        consTotal: it.consTotal,
        ratio: it.ratio ?? 0,
        rank: it.rank,
        coreCodes: coreByCode.get(it.boardCode) ?? [],
      })),
    );
  }

  const mainlines = items.filter((it) => it.stage === 'advancing');

  return {
    asOf: nowIso(),
    tradeDate,
    window: WINDOW,
    marketNewHighTotal: newHighSet.size,
    items: takeWithFading(items, MAX_BOARDS),
    mainlines,
    note:
      '板块创新高表现（主线识别，按规则计算，仅供参考，不构成投资建议）：' +
      `按板块内${WINDOW}个股数横向排名，"最多且持续多日稳居榜首、且核心股跨日延续"判定主线。` +
      '阶段（酝酿/主升/分歧/退幕）只用于收紧动作（该不该开新仓、是否只减不加），不用于放大仓位。' +
      (stale ? '⚠️ 创新高/板块成分没取到，榜为不完整估计（请到数据源页检查 AKShare 配置）。' : ''),
    stale,
  };
}

/** 一个能映射到代表 ETF 的板块及其成分 */
export interface EtfBoard {
  kind: BoardKind;
  boardCode: string | null;
  boardName: string;
  etf: { code: string; name: string };
  codes: string[];
}

/**
 * 「有代表 ETF 的赛道」全集：板块 + 成分股。
 *
 * 这是历史新高回补的取数范围。为什么只覆盖这一批而不是全市场：
 * 板块新高宽度原本靠同花顺创新高榜，那个接口只返回「此刻」，没有日期参数，
 * 所以历史必须自己从 K 线算——而自算要求先有该板块全部成分的日线。
 * 全市场几百个板块的成分并集约等于整个 A 股，日线量级不现实；
 * 而你的打法是先用 ETF 锁赛道，能落到 ETF 的这几十个板块才是真正会下单的范围。
 *
 * 覆盖的是**全部**能映射到 ETF 的板块，不是「今天进了前 60 名」的那几个——
 * 否则光伏、军工热的那天照样没有历史可比。
 */
export async function etfBoardUniverse(): Promise<{ boards: EtfBoard[]; codes: string[] }> {
  const kinds: BoardKind[] = ['industry', 'concept'];
  const metas: Array<{ kind: BoardKind; meta: BoardMeta; etf: { code: string; name: string } }> = [];
  for (const kind of kinds) {
    const list = await fetchBoards(kind).catch(() => [] as BoardMeta[]);
    for (const meta of list) {
      if (isJunkBoard(meta.name)) continue;
      const etf = mapBoardEtf(meta.name);
      if (etf) metas.push({ kind, meta, etf });
    }
  }
  const boards: EtfBoard[] = [];
  const all = new Set<string>();
  // 成分接口有 6h 缓存，但首次仍是几十次请求，限并发避免打爆 aktools
  await mapLimit(metas, 4, async ({ kind, meta, etf }) => {
    const codes = await fetchBoardConstituents(kind, meta.name).catch(() => [] as string[]);
    if (codes.length === 0) return;
    boards.push({ kind, boardCode: meta.code ?? null, boardName: meta.name, etf, codes });
    for (const c of codes) all.add(c);
  });
  boards.sort((a, b) => a.boardName.localeCompare(b.boardName));
  return { boards, codes: [...all].sort() };
}

/** 富集后的板块行：快照原始计数 + 阶段/动作/持续性判定 + 代表 ETF */
export type BoardStageRow = BoardBreadthSnapshotRow &
  ReturnType<typeof assessPersistence> & { etf: { code: string; name: string } | null };

/**
 * 读最新快照并补齐阶段判定（纯本地 DB 读，不现场重跑、不联网）。
 *
 * 现场重跑要遍历全部板块成分、实测约 4 分钟，绝不能挂在驾驶舱这种要秒开的路径上。
 * 与 formatBreadthForPlan 共用同一份富集逻辑：两处各写一份的话，
 * 计划底稿说某板块在主升、驾驶舱说它在酝酿，同一天两个结论。
 */
export function listBoardStagesFromSnapshot(): { date: string; rows: BoardStageRow[] } | null {
  const date = getLatestSnapshotDate();
  if (!date) return null;
  const rows = listSnapshotsByDate(date);
  if (rows.length === 0) return { date, rows: [] };
  const histByBoard = groupHistory(listRecentSnapshots(date, LOOKBACK_DAYS));
  const recentDates = expectedRecentDates(date, LOOKBACK_DAYS);
  return {
    date,
    rows: rows.map((r) => ({
      ...r,
      ...assessPersistence(
        r.rank,
        r.newHighCount,
        r.ratio,
        histByBoard.get(r.boardCode) ?? [],
        r.coreCodes,
        date,
        recentDates,
      ),
      etf: mapBoardEtf(r.boardName),
    })),
  };
}

/**
 * 今日计划底稿：读「最新一份持久化板块新高快照」格式化为确定性文本块（不现场重跑，与情绪/复盘等源一致）。
 * 计划 agent 据此把"哪个板块新高最多且持续"作为主线判断的确定性证据之一。无快照时显式说明，由上层据时效降权。
 */
export function formatBreadthForPlan(): string {
  const snap = listBoardStagesFromSnapshot();
  if (!snap) {
    return '【板块新高宽度·最新】无快照（板块新高模块未启用或未落库；到调度页启用「收盘快照」后次日起可用）。';
  }
  const { date, rows: enriched } = snap;
  if (enriched.length === 0) return '【板块新高宽度·最新】无快照数据。';
  const mains = enriched.filter((e) => e.stage === 'advancing');
  const top = enriched.slice(0, 8);

  const fresh = date === shanghaiToday() ? '' : `（${date}，非当日产出，注意时效）`;
  const lines: string[] = [
    `【板块创新高表现·最新】${fresh}（按${WINDOW}统计，板块内创新高个股数横向排名；"最多且持续多日稳居榜首、且核心股跨日延续"判主线，按规则计算）`,
    '阶段硬路由：酝酿=可试仓 / 主升=可追领涨 / 分歧=只减不加 / 退幕=只退出。阶段只收紧不放大仓位。',
  ];
  if (mains.length > 0) {
    lines.push(
      '确认主线（主升）：' +
        mains
          .map(
            (m) =>
              `${m.boardName}(新高${m.newHighCount}/占比${r1(m.ratio)}%·居首${m.topDays}日·核心股延续${m.continuity.overlap == null ? '待积累' : `${m.continuity.kept}/${m.continuity.prevCount}`}${m.etf ? `→${m.etf.name}${m.etf.code}` : ''})`,
          )
          .join('；'),
    );
  } else {
    lines.push('确认主线：暂无（无板块稳居榜首足够天数、核心股未跨日延续，或市场处于冰点/普跌）。');
  }
  const brewing = enriched.filter((e) => e.stage === 'brewing').slice(0, 4);
  const fadingList = enriched.filter((e) => e.stage === 'fading').slice(0, 4);
  if (brewing.length > 0) {
    lines.push('酝酿中(仅可试仓)：' + brewing.map((m) => `${m.boardName}(新高${m.newHighCount})`).join('  '));
  }
  if (fadingList.length > 0) {
    lines.push('退幕(只退出)：' + fadingList.map((m) => `${m.boardName}(新高${m.newHighCount})`).join('  '));
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
    `【中长期主线·板块创新高表现】${fresh}（按${WINDOW}统计，回看约${windowDays}个交易日；"这段时间里多数日子都排在前${MID_TOP_RANK}名"判定中长期主线，按规则计算，仅供参考）`,
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
