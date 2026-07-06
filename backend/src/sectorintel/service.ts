import type { RunTrigger, SectorDigest, SectorRssItem } from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { latestRss } from '../trendradar/service';
import { saveAnalysis, listAnalyses } from '../analyze/service';
import { feedsOf, isSector, sectorLabel } from './sectors';

// 赛道资讯（吸收 investment-news）：经 TrendRadar RSS（feedId 以 iv_ 前缀）按赛道取数，
// 再由本系统自有 LLM 现场提炼「今日要点」（中文 + 英文标题翻译 + 原文溯源）。
// 历史复用统一 ai_analyses（kind=sector-intel，refKey=赛道 id）。纯资讯，不荐股、不下单。

export class SectorIntelError extends Error {}

/** 取某赛道最新 RSS（附赛道归属），days 默认 2 天窗口 */
export async function sectorRss(sector: string, days = 2): Promise<SectorRssItem[]> {
  if (!isSector(sector)) throw new SectorIntelError(`未知赛道：${sector}`);
  const feeds = feedsOf(sector);
  const items = await latestRss(days, feeds);
  return items.map((it) => ({ ...it, sector }));
}

const SECTOR_SYSTEM =
  '你是一名服务中国投资者的产业资讯分析师。基于给定的某一投资赛道的全球 RSS 资讯，' +
  '提炼该赛道「今日要点」。要求：①输出 3-5 条最值得关注的进展，跨源去重、合并同一事件；' +
  '②每条用一句简体中文概括（英文标题须翻译为中文），点明涉及的核心公司/技术/数据；' +
  '③每条末尾附原文链接用于溯源；④只做客观资讯归纳，不荐股、不下买卖指令、不臆造数据；' +
  '⑤无实质信息的娱乐/重复条目忽略。用简洁中文 Markdown 无序列表输出。';

/** 把赛道 RSS 拼成喂给 LLM 的语料（控长度防超长） */
function buildCorpus(items: SectorRssItem[]): string {
  const lines = items
    .slice(0, 80)
    .map((it) => `- [${it.feedName}] ${it.title}${it.url ? `（${it.url}）` : ''}`);
  return lines.join('\n').slice(0, 14000);
}

/** 生成某赛道「今日要点」并落库（kind=sector-intel，refKey=赛道 id） */
export async function digestSector(
  sector: string,
  trigger: RunTrigger = 'manual',
  days = 2,
): Promise<SectorDigest> {
  if (!isSector(sector)) throw new SectorIntelError(`未知赛道：${sector}`);
  const label = sectorLabel(sector);
  const items = await sectorRss(sector, days);
  const corpus = buildCorpus(items);
  if (!corpus.trim()) {
    throw new SectorIntelError(`「${label}」赛道暂无可用资讯（请检查 TrendRadar RSS 连通性）`);
  }

  const result = await gateway.call({
    mode: 'oneshot',
    trigger,
    purpose: 'analyze',
    taskName: `赛道资讯·${label}`,
    systemPrompt: SECTOR_SYSTEM,
    prompt: `以下是「${label}」赛道近${days}天的全球资讯，请提炼今日要点：\n\n${corpus}`,
    temperature: 0.4,
  });
  if (result.status !== 'success') {
    throw new SectorIntelError(result.error || '赛道要点生成失败');
  }
  const content = result.outputText || '（模型无输出）';
  saveAnalysis({
    kind: 'sector-intel',
    refKey: sector,
    title: label,
    runId: result.runId ?? null,
    content,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  });
  return { sector, content, createdAt: new Date().toISOString() };
}

/** 某赛道最新一条「今日要点」（无则 null） */
export function latestDigest(sector: string): SectorDigest | null {
  const list = listAnalyses('sector-intel', sector, 1);
  if (list.length === 0) return null;
  return { sector, content: list[0].content, createdAt: list[0].createdAt };
}
