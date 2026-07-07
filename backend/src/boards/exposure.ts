import type {
  BoardExposure,
  BoardExposureHolding,
  BoardExposureStatus,
  MainlineConsensusLevel,
  ThemePhase,
} from '@stock-agent/shared';
import { cached } from '../lib/ttlCache';
import { buildMainlineConsensus } from '../breadth/consensus';
import { buildBreadthOverview } from '../breadth/service';
import { fetchBoardConstituents } from '../breadth/data';
import { listWatch } from '../watchlist';
import { fetchRealPositions } from '../realPositions';
import { shanghaiDateStr } from '../market/calendar';
import { nowIso } from '../util';

// 持仓 / 自选 板块暴露（确定性只读，不下单）：
// ponytail: 仅覆盖「当前主线板块（confirmed/candidate 锚）成分 ∩ 我的持仓/自选」的懒相交，
//   主线板块只有个位数、成分有 6h 缓存，无需为全市场几百板块建 stock_board_index 反向索引表。
//   全市场反向索引作为后续优化。持仓来源：真实持仓(best-effort) + 自选；模拟战法持仓后续再纳入。
// 拥挤阈值：居首天数 ≥ 5 视为长期霸榜易过热。
const CROWDED_TOP_DAYS = 5;

/** 单个锚板块的成分与阶段元信息 */
interface AnchorBoard {
  boardCode: string | null;
  boardName: string;
  consensus: MainlineConsensusLevel;
  phase: ThemePhase | null;
  crowded: boolean;
  codes: Set<string>;
}

/**
 * 拉取当前主线锚板块（含成分集合）。best-effort：单板块成分取数失败则该板块空成分。
 * @param filterCode 仅加载该 boardCode 的成分（详情页复用，避免为单板块拉全部锚成分）
 */
async function loadAnchorBoards(filterCode?: string): Promise<AnchorBoard[]> {
  const [consensus, breadthOv] = await Promise.all([
    buildMainlineConsensus(),
    cached('breadth:overview', 30 * 60_000, () => buildBreadthOverview()).catch(() => null),
  ]);
  // boardCode → kind（东财成分接口按 kind 区分行业/概念）
  const kindByCode = new Map((breadthOv?.items ?? []).map((it) => [it.boardCode, it.kind]));
  const out: AnchorBoard[] = [];
  for (const it of consensus.items) {
    // 详情页只关心目标板块，其余锚不必拉成分（省 N× 取数）
    if (filterCode && it.boardCode !== filterCode) continue;
    const kind = it.boardCode ? kindByCode.get(it.boardCode) : undefined;
    // 无 kind 无法取成分（如概念热度源无 code），跳过该锚，避免误取错误板块
    if (!kind) continue;
    const codes = await fetchBoardConstituents(kind, it.board).catch(() => [] as string[]);
    out.push({
      boardCode: it.boardCode,
      boardName: it.board,
      consensus: it.consensus,
      phase: (it.themePhase as ThemePhase | null) ?? null,
      crowded: (it.topDays ?? 0) >= CROWDED_TOP_DAYS,
      codes: new Set(codes),
    });
  }
  return out;
}

/** 综合暴露状态：退潮/背离 > 拥挤 > 在主线 > 无关联 */
function deriveStatus(hits: AnchorBoard[]): BoardExposureStatus {
  if (hits.length === 0) return 'none';
  if (hits.some((b) => b.phase === '退潮' || b.consensus === 'diverge')) return 'fading';
  if (hits.some((b) => b.crowded)) return 'crowded';
  return 'mainline';
}

/**
 * 计算持仓/自选板块暴露。
 * @param boardCodeFilter 仅保留命中该 boardCode 的标的（板块详情页复用），不传则全量
 */
export async function computeBoardExposure(boardCodeFilter?: string): Promise<BoardExposure> {
  const anchors = await loadAnchorBoards(boardCodeFilter);

  // 待检标的：真实持仓（best-effort）+ 自选；按 code 去重（同 code 保留首个账户来源）
  const targets: Array<{ code: string; name: string; account: BoardExposureHolding['account'] }> = [];
  const seen = new Set<string>();
  try {
    const pf = await fetchRealPositions(false);
    for (const p of pf.positions) {
      if (!seen.has(p.code)) {
        seen.add(p.code);
        targets.push({ code: p.code, name: p.name, account: 'real' });
      }
    }
  } catch {
    /* 真实持仓未配置/取数失败：降级为仅自选 */
  }
  for (const w of listWatch()) {
    if (!seen.has(w.code)) {
      seen.add(w.code);
      targets.push({ code: w.code, name: w.name, account: 'watch' });
    }
  }

  const holdings: BoardExposureHolding[] = [];
  for (const t of targets) {
    const hits = anchors.filter((b) => b.codes.has(t.code));
    if (hits.length === 0) continue; // 无主线关联的标的不展示，减少噪声
    if (boardCodeFilter && !hits.some((b) => b.boardCode === boardCodeFilter)) continue;
    holdings.push({
      code: t.code,
      name: t.name,
      account: t.account,
      boards: hits.map((b) => ({
        boardCode: b.boardCode,
        boardName: b.boardName,
        consensus: b.consensus,
        phase: b.phase,
      })),
      status: deriveStatus(hits),
    });
  }

  return {
    asOf: nowIso(),
    snapshotDate: shanghaiDateStr(new Date()),
    holdings,
    note: '板块暴露：主线锚板块成分 ∩ 持仓/自选（懒相交，仅覆盖当前主线板块，仅研判不下单）。',
  };
}
