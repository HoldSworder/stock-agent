import type {
  EtfRotationItem,
  EtfRotationOverview,
  EtfRotationState,
  MidDrilldownResult,
  MidDrilldownEtf,
  RunTrigger,
  StrengthBreakdown,
} from '@stock-agent/shared';
import {
  computeMetrics,
  fetchEtfConstituents,
  fetchEtfRank,
  fetchThemeCategories,
  type EtfMetrics,
} from '../etf/data';
import { listPool } from '../etf/repo';
import { getKline } from '../market/eastmoney';
import { fetchEtfPremiumMap, type JisiluPremium } from '../market/jisilu';
import { isSourceEnabled } from '../datasource/registry';
import { runScreen } from '../screener/service';
import { nowIso } from '../util';

// M1 ETF 行业轮动引擎（建议向）：纯确定性只读取数 + 本地计算，复用 ETF 指标层 computeMetrics。
// 对「跟踪池 + 主题赛道代表 ETF」算 相对沪深300强弱(RS) + 双动量 + 周线趋势 + 资金流，
// 并按确定性规则给出 5 态（上升/回踩/加速/过热/破位）与综合强度，供 agent 研判层过滤成建议。
// 不下单、不做量化熔断；与短线情绪体系正交，仅服务中线赛道轮动。

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** 沪深300 指数（撞码需显式 secid） */
const BENCHMARK_CODE = '000300';
const BENCHMARK_SECID = '1.000300';

/** computeMetrics 降级包装：抛错返回 null（不让单只标的拖垮全榜） */
async function safeMetrics(code: string, price: number | null = null): Promise<EtfMetrics | null> {
  try {
    return await computeMetrics(code, price);
  } catch {
    return null;
  }
}

/** 基准（沪深300）近 60 日收益 %，用于计算相对强弱 RS；取不到返回 null */
async function benchmarkRet60(): Promise<number | null> {
  try {
    const bars = await getKline(BENCHMARK_CODE, 'day', 120, BENCHMARK_SECID);
    const closes = bars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0);
    const n = closes.length;
    if (n <= 60 || closes[n - 1 - 60] <= 0) return null;
    return (closes[n - 1] / closes[n - 1 - 60] - 1) * 100;
  } catch {
    return null;
  }
}

/** 周线均线多头：周线 价>MA20>MA60（数据不足返回 null） */
async function weeklyMaTrend(code: string): Promise<boolean | null> {
  try {
    const bars = await getKline(code, 'week', 120);
    const closes = bars.map((b) => b.close).filter((c) => Number.isFinite(c) && c > 0);
    const n = closes.length;
    if (n < 60) return null;
    const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;
    const ma20 = mean(closes.slice(n - 20));
    const ma60 = mean(closes.slice(n - 60));
    const price = closes[n - 1];
    return price > ma20 && ma20 > ma60;
  } catch {
    return null;
  }
}

/** 5 态状态机（确定性规则，呼应评审：加过热/破位判断，避免「涨得好=还能涨」） */
function classifyState(m: EtfMetrics, rs: number | null): EtfRotationState {
  const { price, ma20, ma60, maDeviation, pricePercentile, ret20, ret60 } = m;
  // 数据不足或跌破 MA60：破位/观望
  if (price == null || ma60 == null) return '破位';
  if (price < ma60) return '破位';
  // 趋势未破前提下，依次判定过热 → 加速 → 回踩 → 上升
  if ((pricePercentile ?? 0) >= 85 && (maDeviation ?? 0) >= 25 && (ret20 ?? 0) >= 10) {
    return '过热';
  }
  if (
    ret20 != null &&
    ret60 != null &&
    ret20 >= 6 &&
    ret20 / 20 > (ret60 / 60) * 1.3 &&
    (rs ?? 0) > 0
  ) {
    return '加速';
  }
  if (ma20 != null && price <= ma20 * 1.03 && price >= ma20 * 0.97 && (ret20 ?? 0) <= 2) {
    return '回踩';
  }
  return '上升';
}

