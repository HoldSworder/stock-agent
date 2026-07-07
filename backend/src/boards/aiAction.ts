import type { AiActionVerdict, BoardActionTag } from '@stock-agent/shared';
import { call } from '../agent/gateway';
import { cached } from '../lib/ttlCache';
import { getPrompt, PROMPT_KEYS } from '../agent/promptConfig';
import { buildBoardDetail } from './service';

// 板块作战台「AI 行动建议」：结构化行动研判（结论/理由/证据/失效条件/动作），按需生成。
// 经统一网关 gateway.call(oneshot) 产出，prompt 走全局「行动结构」契约（promptConfig 可覆盖），
// 无 JSON schema，靠 prompt 约定 + 事后 parseJsonObject 解析。仅研判不下单。

const ACTIONS: BoardActionTag[] = ['观察', '试错', '持有', '加仓候选', '减仓', '回避', '等待'];

/** 从模型正文里抽取首个 JSON 对象（兼容围栏/前后噪声）；失败返回 null */
function parseJsonObject<T>(text: string): T | null {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    return JSON.parse(text.slice(s, e + 1)) as T;
  } catch {
    return null;
  }
}

/** 把 board 详情底稿压成给模型的确定性上下文（不编造，只喂事实） */
function buildContext(detail: Awaited<ReturnType<typeof buildBoardDetail>>): string {
  if (!detail) return '';
  const it = detail.item;
  const lead = detail.leaders.map((l) => `${l.name}(${l.code})`).join('、') || '—';
  const lag = detail.laggards.map((l) => `${l.name}(${l.code})`).join('、') || '—';
  return [
    `板块：${it.board}`,
    `三方共识：${it.consensus}`,
    `生命周期阶段：${it.phase ?? '未知'}`,
    `多源协同强度：${it.strength ?? '—'}（趋势 ${it.strengthTrend ?? '—'}）`,
    `适配周期：${it.cycleFit}`,
    `风险标签：${it.riskTags.join('、') || '无'}`,
    `代表 ETF：${it.etf ? it.etf.name + '(' + it.etf.code + ')' : '无'}`,
    `龙头：${lead}`,
    `补涨：${lag}`,
    `证据摘要：${it.evidenceNote}`,
  ].join('\n');
}

/**
 * 生成板块 AI 行动建议（结构化 AiActionVerdict）。
 * @returns 网关失败 / 解析失败 / 非主线板块时返回 null，由上层降级展示
 */
export async function generateBoardAiAction(boardCode: string): Promise<AiActionVerdict | null> {
  // 复用 /detail 路由同一缓存键，避免为拼 LLM 上下文重跑成分/快照/因子等重活
  const detail = await cached(`boards:detail:${boardCode}`, 120_000, () =>
    buildBoardDetail(boardCode),
  );
  if (!detail) return null;

  const prompt = `${getPrompt(PROMPT_KEYS.boardAction)}\n\n【板块底稿】\n${buildContext(detail)}`;
  const r = await call({
    mode: 'oneshot',
    purpose: 'board-action',
    trigger: 'manual',
    taskName: `${detail.item.board} 行动研判`,
    prompt,
    maxTokens: 1200,
    recordRun: false,
  });
  if (r.status !== 'success') return null;

  const parsed = parseJsonObject<Partial<AiActionVerdict>>(r.outputText);
  if (!parsed || typeof parsed.conclusion !== 'string') return null;

  // 动作标签兜底：模型给出非法值时回落到确定性派生的 actionTag
  const action = ACTIONS.includes(parsed.action as BoardActionTag)
    ? (parsed.action as BoardActionTag)
    : detail.item.actionTag;

  // 数组元素做 string 过滤：模型偶发返回对象数组会在前端渲染成 [object Object]
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const inval = strArr(parsed.invalidators);
  return {
    conclusion: parsed.conclusion,
    reasons: strArr(parsed.reasons),
    evidence: strArr(parsed.evidence),
    invalidators: inval.length > 0 ? inval : detail.invalidators,
    action,
  };
}
