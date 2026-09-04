import type {
  BoardExposure,
  CockpitAction,
  CockpitActionEmptyReason,
  CockpitActionKind,
  CockpitActionPlan,
  CockpitActionPriority,
  DailyPlanDetail,
  DisciplinePositionItem,
  DisciplineReport,
  CockpitScreenerPick,
  EtfRotationOverview,
  PlanTrigger,
  SourceFreshness,
} from '@stock-agent/shared';
import { PLAN_TRIGGER_UNKNOWN_TEXT } from '@stock-agent/shared';
import { evaluateDiscipline } from '../positions/discipline';
import { computeBoardExposure } from '../boards/exposure';
import { isJunkBoard, listBoardStagesFromSnapshot, type BoardStageRow } from '../breadth/service';
import { buildScreenerPicks } from './service';
import { getTodayDetail, lastTriggerHitOf } from '../plan/service';
import { buildRotationOverview } from '../rotation/service';
import { cached, peek } from '../lib/ttlCache';
import { isAShareTradingTime, nowIso, shanghaiToday } from '../util';
import { isTradingDay } from '../market/calendar';
import { judgeFreshness, summarizeFreshness } from './freshness';
import { applyLiveOverlay, fetchLivePrices } from './liveOverlay';

// 今日动作清单：把散在各模块的结论合成一份「按顺序做这几件事」。
//
// 这一层是驾驶舱重构的核心，也是最容易把人带沟里的地方，所以约束写在最前面：
//
// 【只读原始数据】不读 cockpit/panorama.ts 的展示摘要。那些摘要为了一屏可读做了两件事——
//   截断到 5 条、把纪律的 advice 换成减仓股数——都会让动作层漏掉或读错真实风险。
//
// 【按不做的代价排序】不按收益排。错过一个买点是机会成本，止损没执行是真金白银的亏损。
//   所以「计划已触发」不能笼统算 P0：触发的是买点还是止损，是机会还是风险，天差地别。
//
// 【不猜】触发原因没记录就说没记录，板块判断有分歧就说有分歧，数据过期就说过期。
//   这层的产出会被直接照做，猜错一次的代价远大于少说一句。

/**
 * 各来源产出的动作草稿：不带实时字段。
 *
 * 实时价是统一在最后一步批量叠上去的（一次取数覆盖所有标的），
 * 让每个来源自己去取会把一次批量请求拆成好几次。
 * 只有 `distanceTo`（拿哪条线算距离）由来源自己决定——它知道这条动作在盯什么价。
 */
type ActionDraft = Omit<CockpitAction, 'live' | 'distancePct' | 'distanceTo'> &
  Partial<Pick<CockpitAction, 'distanceTo'>>;

/** 补齐实时字段的默认值。实时价与距离由 applyLiveOverlay 之后填 */
function act(d: ActionDraft): CockpitAction {
  return { ...d, live: null, distancePct: null, distanceTo: d.distanceTo ?? null };
}

/**
 * P1 及以下每档的展示上限。P0 不受限——风险项一条都不能被折叠掉。
 *
 * 机会区扩到四类来源后调到 10：按类型各限 KIND_CAP 条，总额要留得下几类共存，
 * 否则按类型限额就白设了。
 */
const TIER_CAP = 10;

/** 各优先级的排序权重 */
const PRIORITY_ORDER: Record<CockpitActionPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** P2 内部按「现在能不能执行」再分档：可执行 → 正在接近 → 还要人筛 */
const READINESS_ORDER = { actionable: 0, approaching: 1, screening: 2, blocked: 3 };

/** ETF 优先于个股：用户的打法是先锁赛道再选龙头，赛道级动作先看 */
const isEtf = (code: string): boolean => /^(15|51|56|58|folder)/.test(code);

function mkId(kind: CockpitActionKind, code: string | null, from: string): string {
  return `${shanghaiToday()}:${code ?? '-'}:${kind}:${from}`;
}

