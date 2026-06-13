import type { RunTrigger } from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { getValue } from '../settings';
import type { ScoredRow } from './scorer';
import type { ScreenStrategyDef } from './strategy';

// L2b LLM 横向排序：仅在确定性打分筛出的小候选池内做「跨标的比较 + 选股逻辑/风险」，
// 不让 LLM 全市场筛选（不可控、烧 token）。经统一门面 gateway.call 便宜模型，永不抛错。
// JSON 解析失败 / 覆盖率不足时由调用方回退确定性 screenScore 排序。

/** LLM 对单只候选的研判产出 */
export interface RankedPick {
  code: string;
  thesis: string;
  riskTags: string[];
  confidence: number | null;
  watchItems: string[];
  invalidators: string[];
}

/** LLM 横向排序结果（含全局观与逐只研判） */
export interface RankResult {
  /** 关联运行 id（计量） */
  runId: string | null;
  marketView: string | null;
  selectionLogic: string | null;
  portfolioRisk: string | null;
  /** code → 研判 */
  byCode: Map<string, RankedPick>;
  /** LLM 给出的排序（code 序，用于覆盖确定性顺序）；解析失败为空 */
  order: string[];
}

const EMPTY = (runId: string | null): RankResult => ({
  runId,
  marketView: null,
  selectionLogic: null,
  portfolioRisk: null,
  byCode: new Map(),
  order: [],
});

function asStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter((s) => s.trim().length > 0).slice(0, 6);
}

function buildPrompt(
  def: ScreenStrategyDef,
  context: string,
  topN: number,
  candidates: ScoredRow[],
): string {
  const lines = candidates.map((c) => {
    const f = c.factors.map((x) => `${x.key}=${x.score}`).join(' ');
    const r = c.row;
    return (
      `${r.name}(${r.code}) 行业=${r.industry || '未知'} 现价${r.price} 涨跌${r.pct}% ` +
      `换手${r.turnoverRate ?? '-'}% 量比${r.volumeRatio ?? '-'} PE${r.pe ?? '-'} PB${r.pb ?? '-'} ` +
      `市值${r.marketCap != null ? r.marketCap.toFixed(0) + '亿' : '-'} | 综合分${c.screenScore} [${f}]`
    );
  });
  return (
    `你是 A 股短线选股助手。下面是经确定性多因子打分初筛出的候选池（策略：${def.name} —— ${def.description}）。\n` +
    (context ? `今日题材上下文：${context}\n` : '') +
    `请在候选池内做横向比较，挑出最值得关注的 ${topN} 只并排序，给出选股逻辑与风险。\n\n` +
    `候选池：\n${lines.join('\n')}\n\n` +
    `严格只输出 JSON（不要任何额外文字、不要 Markdown 代码块），结构：\n` +
    `{\n` +
    `  "marketView": "一句话当前大盘/题材环境判断",\n` +
    `  "selectionLogic": "本次选股的总体逻辑（为何选这些方向）",\n` +
    `  "portfolioRisk": "作为一篮子的组合风险提示",\n` +
    `  "picks": [ {"code":"6位代码","thesis":"选它的核心逻辑(一句话)","riskTags":["风险标签"],"confidence":0到100,"watchItems":["盘中跟踪要点"],"invalidators":["逻辑失效条件"]} ]\n` +
    `}\n` +
    `picks 按推荐优先级排序，长度尽量 ${topN}，code 必须来自上面候选池。`
  );
}

function parse(text: string, runId: string | null): RankResult {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return EMPTY(runId);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return EMPTY(runId);
  }
  const picksRaw = Array.isArray(obj.picks) ? (obj.picks as Record<string, unknown>[]) : [];
  const byCode = new Map<string, RankedPick>();
  const order: string[] = [];
  for (const p of picksRaw) {
    const code = String(p.code ?? '').trim();
    if (!/^\d{6}$/.test(code) || byCode.has(code)) continue;
    const confidence =
      typeof p.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(p.confidence))) : null;
    byCode.set(code, {
      code,
      thesis: String(p.thesis ?? '').trim(),
      riskTags: asStrArr(p.riskTags),
      confidence,
      watchItems: asStrArr(p.watchItems),
      invalidators: asStrArr(p.invalidators),
    });
    order.push(code);
  }
  const str = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s : null;
  };
  return {
    runId,
    marketView: str(obj.marketView),
    selectionLogic: str(obj.selectionLogic),
    portfolioRisk: str(obj.portfolioRisk),
    byCode,
    order,
  };
}

/**
 * LLM 横向排序候选池。失败（gateway 非 success / 解析失败）返回空结果，调用方回退确定性排序。
 */
export async function rankCandidates(opts: {
  def: ScreenStrategyDef;
  context: string;
  topN: number;
  candidates: ScoredRow[];
  trigger: RunTrigger;
}): Promise<RankResult> {
  const { def, context, topN, candidates, trigger } = opts;
  if (candidates.length === 0) return EMPTY(null);
  const prompt = buildPrompt(def, context, topN, candidates);
  const r = await gateway.call({
    mode: 'oneshot',
    purpose: 'screen',
    trigger,
    taskName: `选股横排·${def.name}`,
    prompt,
    model: getValue('llmLightModel') || undefined,
    maxTokens: 4000,
    // 高频初筛性质：仅落调用记录，不进「Agent 运行中」抽屉
    recordRun: false,
  });
  if (r.status !== 'success' || !r.outputText) return EMPTY(r.runId);
  return parse(r.outputText, r.runId);
}