/** 综合轮动强度 0-100：状态基分 + 相对强弱 + 动量 + 资金流（过热在基分中已惩罚） */
function scoreRotation(
  state: EtfRotationState,
  m: EtfMetrics,
  rs: number | null,
  flowNetIn: number | null,
): { score: number; breakdown: StrengthBreakdown } {
  const base =
    state === '加速' ? 70 : state === '上升' ? 60 : state === '回踩' ? 52 : state === '过热' ? 40 : 22;
  const rsPart = clamp((rs ?? 0) * 0.6, -12, 15);
  const momPart = clamp((m.momentum ?? 0) * 0.4, -12, 15);
  const flowPart = flowNetIn != null && flowNetIn > 0 ? clamp(flowNetIn * 1.2, 0, 12) : 0;
  const score = Math.round(clamp(base + rsPart + momPart + flowPart, 0, 100));
  return {
    score,
    breakdown: {
      total: score,
      parts: [
        { label: `状态基分·${state}`, value: base },
        { label: '相对强弱RS', value: r2(rsPart) },
        { label: '动量贡献', value: r2(momPart) },
        { label: '资金流加成', value: r2(flowPart) },
      ],
    },
  };
}

function buildNote(state: EtfRotationState, m: EtfMetrics, rs: number | null): string {
  const parts: string[] = [];
  if (rs != null) parts.push(`RS ${rs >= 0 ? '+' : ''}${rs.toFixed(1)}%`);
  if (m.ret60 != null) parts.push(`60日 ${m.ret60 >= 0 ? '+' : ''}${m.ret60.toFixed(1)}%`);
  if (m.maDeviation != null) parts.push(`年线偏离 ${m.maDeviation >= 0 ? '+' : ''}${m.maDeviation.toFixed(0)}%`);
  if (m.pricePercentile != null) parts.push(`分位 ${m.pricePercentile.toFixed(0)}%`);
  const hint =
    state === '过热'
      ? '已过热，勿追高，等回踩'
      : state === '破位'
        ? '跌破 MA60，规避/离场'
        : state === '回踩'
          ? '强势回踩，关注不破再放量'
          : state === '加速'
            ? '主升加速，跟随但防过热'
            : '趋势向上，持有为主';
  return `${hint}（${parts.join('｜')}）`;
}

/** 标的池：跟踪池 + 主题赛道代表 ETF（去重，跟踪池优先保留其 track） */
async function buildUniverse(): Promise<Array<{ code: string; name: string; source: 'pool' | 'theme'; track: string | null }>> {
  const out: Array<{ code: string; name: string; source: 'pool' | 'theme'; track: string | null }> = [];
  const seen = new Set<string>();
  for (const p of listPool()) {
    if (!/^\d{6}$/.test(p.code) || seen.has(p.code)) continue;
    seen.add(p.code);
    out.push({ code: p.code, name: p.name, source: 'pool', track: p.tags?.split(',')[0] ?? null });
  }
  try {
    const themes = await fetchThemeCategories();
    for (const t of themes) {
      const lead = t.lead;
      if (!lead || !/^\d{6}$/.test(lead.code) || seen.has(lead.code)) continue;
      seen.add(lead.code);
      out.push({ code: lead.code, name: lead.name, source: 'theme', track: t.name });
    }
  } catch {
    /* 主题赛道取数失败：仅用跟踪池 */
  }
  return out;
}

/** 集思录全市场折溢价 map（仅在数据源启用时取，整源 best-effort，失败回退空 map） */
async function premiumMap(): Promise<Map<string, JisiluPremium>> {
  if (!isSourceEnabled('jisilu')) return new Map();
  return fetchEtfPremiumMap().catch(() => new Map<string, JisiluPremium>());
}