/**
 * 买点该往哪个方向算「已越过」。
 *
 * `breakout` 是向上突破买入，价格涨过买点才算到位；
 * `pullback` / `price` 是回落到位买入，价格跌到买点才算到位。
 * 方向搞反的话，一个还差 3% 才回踩到位的票会显示「已越过买点」——
 * 看起来像错过了机会，实际正相反。
 */
function buyDistanceTo(t: PlanTrigger): { label: string; price: number; cross: 'below' | 'above' } {
  return { label: '买点', price: t.value, cross: t.type === 'breakout' ? 'above' : 'below' };
}

/** 纪律条目 → 动作。只认结构化的 status 枚举与 sizing 股数，不解析 advice 文本 */
function fromDiscipline(r: DisciplineReport, dataAt: string | null): ActionDraft[] {
  const out: ActionDraft[] = [];
  for (const i of r.items) {
    if (i.status === 'healthy') continue;
    // 止损价由成本与生效止损比例反算。有了它，「离止损还有多远」才是个实时的数，
    // 而不是一句「注意风险」
    const stopPrice =
      i.avgCost > 0 && i.rule.stopLossPct > 0
        ? Math.round(i.avgCost * (1 - i.rule.stopLossPct / 100) * 1000) / 1000
        : null;
    const base = {
      code: i.code,
      name: i.name,
      blockedReason: null,
      evidence: [{ label: '持仓与纪律', route: '/positions', anchor: 'discipline' }],
      basisSources: [] as string[],
      dataAt,
      distanceTo: stopPrice != null ? { label: '止损线', price: stopPrice, cross: 'below' as const } : null,
    };
    // 止损未执行 / 已破止损：P0。这是唯一「不做就直接亏钱」的一类
    if (i.status === 'stop_loss' || i.status === 'stop_not_executed') {
      out.push({
        ...base,
        id: mkId('stop_loss', i.code, 'discipline'),
        priority: 'P0',
        kind: 'stop_loss',
        readiness: 'actionable',
        what: sharesText(i) ?? '按纪律止损离场',
        when: i.status === 'stop_not_executed' ? '已经该走还没走，尽快处理' : '今天内',
        why:
          i.status === 'stop_not_executed'
            ? `之前触发过止损但还持有着，浮动 ${pct(i.holdRate)}`
            : `已跌破止损线，浮动 ${pct(i.holdRate)}`,
      });
      continue;
    }
    if (i.status === 'near_stop') {
      out.push({
        ...base,
        id: mkId('near_stop', i.code, 'discipline'),
        priority: 'P1',
        kind: 'near_stop',
        readiness: 'approaching',
        what: '想好跌破了走不走，别到时候临时改主意',
        when: '盘中盯着',
        why: `离止损线不远了，浮动 ${pct(i.holdRate)}`,
      });
      continue;
    }
    if (i.status === 'overweight') {
      out.push({
        ...base,
        id: mkId('overweight', i.code, 'discipline'),
        priority: 'P1',
        kind: 'overweight',
        readiness: 'actionable',
        what: sharesText(i) ?? `仓位 ${pct(i.positionRate)} 超了上限，减到上限内`,
        when: '今天内',
        why: overweightWhy(i),
      });
    }
  }
  return out;
}

/**
 * 超配的理由要引对上限。
 *
 * 这里有两个不同的上限，引错会写出「仓位 6.3%，超过 40% 的上限」这种自相矛盾的话：
 * - `sizing.allowedWeightPct` 是风险预算按止损距离反推的，通常远小于固定上限，多数超配都是它触发的
 * - `rule.singleMaxWeightPct` 是用户配的固定上限，只在风险预算没算出来时兜底
 * 判定顺序与 discipline.ts 一致：有 reduceShares 就是前者。
 */
function overweightWhy(i: DisciplinePositionItem): string {
  if (i.sizing && i.sizing.reduceShares > 0) {
    return (
      `按当前风险预算，这票最多只该拿 ${i.sizing.allowedWeightPct}%，` +
      `现在 ${pct(i.positionRate)}（止损距离越远，能拿的越少）`
    );
  }
  return `单票仓位 ${pct(i.positionRate)}，超过你设的 ${i.rule.singleMaxWeightPct}% 上限`;
}

