import type {
  MainlineConsensus,
  MainlineConsensusItem,
  MainlineConsensusLevel,
  TrendState,
} from '@stock-agent/shared';
import { cached } from '../lib/ttlCache';
import { nowIso } from '../util';
import { buildBreadthOverview, STAGE_LABEL } from './service';
import { listThemes } from '../themes/service';
import { buildRadarOverview } from '../radar/service';

// 主线共识聚合（决策层，确定性只读，不下单）：
// 以 breadth「板块新高宽度」的确认/候选主线为【确定性锚】（权重最高，与今日计划同口径），
// 横向对齐 themes 多源协同强度趋势 + radar 中线趋势，给出「共振 / 分歧 / 观察」判定。
// 复用 breadth/radar 既有 SWR 缓存键，themes 走内存 DB 读，不额外加重取数。

const TREND_TEXT: Record<TrendState, string> = {
  multi_long: '多头排列',
  up: '趋势向上',
  range: '震荡',
  down: '走弱',
};

/** 板块名归一：去空白/括号/罗马数字噪声，便于跨源模糊匹配（themes 名常较 breadth 板块名更短） */
function norm(s: string): string {
  return (s ?? '').replace(/[Ⅰ-Ⅻ\s（）()·]/g, '').trim();
}

/** 跨源板块名匹配：等值或互相包含（如 themes「机器人」⋈ breadth「工业机器人」） */
function nameMatch(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/** 组装主线共识。各源 best-effort 降级；breadth 无主线则返回空 items + 说明。 */
export async function buildMainlineConsensus(): Promise<MainlineConsensus> {
  const [breadth, radarOv] = await Promise.all([
    cached('breadth:overview', 30 * 60_000, () => buildBreadthOverview()).catch(() => null),
    cached('radar:overview', 120_000, buildRadarOverview).catch(() => null),
  ]);
  const themes = (() => {
    try {
      return listThemes(false);
    } catch {
      return [];
    }
  })();
  const radarInds = radarOv?.industries ?? [];

  // 锚：breadth 的主升/酝酿/分歧板块（确定性硬证据，与计划 focusSectors 同口径）。
  // 退幕板块也保留：持仓还在里面的人需要看到「只退出」，把它从榜上抹掉等于让人失去退出提示。
  const anchors = (breadth?.items ?? []).filter((it) => it.stage !== 'none');

  // 跨源关联未命中留痕（boardCode 优先命中失败、退回名称匹配的锚板块），供 boardCode 回填校准参考
  const unmatched: string[] = [];

  const items: MainlineConsensusItem[] = anchors.map((b) => {
    // themes 关联：boardCode 优先（稳定 join key），无 code 或未命中再退回板块名模糊匹配
    const theme =
      (b.boardCode ? themes.find((t) => t.boardCode === b.boardCode) : undefined) ??
      themes.find((t) => nameMatch(t.theme, b.boardName)) ??
      null;
    // radar 关联：同样 boardCode(IndustryStrength.code) 优先，退回名称匹配
    const radar =
      (b.boardCode ? radarInds.find((r) => r.code === b.boardCode) : undefined) ??
      radarInds.find((r) => nameMatch(r.name, b.boardName)) ??
      null;
    // 锚有 code 但 theme 侧只能靠名称命中（说明该主题 boardCode 尚未回填），记入未命中清单
    if (b.boardCode && theme && theme.boardCode !== b.boardCode) unmatched.push(b.boardName);

    const themeUp = theme
      ? theme.strengthTrend === 'rising' || theme.phase === '加速' || theme.phase === '启动'
      : false;
    const themeDown = theme
      ? theme.strengthTrend === 'falling' || theme.phase === '分歧' || theme.phase === '退潮'
      : false;
    const radarUp = radar ? radar.trend === 'multi_long' || radar.trend === 'up' : false;
    const radarDown = radar ? radar.trend === 'down' : false;

    const confirmed = b.stage === 'advancing';
    const supports = (themeUp ? 1 : 0) + (radarUp ? 1 : 0);
    const anyDown = themeDown || radarDown;

    // 共振：确认主线 + 至少一路同向走强 + 无任一路背离走弱；
    // 分歧：出现背离（一路看多一路走弱）或宽度锚本身已进入分歧/退幕；其余：仅锚成立的观察级。
    const anchorWeak = b.stage === 'diverging' || b.stage === 'fading';
    let consensus: MainlineConsensusLevel;
    if (confirmed && supports >= 1 && !anyDown) consensus = 'resonance';
    else if ((anyDown || anchorWeak) && (confirmed || themeUp || radarUp || anchorWeak)) consensus = 'diverge';
    else consensus = 'watch';

    const contText =
      b.continuity.overlap == null
        ? '核心股延续待积累'
        : `核心股延续${b.continuity.kept}/${b.continuity.prevCount}`;
    const parts: string[] = [
      `新高宽度${STAGE_LABEL[b.stage]}（新高${b.newHighCount}·居首${b.topDays}日·${contText}）`,
    ];
    if (theme) {
      const tt =
        theme.strengthTrend === 'rising' ? '走强' : theme.strengthTrend === 'falling' ? '走弱' : '走平';
      parts.push(
        `多源协同${Math.round(theme.strength)}·${tt}${theme.phase && theme.phase !== '未知' ? '·' + theme.phase : ''}`,
      );
    }
    if (radar) parts.push(`中线趋势${TREND_TEXT[radar.trend]}（强度${radar.strengthScore}）`);

    return {
      boardCode: b.boardCode ?? null,
      board: b.boardName,
      etf: b.etf,
      breadthVerdict: b.verdict,
      breadthStage: b.stage,
      breadthAction: b.stageAction,
      continuity: b.continuity,
      newHighCount: b.newHighCount,
      topDays: b.topDays,
      themeStrength: theme ? Math.round(theme.strength) : null,
      themeTrend: theme?.strengthTrend ?? null,
      themePhase: theme && theme.phase !== '未知' ? theme.phase : null,
      radarTrend: radar?.trend ?? null,
      radarStrength: radar?.strengthScore ?? null,
      consensus,
      note: parts.join(' ｜ '),
    };
  });

  // 排序：共振 > 观察 > 分歧；同级按新高数降序
  const rank: Record<MainlineConsensusLevel, number> = { resonance: 0, watch: 1, diverge: 2 };
  items.sort(
    (a, b) => rank[a.consensus] - rank[b.consensus] || (b.newHighCount ?? 0) - (a.newHighCount ?? 0),
  );

  // 未命中留痕：这些锚板块的 theme 只能靠名称命中，提示对应主题的 boardCode 待回填
  if (unmatched.length > 0) {
    console.warn(`[consensus] boardCode 未命中(退回名称匹配)：${unmatched.join('、')}`);
  }

  return {
    asOf: nowIso(),
    items,
    note: '主线共识：以按规则算出的「板块创新高表现」为基准，叠加多源协同度与中线趋势三方对齐（仅研判不下单，仅供参考）。',
  };
}