/** 组装 ETF 行业轮动总览（确定性榜单，best-effort 降级） */
export async function buildRotationOverview(): Promise<EtfRotationOverview> {
  const [universe, benchRet60, inflow, premiums] = await Promise.all([
    buildUniverse(),
    benchmarkRet60(),
    fetchEtfRank('inflow', 50).catch(() => []),
    premiumMap(),
  ]);
  const flowByCode = new Map(inflow.map((it) => [it.code, it.netInflow ?? null]));

  const items = await Promise.all(
    universe.map(async (u): Promise<EtfRotationItem | null> => {
      const m = await safeMetrics(u.code);
      if (!m || m.barCount === 0) return null;
      const rs = m.ret60 != null && benchRet60 != null ? r2(m.ret60 - benchRet60) : null;
      const weekMaTrend = await weeklyMaTrend(u.code);
      const flowNetIn = flowByCode.get(u.code) ?? null;
      const state = classifyState(m, rs);
      const { score, breakdown } = scoreRotation(state, m, rs, flowNetIn);
      return {
        code: u.code,
        name: u.name,
        source: u.source,
        track: u.track,
        state,
        score,
        breakdown,
        rs,
        ret20: m.ret20 != null ? r2(m.ret20) : null,
        ret60: m.ret60 != null ? r2(m.ret60) : null,
        ret120: m.ret120 != null ? r2(m.ret120) : null,
        weekMaTrend,
        flowNetIn: flowNetIn != null ? r2(flowNetIn) : null,
        maDeviation: m.maDeviation != null ? r2(m.maDeviation) : null,
        pricePercentile: m.pricePercentile != null ? Math.round(m.pricePercentile) : null,
        premiumPct: premiums.get(u.code)?.premiumRate ?? null,
        note: buildNote(state, m, rs),
      };
    }),
  );

  const list = items
    .filter((it): it is EtfRotationItem => it != null)
    .sort((a, b) => b.score - a.score);

  return {
    asOf: nowIso(),
    items: list,
    note: 'ETF 行业轮动（中线赛道层，相对强弱+趋势+资金流确定性研判，仅供参考，不构成下单建议）',
  };
}

// ===== M2 中线下钻：强赛道 ETF → 成分股 universe → 中线选股龙头 =====

export interface MidDrilldownOptions {
  /** 取强度最高的前 N 只强赛道 ETF 作为下钻起点（默认 4） */
  topEtf?: number;
  /** universe 内选股输出 TopN（默认走选股页默认值） */
  pickTopN?: number;
  /** 题材上下文（透传选股 LLM） */
  context?: string;
  /** 是否调用 LLM 横排（默认 true；纯量化下钻传 false） */
  useLlm?: boolean;
  /** 触发来源（落库与计量） */
  trigger?: RunTrigger;
}

/** 强赛道判定：状态为上升/加速且相对沪深300为正（RS 为正才是真强，呼应评审） */
function isStrongTrack(it: EtfRotationItem): boolean {
  return (it.state === '上升' || it.state === '加速') && (it.rs ?? 0) > 0;
}

/**
 * M2 中线下钻：先取 ETF 行业轮动榜筛出强赛道 ETF，下钻其成分股合并为 universe，
 * 再在 universe 内跑中线龙头策略（mid_leader, horizon=mid）选龙头。
 * best-effort：无强赛道或成分股全部取数失败时返回 run=null 并附降级说明，不抛错。
 */
export async function runMidDrilldown(opts: MidDrilldownOptions = {}): Promise<MidDrilldownResult> {
  const topEtf = Math.min(Math.max(Math.round(opts.topEtf ?? 4), 1), 8);
  const ov = await buildRotationOverview();
  const strong = ov.items.filter(isStrongTrack).slice(0, topEtf);

  const strongEtfs: MidDrilldownEtf[] = [];
  const universe = new Set<string>();
  for (const it of strong) {
    const cons = await fetchEtfConstituents(it.code);
    for (const c of cons) universe.add(c);
    strongEtfs.push({
      code: it.code,
      name: it.name,
      track: it.track,
      state: it.state,
      score: it.score,
      constituentCount: cons.length,
    });
  }

  if (strong.length === 0) {
    return { asOf: ov.asOf, strongEtfs, universeSize: 0, run: null, note: '当前无「上升/加速且跑赢沪深300」的强赛道，暂不下钻。' };
  }
  if (universe.size === 0) {
    return {
      asOf: ov.asOf,
      strongEtfs,
      universeSize: 0,
      run: null,
      note: '强赛道已选出，但成分股取数为空（aktools/akshare 不可用或基金未披露持仓），无法下钻。',
    };
  }

  const trackNames = strongEtfs.map((e) => e.track || e.name).join('、');
  const run = await runScreen({
    engine: 'multifactor',
    strategyId: 'mid_leader',
    horizon: 'mid',
    universe: Array.from(universe),
    universeNote: `轮动 Top${strong.length} 强赛道成分股（${trackNames}）`,
    context: opts.context ?? trackNames,
    topN: opts.pickTopN ?? null,
    useLlm: opts.useLlm !== false,
    trigger: opts.trigger ?? 'manual',
  });

  return {
    asOf: ov.asOf,
    strongEtfs,
    universeSize: universe.size,
    run,
    note: `在 ${strong.length} 个强赛道、${universe.size} 只成分股内下钻中线龙头。`,
  };
}

