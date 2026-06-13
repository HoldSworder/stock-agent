import type {
  RunTrigger,
  TrendNews,
  TrendRadarStatus,
  TrendRssItem,
  TrendSummary,
  TrendSummaryHistoryItem,
  TrendTopic,
} from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { getValue } from '../settings';
import { insertTrendSummary, listTrendSummaries } from '../repo';
import { callTool } from './mcpClient';

// 把 TrendRadar MCP 工具的原始 JSON 映射为本系统 shared DTO。

function num(v: unknown, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function str(v: unknown, d = ''): string {
  if (typeof v === 'string') return v;
  return v == null ? d : String(v);
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function mapNews(t: unknown): TrendNews {
  const o = rec(t);
  return {
    title: str(o.title),
    platform: str(o.platform),
    platformName: str(o.platform_name) || str(o.platform),
    rank: o.rank == null ? null : num(o.rank),
    url: o.url ? str(o.url) : null,
    timestamp: o.timestamp ? str(o.timestamp) : null,
  };
}

/** 热点话题统计（默认 auto_extract 高频词，保证有数据） */
export async function trending(topN = 10, mode: 'current' | 'daily' = 'current'): Promise<TrendTopic[]> {
  const r = rec(await callTool('get_trending_topics', { top_n: topN, mode, extract_mode: 'auto_extract' }));
  return arr(r.topics).map((t) => {
    const o = rec(t);
    return {
      keyword: str(o.keyword),
      frequency: num(o.frequency),
      matchedNews: num(o.matched_news),
      trend: str(o.trend, 'stable'),
      weightScore: num(o.weight_score),
    };
  });
}

/** 最新一批爬取的热榜新闻 */
export async function latestNews(limit = 50, platforms?: string[]): Promise<TrendNews[]> {
  const args: Record<string, unknown> = { limit, include_url: true };
  if (platforms && platforms.length) args.platforms = platforms;
  const r = rec(await callTool('get_latest_news', args));
  return arr(r.data).map(mapNews);
}

/** 最新 RSS 订阅文章 */
export async function latestRss(days = 1, feeds?: string[]): Promise<TrendRssItem[]> {
  const args: Record<string, unknown> = { days };
  if (feeds && feeds.length) args.feeds = feeds;
  const r = rec(await callTool('get_latest_rss', args));
  return arr(r.data).map((t) => {
    const o = rec(t);
    return {
      title: str(o.title),
      feedId: str(o.feed_id),
      feedName: str(o.feed_name) || str(o.feed_id),
      url: o.url ? str(o.url) : null,
      publishedAt: o.published_at ? str(o.published_at) : null,
      date: o.date ? str(o.date) : null,
    };
  });
}

/** 关键词搜新闻（同时覆盖热榜与 RSS，结构兼容 data/results） */
export async function searchNews(query: string, limit = 30): Promise<TrendNews[]> {
  const r = rec(
    await callTool('search_news', { query, search_mode: 'keyword', include_url: true, limit }),
  );
  const list = arr(r.data).length ? arr(r.data) : arr(r.results);
  return list.map(mapNews);
}

const ANALYSIS_SYSTEM =
  '你是一名服务 A 股投资者的资深情报研判分析师。基于给定的全网热榜热点、热榜新闻与 RSS 文章，' +
  '客观提炼对二级市场有价值的信号，不臆造数据、不编造行情。输出用简洁中文 Markdown，聚焦：' +
  '①今日核心题材与情绪主线；②可能受益/受冲击的板块与方向（点到为止，不荐股、不下买卖指令）；' +
  '③需要警惕的风险与噪声；④给投资者的可执行观察清单。无关娱乐八卦类热点可忽略。';

/** 把拉取到的原始情报拼成喂给 LLM 的语料（控长度防超长） */
function buildCorpus(topics: TrendTopic[], news: TrendNews[], rss: TrendRssItem[]): string {
  const lines: string[] = [];
  if (topics.length) {
    lines.push('## 高频热点话题（关键词·热度·趋势）');
    for (const t of topics) {
      lines.push(`- ${t.keyword}（热度${t.frequency}/命中${t.matchedNews}/${t.trend}）`);
    }
    lines.push('');
  }
  if (news.length) {
    lines.push('## 多平台热榜新闻');
    for (const n of news) lines.push(`- [${n.platformName || n.platform}] ${n.title}`);
    lines.push('');
  }
  if (rss.length) {
    lines.push('## RSS 订阅文章');
    for (const r of rss) lines.push(`- [${r.feedName}] ${r.title}`);
  }
  return lines.join('\n').slice(0, 14000);
}

/**
 * 按需生成热点 AI 研判（走统一 LLM 门面 gateway）。
 * 先经 TrendRadar MCP 拉取经筛选/翻译后的原始热点数据，再交由 gateway 现场研判，
 * 自动纳入全局运行管理(runs)与调用记录(llm_calls)。
 * daily：当日汇总（mode=daily，近 1 天 RSS）；weekly：扩大窗口（近 7 天 RSS）。
 */
export async function summaryReport(
  reportType: 'daily' | 'weekly' = 'daily',
  trigger: RunTrigger = 'manual',
): Promise<TrendSummary> {
  const rssDays = reportType === 'weekly' ? 7 : 1;
  const [topics, news, rss] = await Promise.all([
    trending(20, 'daily').catch(() => [] as TrendTopic[]),
    latestNews(80).catch(() => [] as TrendNews[]),
    latestRss(rssDays).catch(() => [] as TrendRssItem[]),
  ]);

  const corpus = buildCorpus(topics, news, rss);
  if (!corpus.trim()) {
    throw new Error('未能从 TrendRadar 拉取到热点数据，无法分析（请检查 MCP 连通性）');
  }

  const scope = reportType === 'weekly' ? '近一周' : '当日';
  const result = await gateway.call({
    mode: 'oneshot',
    trigger,
    purpose: 'analyze',
    taskName: reportType === 'weekly' ? '周度热点研判' : '每日热点研判',
    systemPrompt: ANALYSIS_SYSTEM,
    prompt: `以下是${scope}全网热点情报，请做面向 A 股投资者的研判：\n\n${corpus}`,
    temperature: 0.4,
  });
  if (result.status !== 'success') {
    throw new Error(result.error || '热点研判失败');
  }
  const content = result.outputText || '（模型无输出）';
  const { id, createdAt } = insertTrendSummary({
    reportType,
    content,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  });
  return {
    id,
    reportType,
    content,
    createdAt,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  };
}

/** 热点 AI 研判历史（按生成时间倒序） */
export function listSummaries(limit = 30): TrendSummaryHistoryItem[] {
  return listTrendSummaries(limit).map((r) => ({
    id: r.id,
    reportType: r.reportType,
    content: r.content,
    createdAt: r.createdAt,
  }));
}

/** 系统状态：含模块启用态与 MCP 连通性（不抛错，离线时降级） */
export async function status(): Promise<TrendRadarStatus> {
  const enabled = getValue('trendradarEnabled') !== 'false';
  try {
    const r = rec(await callTool('get_system_status', {}, 15000));
    const data = rec(r.data);
    const dd = rec(data.data);
    return {
      enabled,
      online: true,
      health: data.health ? str(data.health) : null,
      latestRecord: dd.latest_record ? str(dd.latest_record) : null,
      totalStorage: dd.total_storage ? str(dd.total_storage) : null,
      detail: null,
    };
  } catch (e) {
    return {
      enabled,
      online: false,
      health: null,
      latestRecord: null,
      totalStorage: null,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
