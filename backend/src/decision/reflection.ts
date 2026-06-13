import type { DecisionMemoryItem } from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { getKline, getQuoteWithLimits } from '../market/eastmoney';
import { getMeta, getValue } from '../settings';
import { shanghaiDate } from '../strategy/sim';
import { listPending, markReviewed } from './memory';

// 反思闭环：到期的 pending 决策，对比个股 vs 沪深300 区间收益算 Alpha，
// 再由轻模型 LLM 复盘出 verdict+lesson 回写 reviewed。离线定时路径，非交互。

/** 沪深300 指数 secid（撞码须显式传，1=沪市指数） */
const CSI300_SECID = '1.000300';
const CSI300_CODE = '000300';

/** 复盘等待天数（自然日）：决策日距今 ≥ 此值才复盘，默认 5 */
function reflectionDays(): number {
  const n = Number.parseInt(getMeta('decision_reflection_days') ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 60) : 5;
}

/** 复盘用轻模型（与决策分析师层同源，回退主模型） */
function quickModel(): string {
  return getMeta('decision_quick_model') || getValue('llmLightModel') || getValue('llmModel');
}

/** 两个 YYYY-MM-DD 之间的自然日差（b - a） */
function dayDiff(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00+08:00`);
  const tb = Date.parse(`${b}T00:00:00+08:00`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.round((tb - ta) / 86400000);
}

/** 取沪深300 自 decisionDate 起的区间收益率（%）；失败返回 null（降级为绝对收益） */
async function csi300Return(decisionDate: string, days: number): Promise<number | null> {
  try {
    const bars = await getKline(CSI300_CODE, 'day', Math.max(days + 20, 40), CSI300_SECID);
    if (bars.length < 2) return null;
    const base = bars.find((b) => b.time >= decisionDate) ?? bars[0];
    const last = bars[bars.length - 1];
    if (!base || !last || base.close <= 0) return null;
    return ((last.close - base.close) / base.close) * 100;
  } catch {
    return null;
  }
}

function parseReview(text: string): { verdict: DecisionMemoryItem['verdict']; lesson: string } {
  let verdict: DecisionMemoryItem['verdict'] = '中性';
  let lesson = text.trim();
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      const v = String(obj.verdict ?? '');
      if (v === '正确' || v === '失误' || v === '中性') verdict = v;
      if (typeof obj.lesson === 'string' && obj.lesson.trim()) lesson = obj.lesson.trim();
    }
  } catch {
    /* 非 JSON：原文作为教训，verdict 维持中性 */
  }
  return { verdict, lesson: lesson.slice(0, 400) };
}

/** 复盘结果汇总（供定时任务/手动触发回显） */
export interface ReflectionSummary {
  /** 到期待复盘条数 */
  due: number;
  /** 成功复盘条数 */
  reviewed: number;
  /** 各条简述 */
  details: string[];
}

/**
 * 复盘所有到期的 pending 决策。signal 可中止。
 * 个股现价经 getQuoteWithLimits 取，CSI300 经指数 K 线算，得 Alpha 后由 LLM 定性+提炼教训。
 */
export async function reviewPending(opts: { signal?: AbortSignal } = {}): Promise<ReflectionSummary> {
  const today = shanghaiDate();
  const threshold = reflectionDays();
  const due = listPending().filter((m) => dayDiff(m.decisionDate, today) >= threshold);
  const summary: ReflectionSummary = { due: due.length, reviewed: 0, details: [] };

  for (const m of due) {
    if (opts.signal?.aborted) break;
    try {
      const quote = await getQuoteWithLimits(m.code);
      const price = quote.price;
      const entry = m.entryPrice ?? m.targetPrice ?? null;
      if (entry == null || entry <= 0 || !(price > 0)) {
        summary.details.push(`${m.name}(${m.code})：缺入场价或现价，跳过`);
        continue;
      }
      const stockRet = ((price - entry) / entry) * 100;
      const days = dayDiff(m.decisionDate, today);
      const idxRet = await csi300Return(m.decisionDate, days);
      const alpha = idxRet != null ? stockRet - idxRet : stockRet;

      const prompt =
        `你是【交易复盘官】，对一次 A 股决策做事后复盘。\n` +
        `标的：${m.name}(${m.code})\n` +
        `决策日：${m.decisionDate}（距今 ${days} 天）\n` +
        `当时操作：${m.action}，置信度 ${m.confidence}\n` +
        `当时逻辑：${m.thesis}\n` +
        `入场价：${entry}，复盘现价：${price.toFixed(2)}\n` +
        `个股区间收益：${stockRet.toFixed(2)}%\n` +
        (idxRet != null
          ? `沪深300 同期收益：${idxRet.toFixed(2)}%，超额 Alpha：${alpha.toFixed(2)}%\n`
          : `沪深300 数据缺失，按绝对收益 ${stockRet.toFixed(2)}% 评估\n`) +
        '请判断该决策是否成功（以 Alpha/绝对收益与当时逻辑兑现度综合判断），并提炼一条可复用的教训。\n' +
        '【严格输出】只输出一个合法 JSON：{"verdict":"正确|失误|中性","lesson":"一句话教训(≤60字)"}';

      const res = await gateway.call({
        mode: 'oneshot',
        recordRun: false,
        trigger: 'cron',
        purpose: 'decision-reflection',
        taskName: `决策复盘 ${m.name}`,
        model: quickModel(),
        prompt,
        temperature: 0.3,
      });
      const text = res.status === 'success' ? res.outputText : '';
      const { verdict, lesson } = parseReview(text);

      markReviewed(m.id, {
        reviewPrice: price,
        stockReturn: Number(stockRet.toFixed(2)),
        csi300Return: idxRet != null ? Number(idxRet.toFixed(2)) : null,
        alpha: Number(alpha.toFixed(2)),
        verdict,
        lesson,
      });
      summary.reviewed += 1;
      summary.details.push(`${m.name}(${m.code})：${verdict}，Alpha ${alpha.toFixed(2)}%｜${lesson}`);
    } catch (err) {
      summary.details.push(`${m.name}(${m.code})：复盘失败 ${(err as Error).message}`);
    }
  }
  return summary;
}