/** 轮动榜文本摘要（注入 agent 研判 prompt 的确定性底稿） */
export function formatForAgent(ov: EtfRotationOverview): string {
  if (!ov.items.length) return 'ETF 行业轮动：暂无可用数据（行情取数失败）。';
  const lines = ov.items.map((it, i) => {
    const rs = it.rs != null ? `RS${it.rs >= 0 ? '+' : ''}${it.rs}%` : 'RS—';
    const week = it.weekMaTrend === true ? '周线多头' : it.weekMaTrend === false ? '周线未多头' : '周线—';
    const flow = it.flowNetIn != null ? `净流入${it.flowNetIn}亿` : '资金—';
    const track = it.track ? `[${it.track}]` : '';
    return (
      `${i + 1}. ${it.name}(${it.code})${track} ｜${it.state}｜强度${it.score}｜${rs}｜` +
      `60日${it.ret60 ?? '—'}%｜年线偏离${it.maDeviation ?? '—'}%｜分位${it.pricePercentile ?? '—'}%｜${week}｜${flow}`
    );
  });
  return `ETF 行业轮动榜（按综合强度降序，${ov.items.length} 只）\n${lines.join('\n')}`;
}

// ===== ETF 行业轮动研判（agent 过滤层）=====
// 确定性取数（etf_rotation_strength 工具）先把轮动榜 + 5 态算出来，再由 agent 过滤出
// 该进攻 / 该等回踩 / 该回避的赛道建议，成功落 taskRun（taskName=ETF行业轮动研判），
// 供今日计划生成作为「中线赛道基准」第六源，以及 ETF 页「行业轮动」Tab 顶部展示结论。

export const ETF_ROTATION_TASK_NAME = 'ETF行业轮动研判';

export const ETF_ROTATION_PROMPT =
  '基于确定性 ETF 轮动数据做「ETF 行业轮动研判」，输出可供今日计划直接引用的中线赛道基准。只研判、不下单、不取个股交易动作。\n\n' +
  '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续，不据此判休市。\n\n' +
  '第1步 取确定性底稿：调用 etf_rotation_strength 一次，拿到「跟踪池 + 主题赛道代表 ETF 的轮动榜」——含 5 态（上升/回踩/加速/过热/破位）、相对沪深300强弱 RS、双动量、周线趋势、主力净流入、综合强度。这是事实基础，禁止凭空编造 ETF 或状态。\n' +
  '第2步 过滤研判（中线双周/月度视角）：结合 RS（跑赢基准才是真强）+ 周线趋势 + 资金流，区分：①该进攻赛道（上升/加速 且 RS 为正、周线多头、资金净流入）②该等回踩（趋势完好但短期回踩态，等不破再放量）③该回避（过热——分位高且年线大幅正偏离，勿追高；破位——跌破 MA60，规避/离场）。\n' +
  '重要纪律：涨幅靠后≠该卖（看趋势与 RS，不看当日涨幅）；过热≠还能涨（过热应等回踩而非追高）；不读研报景气，只信确定性量价与资金。\n\n' +
  '输出（竖排清单，禁止 Markdown 表格，控制在一屏内）：\n' +
  '🔄 ETF 行业轮动研判（标注数据时间）\n' +
  '一、该进攻赛道（≤4 条）：ETF 名(代码) ｜状态/RS ｜一句理由\n' +
  '二、该等回踩（≤3 条）：ETF 名(代码) ｜回踩位置 ｜确认信号\n' +
  '三、该回避（≤3 条）：ETF 名(代码) ｜过热/破位 ｜原因\n' +
  '四、一句话结论：当前中线赛道轮动方向与进攻/均衡/防守倾向。\n' +
  '⚠️ 确定性指标研判，仅供参考，不构成投资建议。';