/** 有具体股数就给股数——「减 1200 股」比「注意仓位」可执行得多 */
function sharesText(i: DisciplinePositionItem): string | null {
  if (!i.sizing || i.sizing.reduceShares <= 0) return null;
  return `减 ${i.sizing.reduceShares} 股（留到 ${i.sizing.allowedShares} 股以内）`;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/**
 * 板块退潮 → 减仓提示。
 *
 * 三条限制：只看真实持仓（自选没有仓位，谈不上减）、板块判断有分歧时只提示不建议、
 * 快照过期时降级为观察。板块阶段是日频判断，拿它驱动动仓位本就该保守。
 */
function fromBoards(ex: BoardExposure): ActionDraft[] {
  if (ex.snapshotDate == null) return [];
  const out: ActionDraft[] = [];
  for (const h of ex.holdings) {
    // 自选不是仓位，列成减仓动作会让人去减一个根本没持有的票
    if (h.account !== 'real') continue;
    if (h.status !== 'fading') continue;
    const fadingNames = h.boards.map((b) => b.boardName).join('、');
    if (h.conflict) {
      // 同时还在另一条主线里：可能正在切换赛道，减掉的也许是刚起来的那条
      out.push({
        id: mkId('observe', h.code, 'board-conflict'),
        priority: 'P3',
        kind: 'observe',
        readiness: 'screening',
        code: h.code,
        name: h.name,
        what: '自己看一眼它到底跟着哪条线走',
        when: '不急',
        why: `它同时在退潮和还在走的两类板块里（${fadingNames}），板块判断有分歧，不好一刀切`,
        blockedReason: null,
        evidence: [{ label: '持仓关联板块', route: '/market', anchor: 'board-exposure' }],
        basisSources: [],
        dataAt: ex.snapshotDate,
      });
      continue;
    }
    out.push({
      id: mkId('board_fading', h.code, 'boards'),
      priority: ex.stale ? 'P3' : 'P1',
      kind: ex.stale ? 'observe' : 'board_fading',
      readiness: ex.stale ? 'screening' : 'approaching',
      code: h.code,
      name: h.name,
      what: ex.stale ? '先确认板块判断还成立，再决定要不要减' : '考虑减一部分，别等板块彻底走完',
      when: ex.stale ? '不急' : '今天内想清楚',
      why: `所在板块（${fadingNames}）已经退潮`,
      blockedReason: null,
      evidence: [{ label: '持仓关联板块', route: '/market', anchor: 'board-exposure' }],
      basisSources: [],
      dataAt: ex.snapshotDate,
    });
  }
  return out;
}

/**
 * 今日计划 → 动作。
 *
 * 关键分叉：`status='triggered'` 只说明「触发过」，触发的是买点还是止损要看事件载荷。
 * 载荷里没记（老数据）时不猜，标成待人工确认——猜成止损会凭空生成一条卖出建议。
 */
function fromPlan(detail: DailyPlanDetail, dataAt: string | null): ActionDraft[] {
  const out: ActionDraft[] = [];
  for (const it of detail.items) {
    if (it.status === 'done' || it.status === 'invalid') continue;
    const ev = [{ label: '今日计划', route: '/plan', anchor: `plan-${it.code}` }];
    if (it.status === 'triggered') {
      const hit = lastTriggerHitOf(detail.plan.id, it.id);
      const kind = hit?.triggerKind ?? null;
      if (kind === 'stop_loss') {
        out.push({
          id: mkId('stop_loss', it.code, 'plan'),
          priority: 'P0',
          kind: 'stop_loss',
          readiness: 'actionable',
          code: it.code,
          name: it.name,
          // 拿止损价当参照：破了多少、还是又拉回去了，只有跟现价比才知道
          distanceTo: it.stopLoss
            ? { label: '止损位', price: it.stopLoss.value, cross: 'below' as const }
            : null,
          what: `计划的止损位 ${hit?.triggerValue ?? '—'} 已经破了，按计划走`,
          when: '尽快',
          why: hit?.note || '盘中触发了计划里的止损条件',
          blockedReason: null,
          evidence: ev,
          basisSources: [],
          dataAt: hit?.triggeredAt ?? dataAt,
        });
        continue;
      }
      if (kind === 'buy') {
        out.push({
          id: mkId('buy_triggered', it.code, 'plan'),
          priority: 'P2',
          kind: 'buy_triggered',
          readiness: 'actionable',
          code: it.code,
          name: it.name,
          distanceTo: it.buyTrigger ? buyDistanceTo(it.buyTrigger) : null,
          what: `买点 ${hit?.triggerValue ?? '—'} 已触发，按计划仓位买入：${it.positionHint}`,
          when: '今天内，过了就算了',
          why: it.thesis,
          blockedReason: null,
          evidence: ev,
          basisSources: [],
          dataAt: hit?.triggeredAt ?? dataAt,
        });
        continue;
      }
      // take_profit / sell / null 都归到这里：止盈与卖出该不该执行取决于人怎么看后市，
      // 原因没记录的更不能替人决定
      out.push({
        id: mkId('observe', it.code, 'plan-triggered'),
        priority: 'P2',
        kind: 'observe',
        readiness: 'screening',
        code: it.code,
        name: it.name,
        what: kind ? '计划条件已到，自己确认要不要执行' : `${PLAN_TRIGGER_UNKNOWN_TEXT}，去计划页看一眼`,
        when: '今天内',
        why: hit?.note || it.thesis,
        blockedReason: null,
        evidence: ev,
        basisSources: [],
        dataAt: hit?.triggeredAt ?? dataAt,
      });
      continue;
    }
    // pending：只有买点能算「临近」。止损的临近由纪律模块用真实持仓判，那边准
    if (it.buyTrigger) {
      out.push({
        id: mkId('near_buy', it.code, 'plan'),
        priority: 'P2',
        kind: 'near_buy',
        readiness: 'approaching',
        code: it.code,
        name: it.name,
        // 「临近买点」这条动作的全部价值就在距离上，没有实时距离它等于一句废话
        distanceTo: buyDistanceTo(it.buyTrigger),
        what: `等 ${it.buyTrigger.value} 附近再动手，仓位 ${it.positionHint}`,
        when: `盘中触及 ${it.buyTrigger.value} 时`,
        why: it.thesis,
        blockedReason: null,
        evidence: ev,
        basisSources: [],
        dataAt,
      });
    }
  }
  return out;
}

/** 板块机会最多列这么多条，再多就把清单淹了 */
const BOARD_OPP_CAP = 4;

/**
 * 板块机会：哪些板块现在有戏，以及该在里面做什么。
 *
 * 之前这块只用了退潮那一侧（叫你减仓），主升与酝酿的板块一条都不露出——
 * 于是「今天哪里有机会」这个问题在驾驶舱里根本没有答案。
 *
 * 阶段决定允许的动作，是硬路由且只收紧不放大：
 * 主升可以追领涨，酝酿只够小仓试错。分歧与退潮不进机会区。
 * 每条尽量带上代表 ETF——先用 ETF 锁赛道、再在赛道内下钻选龙头，这是你的打法。
 */
function fromBoardOpportunities(
  snap: { date: string; rows: BoardStageRow[] },
  stale: boolean,
): ActionDraft[] {
  const hot = snap.rows
    .filter((r) => r.stage === 'advancing' || r.stage === 'brewing')
    // 平台自造的聚合桶（热股、题材股这类）成分每天换一批，
    // 「热股里有 12 只创新高」说明不了任何赛道在走强，却会挤掉真板块的位置。
    // 这里再滤一道是因为历史快照里已经存了它们，光改产出侧的过滤等不到今天生效
    .filter((r) => !isJunkBoard(r.boardName))
    // 主升排在酝酿前；同阶段按当日新高排名
    .sort(
      (a, b) =>
        Number(b.stage === 'advancing') - Number(a.stage === 'advancing') || a.rank - b.rank,
    )
    .slice(0, BOARD_OPP_CAP);

  /**
   * 上一交易日有没有快照。
   *
   * 没有的话，所有板块的「连续达标天数」都会重新从 1 开始——那是缺历史，不是刚起来。
   * 把它说成「刚起来，可以小仓试」等于凭空造了一个入场理由。
   */
  const hasHistory = snap.rows.some((r) => r.streakDays > 1);

  return hot.map((r) => {
    const leading = r.stage === 'advancing';
    const etfText = r.etf ? `，代表 ETF ${r.etf.name}(${r.etf.code})` : '';
    return {
      id: mkId(leading ? 'board_leading' : 'board_brewing', r.boardCode, 'breadth'),
      priority: 'P2' as const,
      kind: leading ? ('board_leading' as const) : ('board_brewing' as const),
      // 板块判断是日频的，永远算「正在接近」而不是「现在就执行」——
      // 它告诉你往哪看，不告诉你此刻该下单
      readiness: 'approaching' as const,
      // 用代表 ETF 的代码，这样卡片能直接点开看行情；没有映射就不给代码
      code: r.etf?.code ?? null,
      name: r.etf?.name ?? r.boardName,
      what: leading
        ? `${r.boardName} 在主升，可以追领涨${etfText}`
        : hasHistory
          ? `${r.boardName} 刚起来，只够小仓试${etfText}`
          : `${r.boardName} 今天新高多，但没有前几天的数据可比${etfText}`,
      when: stale ? '先确认这个判断还成立' : '今天内',
      why:
        `板块内 ${r.newHighCount} 只创新高、当日排第 ${r.rank}` +
        (hasHistory
          ? `，已连续 ${r.streakDays} 天达标、近端居首 ${r.topDays} 天`
          : // 缺历史时不能报「连续 1 天」——那个 1 是没得比出来的，不是走了一天
            '。前几个交易日的快照缺失，持续性还看不出来，明后天才有得比'),
      blockedReason: null,
      evidence: [{ label: '板块新高宽度', route: '/market', anchor: 'breadth' }],
      basisSources: [],
      // 标明这是哪天收盘算出来的，不能读成刚刚算的
      dataAt: snap.date,
    };
  });
}

/**
 * 选股候选 → 具体标的。
 *
 * 这一类此前只在页面底部作为只读速览存在，没进动作清单，
 * 所以「今天有哪些股票值得看」得自己翻到最下面去找。
 */
function fromScreener(picks: CockpitScreenerPick[], dataAt: string | null): ActionDraft[] {
  return picks.slice(0, 5).map((p) => ({
    id: mkId('candidate', p.code, 'screener'),
    priority: 'P2' as const,
    kind: 'candidate' as const,
    // 选股结果还要人筛：确定性打分只说明它符合条件，不代表现在该买
    readiness: 'screening' as const,
    code: p.code,
    name: p.name,
    what: `第 ${p.rank} 名候选，自己看一眼要不要进计划`,
    when: '不急，盘前定计划时用',
    why:
      p.thesis ??
      `选股打分 ${p.screenScore}${p.confidence != null ? `，模型信心 ${p.confidence}` : ''}`,
    blockedReason: null,
    evidence: [{ label: '系统选股', route: '/screener' }],
    basisSources: [],
    dataAt,
  }));
}

/** ETF 轮动 → 换仓机会。赛道级动作，排在同档个股前面 */
function fromRotation(r: EtfRotationOverview, dataAt: string | null): ActionDraft[] {
  return r.items.slice(0, 3).map((p) => {
    // 「从这里挑」等于没说。要么给出这只 ETF 现在处在什么状态、该怎么对待，
    // 要么就别占一行——机会区的价值全在具体
    const track = p.track ? `${p.track}赛道` : '该赛道';
    const rs = p.rs != null ? `跑赢沪深300 ${p.rs.toFixed(1)}%` : '相对强弱未知';
    return {
      id: mkId('rotate', p.code, 'rotation'),
      priority: 'P2' as const,
      kind: 'rotate' as const,
      readiness: 'approaching' as const,
      code: p.code,
      name: p.name,
      what: `${track}目前最强的是它，想加赛道仓位就看这只`,
      when: '不急，等回踩再动手',
      why:
        `轮动强度 ${p.score}／100，${rs}` +
        (p.ret60 != null ? `，近 60 日 ${p.ret60 > 0 ? '+' : ''}${p.ret60.toFixed(1)}%` : '') +
        (p.premiumPct != null && Math.abs(p.premiumPct) >= 1
          ? `。注意溢价 ${p.premiumPct.toFixed(1)}%，别追高买贵`
          : ''),
      blockedReason: null,
      evidence: [{ label: 'ETF 轮动', route: '/etf', anchor: 'rotation' }],
      basisSources: [],
      dataAt,
    };
  });
}

/**
 * 同一标的多条动作合并成一条。
 *
 * 为什么必须合：同一只票可能同时出现在「止损」和「买点已触发」里（计划想加仓、纪律要止损）。
 * 两条并列摆着，用户按顺序读会先看到止损、再看到买入，很容易两条都做。
 *
 * 合并规则：**风险压过增仓**（保留优先级最高那条），理由合并起来一起说，
 * **股数绝不相加**——两条各自算出的股数是对同一批持仓的两种处置，加起来会卖超。
 */
function mergeByCode(actions: CockpitAction[]): CockpitAction[] {
  const byCode = new Map<string, CockpitAction[]>();
  const noCode: CockpitAction[] = [];
  for (const a of actions) {
    if (!a.code) {
      noCode.push(a);
      continue;
    }
    byCode.set(a.code, [...(byCode.get(a.code) ?? []), a]);
  }
  const merged: CockpitAction[] = [];
  for (const group of byCode.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    const sorted = [...group].sort(
      (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
        READINESS_ORDER[a.readiness] - READINESS_ORDER[b.readiness],
    );
    const win = sorted[0];
    const others = sorted.slice(1);
    merged.push({
      ...win,
      // 只留胜出那条的 what（股数不相加），其余降级成理由里的一句话
      why: `${win.why}。另外还有：${others.map((o) => o.why).join('；')}`,
      evidence: dedupeEvidence([...win.evidence, ...others.flatMap((o) => o.evidence)]),
      basisSources: [...new Set([...win.basisSources, ...others.flatMap((o) => o.basisSources)])],
    });
  }
  return [...merged, ...noCode];
}

function dedupeEvidence(list: CockpitAction['evidence']): CockpitAction['evidence'] {
  const seen = new Set<string>();
  return list.filter((e) => {
    const k = `${e.route}#${e.anchor ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 排序：优先级 → 能否执行 → ETF 优先于个股 → 代码，最后一项只为结果稳定 */
function sortActions(list: CockpitAction[]): CockpitAction[] {
  return [...list].sort(
    (a, b) =>
      PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
      READINESS_ORDER[a.readiness] - READINESS_ORDER[b.readiness] ||
      Number(isEtf(b.code ?? '')) - Number(isEtf(a.code ?? '')) ||
      (a.code ?? '').localeCompare(b.code ?? ''),
  );
}

/**
 * P0 永不截断；其余按**类型**分别限额。
 *
 * 风险项一条都不能被折叠掉——「还有 3 项风险没显示」这种界面等于没提醒。
 *
 * 机会项改成按类型限额而不是整档一个总数：机会区现在有板块、轮动、选股、计划买点四类，
 * 用一个总额会让排在前面的那类把配额吃光（板块排序靠前，能把选股整类挤没），
 * 于是「今天有哪些股票值得看」又变成没有答案。每类各留几条，才谈得上「更明确」。
 */
const KIND_CAP = 4;

function capTiers(list: CockpitAction[]): { kept: CockpitAction[]; omitted: number } {
  const kept: CockpitAction[] = [];
  const byPriority: Record<CockpitActionPriority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  const byKind = new Map<string, number>();
  let omitted = 0;
  for (const a of list) {
    if (a.priority === 'P0') {
      kept.push(a);
      byPriority.P0 += 1;
      continue;
    }
    const kindN = byKind.get(a.kind) ?? 0;
    if (kindN >= KIND_CAP || byPriority[a.priority] >= TIER_CAP) {
      omitted += 1;
      continue;
    }
    byKind.set(a.kind, kindN + 1);
    byPriority[a.priority] += 1;
    kept.push(a);
  }
  return { kept, omitted };
}

/**
 * 风险检查没就绪时，把买入类动作全部挡住。
 *
 * 这是顺序问题而不是准确性问题：清单看起来完整，用户就会从上往下做。
 * 此时若止损动作还没算出来，他会先买入、后看到该卖——顺序反了，钱是真亏。
 */
function gateOpportunities(list: CockpitAction[], riskReady: boolean): CockpitAction[] {
  if (riskReady) return list;
  const buyish: CockpitActionKind[] = ['buy_triggered', 'near_buy', 'rotate', 'candidate'];
  return list.map((a) =>
    buyish.includes(a.kind)
      ? {
          ...a,
          readiness: 'blocked' as const,
          blockedReason: '持仓风险还没检查完，先别买——万一有该止损的，顺序反了会吃亏',
        }
      : a,
  );
}

/** 空清单的原因。「今天没事做」和「还没查完」必须分开说 */
function emptyReasonOf(riskReady: boolean, anyFailed: boolean): CockpitActionEmptyReason {
  if (!isTradingDay(new Date())) return 'market_closed';
  if (!riskReady) return 'risk_checking';
  if (anyFailed) return 'partial_failure';
  return 'all_clear';
}

const ROTATION_KEY = 'cockpit:actions:rotation';
const BOARDS_KEY = 'cockpit:actions:boards';
/** 两者都是日频快照，半小时内重算没有意义 */
const ROTATION_TTL_MS = 30 * 60_000;
const BOARDS_TTL_MS = 30 * 60_000;

/**
 * 取板块暴露，同样不等它。
 *
 * 实测 `computeBoardExposure()` 要跑约 4 分钟——它要为每个主线锚板块拉成分股，
 * 而概念成分接口经常 500 重试。同步等的结果是整个动作清单超时，P0 止损一起出不来。
 *
 * 与轮动的区别在后果：板块是风险源之一，没就绪时 `riskReady` 为假，
 * 买入类动作会全部标成「暂不可执行」。这不是退化，正是设计意图——
 * 风险还没查完就不该让人先买。预热完刷新一次即可。
 */
function boardsIfReady(): BoardExposure | null {
  const hit = peek<BoardExposure>(BOARDS_KEY);
  if (hit) return hit;
  void cached(BOARDS_KEY, BOARDS_TTL_MS, () => computeBoardExposure()).catch(() => {
    /* 预热失败不影响本次响应，下次进来会再试 */
  });
  return null;
}

/**
 * 取轮动榜，但**绝不等它**。
 *
 * 实测 `buildRotationOverview()` 要跑约 3 分钟（逐只 ETF 拉 K 线算强度），
 * 而它在动作清单里只贡献 P2 换仓候选——最不紧急的一档。
 * 让它同步阻塞的结果是整个响应超时，连 P0 止损都出不来：
 * 机会项缺席只是少赚，风险项迟到是真亏，两者不该同生共死。
 *
 * 所以有缓存就用，没有就后台预热、本次如实报「还在算」。
 */
function rotationIfReady(): EtfRotationOverview | null {
  const hit = peek<EtfRotationOverview>(ROTATION_KEY);
  if (hit) return hit;
  void cached(ROTATION_KEY, ROTATION_TTL_MS, buildRotationOverview).catch(() => {
    /* 预热失败不影响本次响应，下次进来会再试 */
  });
  return null;
}

/** 合成今日动作清单。各源独立 best-effort，任一失败只影响它自己那部分并如实标注 */
export async function buildActionPlan(): Promise<CockpitActionPlan> {
  const fresh: SourceFreshness[] = [];
  let actions: CockpitAction[] = [];

  // 只有纪律是同步等的：它直接决定 P0 止损，慢也必须等
  const disc = await evaluateDiscipline().catch((e) => e as Error);
  const boards = boardsIfReady();
  const rotation = rotationIfReady();

  if (disc instanceof Error) {
    fresh.push(judgeFreshness('positions', null, `真实持仓取不到：${disc.message}`));
    fresh.push(judgeFreshness('discipline', null, `持仓纪律算不出来：${disc.message}`));
  } else {
    fresh.push(judgeFreshness('positions', disc.asOf));
    fresh.push(judgeFreshness('discipline', disc.asOf));
    actions.push(...fromDiscipline(disc, disc.asOf).map(act));
  }

  if (boards) {
    fresh.push(judgeFreshness('boards', boards.snapshotDate));
    actions.push(...fromBoards(boards).map(act));
  } else {
    fresh.push(judgeFreshness('boards', null, undefined, '板块判断还在后台算，稍后刷新就有了'));
  }

  // 板块机会：纯本地读快照，不联网，所以不受上面板块暴露那条慢链路影响。
  // 它回答的是「今天哪些板块有戏」，与 fromBoards 的「我的持仓在不在退潮板块」是两件事
  try {
    const snap = listBoardStagesFromSnapshot();
    if (snap && snap.rows.length > 0) {
      actions.push(...fromBoardOpportunities(snap, boards?.stale ?? false).map(act));
    }
  } catch {
    /* 快照读不出来就没有板块机会这一类，不影响其余动作 */
  }

  // 选股候选：本地读最近一次选股结果
  try {
    actions.push(...fromScreener(buildScreenerPicks(5), null).map(act));
  } catch {
    /* 没跑过选股就没有这一类 */
  }

  if (rotation) {
    fresh.push(judgeFreshness('rotation', rotation.asOf));
    actions.push(...fromRotation(rotation, rotation.asOf).map(act));
  } else {
    fresh.push(judgeFreshness('rotation', null, undefined, 'ETF 轮动还在后台算，稍后刷新就有了'));
  }

  try {
    const detail = getTodayDetail();
    if (detail) {
      fresh.push(judgeFreshness('plan', detail.plan.createdAt));
      actions.push(...fromPlan(detail, detail.plan.createdAt).map(act));
    } else {
      fresh.push(judgeFreshness('plan', null));
    }
  } catch (e) {
    fresh.push(judgeFreshness('plan', null, `今日计划读不出来：${(e as Error).message}`));
  }

  const completeness = summarizeFreshness(fresh);
  actions = gateOpportunities(mergeByCode(actions), completeness.riskReady);
  let { kept, omitted } = capTiers(sortActions(actions));

  // 实时叠加放在最后：只给最终留下的那批取价，被折叠掉的不必浪费一次行情
  const prices = await fetchLivePrices(kept.map((a) => a.code ?? '').filter(Boolean));
  kept = applyLiveOverlay(kept, prices);
  fresh.push(
    prices.size > 0
      ? judgeFreshness('quote', nowIso())
      : judgeFreshness('quote', null, undefined, '实时行情暂时取不到，动作里的距离未更新'),
  );

  return {
    asOf: nowIso(),
    actions: kept,
    emptyReason:
      kept.length > 0
        ? null
        : emptyReasonOf(
            completeness.riskReady,
            fresh.some((f) => f.state === 'failed'),
          ),
    completeness,
    omitted,
  };
}

/** 盘中才需要秒级新鲜的行情；这个导出让路由层决定要不要提示用户刷新 */
export const isIntraday = (): boolean => isAShareTradingTime(new Date());

// 下面几个纯函数是这层「弄错了会让人亏钱」的部分（排序、合并、闸门、截断），
// 单独导出供自检直接喂构造数据验证，不必依赖真实持仓与网络。
export {
  capTiers as __test__capTiers,
  gateOpportunities as __test__gateOpportunities,
  mergeByCode as __test__mergeByCode,
  sortActions as __test__sortActions,
};
