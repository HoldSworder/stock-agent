import type {
  ResearchAiAnalysis,
  ResearchAnnouncementItem,
  ResearchOpportunityReport,
  ResearchQuery,
  ResearchReport,
  ResearchReportDetail,
  ResearchReportType,
  ResearchStatus,
  RunTrigger,
} from '@stock-agent/shared';
import * as gateway from '../agent/gateway';
import { getValue } from '../settings';
import { listWatch } from '../watchlist';
import { listResearchReviews } from '../repo';
import {
  announcementUrl,
  fetchAnnouncementContent,
  fetchAnnouncementList,
  fetchContent,
  fetchList,
  detailUrl,
  pdfUrl,
  type FetchListOpts,
} from './client';

// 把东方财富研报原始 JSON 映射为本系统 shared DTO，并提供按需 AI 分析（走自有 LLM）。

// 消息催化结构化记录（情报研判落库 → 今日计划读取），供 agent 工具 record_catalysts / list_catalysts。
export { upsertCatalyst, listCatalysts, type ListCatalystOptions } from './catalystRepo';

const TYPE_LABEL: Record<ResearchReportType, string> = {
  stock: '个股研报',
  industry: '行业研报',
  strategy: '策略报告',
  macro: '宏观研究',
  morning: '券商晨报',
};

function str(v: unknown, d = ''): string {
  if (typeof v === 'string') return v;
  return v == null ? d : String(v);
}

/** 东财数值字段常为字符串，空串/非数字归一为 null */
function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** publishDate "2026-06-09 00:00:00.000" → "2026-06-09" */
function ymd(v: unknown): string {
  const s = str(v);
  return s ? s.slice(0, 10) : '';
}

function mapReport(type: ResearchReportType, o: Record<string, unknown>): ResearchReport {
  return {
    type,
    title: str(o.title),
    stockName: str(o.stockName),
    stockCode: str(o.stockCode),
    industryName: str(o.indvInduName) || str(o.industryName),
    orgName: str(o.orgSName) || str(o.orgName),
    researcher: str(o.researcher),
    rating: str(o.emRatingName),
    ratingChange: str(o.ratingChange),
    targetPriceLow: numOrNull(o.indvAimPriceL),
    targetPriceHigh: numOrNull(o.indvAimPriceT),
    epsThisYear: numOrNull(o.predictThisYearEps),
    epsNextYear: numOrNull(o.predictNextYearEps),
    peThisYear: numOrNull(o.predictThisYearPe),
    peNextYear: numOrNull(o.predictNextYearPe),
    publishDate: ymd(o.publishDate),
    infoCode: str(o.infoCode),
    encodeUrl: str(o.encodeUrl),
    attachPages: numOrNull(o.attachPages),
  };
}

/** 研报列表 */
export async function listReports(query: ResearchQuery): Promise<ResearchReport[]> {
  const opts: FetchListOpts = {
    code: query.code,
    industry: query.industry,
    rating: query.rating,
    days: query.days,
    page: query.page,
    pageSize: query.pageSize,
  };
  const raw = await fetchList(query.type, opts);
  return raw.map((o) => mapReport(query.type, o));
}

/** 单篇研报正文（抽取失败回退详情页/PDF 链接） */
export async function reportContent(
  type: ResearchReportType,
  encodeUrl: string,
  infoCode = '',
): Promise<ResearchReportDetail> {
  const text = await fetchContent(type, encodeUrl);
  return { text, detailUrl: detailUrl(type, encodeUrl), pdfUrl: pdfUrl(infoCode) };
}

const ANALYSIS_SYSTEM =
  '你是一名严谨的 A 股卖方研究分析师助手。基于给定的券商研报正文做客观研判，' +
  '不臆造数据。输出用简洁中文 Markdown，聚焦：核心观点、关键假设与盈利预测、评级与目标价解读、潜在风险、对投资者的可执行启示。';

/** 单次分析的运行管理元信息（运行触发来源与运行抽屉显示名） */
export interface AnalyzeMeta {
  trigger?: RunTrigger;
  taskName?: string;
}

/** 单篇研报 AI 研判 */
export async function analyzeReport(
  type: ResearchReportType,
  encodeUrl: string,
  infoCode = '',
  meta: AnalyzeMeta = {},
): Promise<ResearchAiAnalysis> {
  const detail = await reportContent(type, encodeUrl, infoCode);
  if (!detail.text) {
    throw new Error('未能抽取到研报正文，无法分析（可在详情页/PDF 查看原文）');
  }
  const result = await gateway.call({
    mode: 'oneshot',
    trigger: meta.trigger ?? 'manual',
    purpose: 'research',
    taskName: meta.taskName ?? '研报分析',
    systemPrompt: ANALYSIS_SYSTEM,
    prompt: `以下是一篇${TYPE_LABEL[type]}正文，请做研判：\n\n${detail.text.slice(0, 12000)}`,
    temperature: 0.3,
  });
  if (result.status !== 'success') {
    throw new Error(result.error || '研报分析失败');
  }
  return { content: result.outputText || '（模型无输出）', reportCount: 1 };
}

export interface BatchOpts {
  scope: 'watchlist' | 'stock' | 'industry';
  code?: string;
  industry?: string;
  limit?: number;
  trigger?: RunTrigger;
  taskName?: string;
}

/** 串行限速抓取多篇正文，避免触发东财风控 */
async function collectContents(
  reports: ResearchReport[],
  limit: number,
): Promise<{ report: ResearchReport; text: string }[]> {
  const out: { report: ResearchReport; text: string }[] = [];
  for (const r of reports) {
    if (out.length >= limit) break;
    if (!r.encodeUrl) continue;
    const text = await fetchContent(r.type, r.encodeUrl);
    if (text) out.push({ report: r, text });
    await new Promise((res) => setTimeout(res, 1100)); // ≥1 篇/秒
  }
  return out;
}

/** 多篇研报机构观点综述（默认对自选股近期研报） */
export async function analyzeBatch(opts: BatchOpts): Promise<ResearchAiAnalysis> {
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 8);
  let reports: ResearchReport[] = [];

  if (opts.scope === 'industry') {
    reports = await listReports({ type: 'industry', industry: opts.industry, days: 14, pageSize: limit * 2 });
  } else if (opts.scope === 'stock' && opts.code) {
    reports = await listReports({ type: 'stock', code: opts.code, days: 60, pageSize: limit * 2 });
  } else {
    // watchlist：取自选股，逐只拉最新一篇个股研报，合并
    const watch = listWatch().slice(0, limit);
    for (const w of watch) {
      const rs = await listReports({ type: 'stock', code: w.code, days: 90, pageSize: 1 });
      if (rs.length) reports.push(rs[0]);
      await new Promise((res) => setTimeout(res, 600));
    }
  }

  const picked = await collectContents(reports, limit);
  if (!picked.length) {
    throw new Error('近期无可分析的研报正文（可能自选股暂无研报或数据源限流）');
  }

  const corpus = picked
    .map(
      ({ report, text }, i) =>
        `### 研报${i + 1}：${report.title}\n机构：${report.orgName} | 评级：${report.rating || '—'}` +
        `${report.ratingChange ? '（' + report.ratingChange + '）' : ''} | 目标价：${
          report.targetPriceHigh ?? report.targetPriceLow ?? '—'
        } | 发布：${report.publishDate}\n正文摘录：${text.slice(0, 3500)}`,
    )
    .join('\n\n');

  const result = await gateway.call({
    mode: 'oneshot',
    trigger: opts.trigger ?? 'manual',
    purpose: 'research',
    taskName: opts.taskName ?? '研报机构观点综述',
    systemPrompt: ANALYSIS_SYSTEM,
    prompt:
      `以下是 ${picked.length} 篇研报，请做机构观点综述：归纳一致预期与核心逻辑、列出评级/目标价分布、` +
      `指出分歧与风险点，最后给出可执行结论。\n\n${corpus}`,
    temperature: 0.3,
  });
  if (result.status !== 'success') {
    throw new Error(result.error || '研报分析失败');
  }
  return {
    content: result.outputText || '（模型无输出）',
    reportCount: picked.length,
  };
}

// ===================== 当日新研报机会聚合（供「研报机会」复盘用） =====================

/** 研报机会运行记录的统一任务名（按需生成与定时任务共用，前端历史按此过滤） */
export const RESEARCH_OPP_TASK_NAME = '研报机会';

interface SectorAgg {
  name: string;
  reportCount: number;
  upgradeCount: number;
  /** 该板块代表个股（含目标价），用于线索 */
  samples: string[];
}

/** 策略/宏观/晨报正文样本 */
interface CategorySample {
  title: string;
  orgName: string;
  text: string;
}

interface DailyAggregate {
  date: string;
  totalStock: number;
  totalIndustry: number;
  hotSectors: SectorAgg[];
  /** 评级上调/首次覆盖的个股机会线索 */
  notableUpgrades: ResearchReport[];
  /** 代表研报正文样本（截断） */
  sampleAbstracts: CategorySample[];
  /** 策略报告正文样本 */
  strategySamples: CategorySample[];
  /** 宏观研究正文样本 */
  macroSamples: CategorySample[];
  /** 券商晨报正文样本 */
  morningSamples: CategorySample[];
}

/** 研报分析窗口天数：周一含周六/周日（返回 2），其余取昨天（返回 1）。publishDate 仅精确到日，按日历日近似。 */
export function discoverWindowDays(now: Date = new Date()): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(now);
  return wd === 'Mon' ? 2 : 1;
}

/** 串行限速抓取某类研报的前若干篇正文样本（控成本/限流） */
async function collectCategorySamples(
  reports: ResearchReport[],
  type: ResearchReportType,
  limit: number,
): Promise<CategorySample[]> {
  const out: CategorySample[] = [];
  for (const r of reports) {
    if (out.length >= limit) break;
    if (!r.encodeUrl) continue;
    const text = await fetchContent(type, r.encodeUrl);
    if (text) out.push({ title: r.title, orgName: r.orgName, text: text.slice(0, 1500) });
    await new Promise((res) => setTimeout(res, 1100));
  }
  return out;
}

/** 评级变动是否构成「利好信号」（上调/首次/买入增持） */
function isBullishChange(r: ResearchReport): boolean {
  const c = r.ratingChange || '';
  if (c.includes('上调') || c.includes('首次')) return true;
  return ['买入', '增持'].includes(r.rating);
}

/**
 * 聚合当日新研报（个股 + 行业），按板块聚类并统计评级上调，抽取代表正文样本。
 * 纯数据、无 LLM；个股研报量大，仅按 metadata 聚合 + 少量正文样本，控成本与限流。
 */
export async function aggregateDailyReports(daysOverride?: number): Promise<DailyAggregate> {
  const days = daysOverride ?? discoverWindowDays();
  // 个股取前 2 页（≤200 条）覆盖当日；行业 1 页；策略/宏观/晨报量小各 1 页
  const [stockP1, stockP2, industry, strategy, macro, morning] = await Promise.all([
    listReports({ type: 'stock', days, pageSize: 100, page: 1 }),
    listReports({ type: 'stock', days, pageSize: 100, page: 2 }),
    listReports({ type: 'industry', days, pageSize: 50, page: 1 }),
    listReports({ type: 'strategy', days, pageSize: 20, page: 1 }),
    listReports({ type: 'macro', days, pageSize: 20, page: 1 }),
    listReports({ type: 'morning', days, pageSize: 20, page: 1 }),
  ]);
  const stock = [...stockP1, ...stockP2];

  const sectorMap = new Map<string, SectorAgg>();
  const bump = (name: string, r: ResearchReport) => {
    const key = name.trim();
    if (!key) return;
    const s = sectorMap.get(key) ?? { name: key, reportCount: 0, upgradeCount: 0, samples: [] };
    s.reportCount += 1;
    if (isBullishChange(r)) s.upgradeCount += 1;
    if (r.stockName && s.samples.length < 6) {
      const tp = r.targetPriceHigh ?? r.targetPriceLow;
      s.samples.push(`${r.stockName}(${r.stockCode})${r.rating ? ' ' + r.rating : ''}${tp != null ? ' 目标价' + tp : ''}`);
    }
    sectorMap.set(key, s);
  };
  for (const r of stock) bump(r.industryName, r);
  for (const r of industry) bump(r.industryName || r.title, r);

  const hotSectors = [...sectorMap.values()]
    .sort((a, b) => b.upgradeCount - a.upgradeCount || b.reportCount - a.reportCount)
    .slice(0, 12);

  const notableUpgrades = stock
    .filter((r) => (r.ratingChange.includes('上调') || r.ratingChange.includes('首次')) && isBullishChange(r))
    .slice(0, 15);

  // 代表研报：优先取上调清单，回退取个股研报前几条，抓 ≤5 篇正文样本（串行限速）
  const repReports = (notableUpgrades.length ? notableUpgrades : stock).filter((r) => r.encodeUrl);
  const sampleAbstracts = await collectCategorySamples(repReports, 'stock', 5);

  // 策略/宏观/晨报量小，各抓 ≤6 篇正文样本，纳入更多正文要点
  const strategySamples = await collectCategorySamples(strategy, 'strategy', 6);
  const macroSamples = await collectCategorySamples(macro, 'macro', 6);
  const morningSamples = await collectCategorySamples(morning, 'morning', 6);

  return {
    date: new Date().toISOString().slice(0, 10),
    totalStock: stock.length,
    totalIndustry: industry.length,
    hotSectors,
    notableUpgrades,
    sampleAbstracts,
    strategySamples,
    macroSamples,
    morningSamples,
  };
}

/** 把聚合结果格式化为紧凑文本（供 agent 工具回传） */
export function formatDiscoverDigest(agg: DailyAggregate): string {
  const lines: string[] = [];
  lines.push(`当日(${agg.date})新研报：个股${agg.totalStock}篇 / 行业${agg.totalIndustry}篇`);
  lines.push('');
  lines.push('## 板块研报热度（按评级上调数/研报数排序）');
  for (const s of agg.hotSectors) {
    lines.push(
      `- ${s.name}：研报${s.reportCount} 上调/看多${s.upgradeCount}` +
        (s.samples.length ? `｜代表：${s.samples.join('、')}` : ''),
    );
  }
  lines.push('');
  lines.push('## 评级上调/首次覆盖个股');
  if (agg.notableUpgrades.length) {
    for (const r of agg.notableUpgrades) {
      const tp = r.targetPriceHigh ?? r.targetPriceLow;
      lines.push(
        `- ${r.stockName}(${r.stockCode}) [${r.industryName}] ${r.orgName}｜${r.rating}${
          r.ratingChange ? '·' + r.ratingChange : ''
        }${tp != null ? '｜目标价' + tp : ''}｜${r.title}`,
      );
    }
  } else {
    lines.push('（当日无明确上调/首次覆盖）');
  }
  lines.push('');
  lines.push('## 代表个股研报正文样本');
  for (const a of agg.sampleAbstracts) {
    lines.push(`### ${a.title}（${a.orgName}）`);
    lines.push(a.text);
    lines.push('');
  }
  const pushCategory = (heading: string, samples: CategorySample[]) => {
    if (!samples.length) return;
    lines.push('');
    lines.push(heading);
    for (const a of samples) {
      lines.push(`### ${a.title}（${a.orgName}）`);
      lines.push(a.text);
      lines.push('');
    }
  };
  pushCategory('## 策略报告要点样本', agg.strategySamples);
  pushCategory('## 宏观研究要点样本', agg.macroSamples);
  pushCategory('## 券商晨报要点样本', agg.morningSamples);
  return lines.join('\n');
}

/**
 * 格式化最近几次「研报机会」发现记录，供 discover 工具回传作历史对比上下文。
 * 当前运行此刻尚未 finish（status≠success），不会污染对比；无可用历史返回空串。
 */
export function formatRecentOpportunityHistory(limit = 2): string {
  const rows = listResearchReviews(limit);
  const blocks: string[] = [];
  for (const row of rows) {
    if (!row.outputText) continue;
    let obj: Partial<ResearchOpportunityReport>;
    try {
      obj = JSON.parse(row.outputText) as Partial<ResearchOpportunityReport>;
    } catch {
      continue; // 历史解析失败忽略该条
    }
    const date = obj.date || row.createdAt?.slice(0, 10) || '';
    const sectors = (obj.hotSectors ?? [])
      .slice(0, 8)
      .map((s) => `${s.name}(研报${s.reportCount ?? 0}/上调${s.upgradeCount ?? 0})`)
      .join('、');
    const opps = (obj.opportunities ?? [])
      .slice(0, 8)
      .map((o) => `${o.name}(${o.code})`)
      .join('、');
    const lines = [`### ${date} 研报机会`];
    if (sectors) lines.push(`热门板块：${sectors}`);
    if (opps) lines.push(`个股线索：${opps}`);
    if (obj.themeSummary) lines.push(`主线归纳：${obj.themeSummary}`);
    blocks.push(lines.join('\n'));
  }
  if (!blocks.length) return '';
  return ['## 历史研报机会对比（近几次发现结果，按时间倒序）', ...blocks].join('\n\n');
}

// ===================== 全市场重大公告候选（方案B：先标题甄别，再抓正文） =====================

/** 公告候选（仅元数据，供 agent 按标题甄别） */
export interface AnnouncementCandidate {
  artCode: string;
  code: string;
  name: string;
  type: string;
  title: string;
  /** 发布时间 display_time（前 19 位，无法解析时为空） */
  time?: string;
}

/** 材料性强的公告类型/标题关键词（命中即视为重大，纳入候选） */
const ANN_MATERIAL_KEYWORDS = [
  '业绩预', '预增', '预盈', '扭亏', '中标', '中签', '中选', '收购', '重组', '并购', '资产重组',
  '回购', '增持', '减持', '股权激励', '员工持股', '问询', '关注函', '立案', '处罚', '违规',
  '停牌', '复牌', '重大合同', '签订', '订单', '战略合作', '控制权', '要约',
];

/** 例行公告（命中即排除，降噪） */
const ANN_ROUTINE_KEYWORDS = [
  '股东大会决议', '股东大会通知', '股东大会资料', '股东会决议', '股东会会议资料',
  '分配方案', '利润分配', '日常关联交易', '会议资料', '独立董事', '监事会决议',
  '持股变动比例达到', '征集投票', '网络投票',
];

/** 公告材料性打分：类型/标题命中重大关键词加权，命中例行扣分 */
function announcementScore(type: string, title: string): number {
  const text = `${type} ${title}`;
  let score = 0;
  for (const k of ANN_MATERIAL_KEYWORDS) if (text.includes(k)) score += 2;
  for (const k of ANN_ROUTINE_KEYWORDS) if (text.includes(k)) score -= 3;
  return score;
}

/**
 * 拉取全市场公告列表，按窗口落时间、类型/标题材料性过滤打分，取 Top N 候选（仅元数据）。
 * 供 agent 阶段1 按标题甄别；正文由 fetchAnnouncementContents 二次抓取。
 */
export async function aggregateAnnouncementCandidates(
  daysOverride?: number,
  topN = 120,
): Promise<AnnouncementCandidate[]> {
  const days = daysOverride ?? discoverWindowDays();
  const begin = new Date();
  begin.setDate(begin.getDate() - Math.max(1, days));
  const beginMs = begin.getTime();

  const raw = await fetchAnnouncementList({ pages: 4, pageSize: 100 });
  const seen = new Set<string>();
  const scored: { cand: AnnouncementCandidate; score: number; t: number }[] = [];

  for (const o of raw) {
    const artCode = str(o.art_code);
    if (!artCode || seen.has(artCode)) continue;
    const codes = Array.isArray(o.codes) ? (o.codes as Record<string, unknown>[]) : [];
    const first = codes[0] ?? {};
    const code = str(first.stock_code);
    const name = str(first.short_name);
    const cols = Array.isArray(o.columns) ? (o.columns as Record<string, unknown>[]) : [];
    const type = cols.map((c) => str(c.column_name)).filter(Boolean).join('/');
    const title = str(o.title);
    if (!code || !title) continue;

    // 落窗口：display_time 形如 "2026-06-10 18:32:08:384"，取日期+时间前 19 位解析
    const dt = str(o.display_time).slice(0, 19).replace(/:(\d{3})$/, '');
    const ts = dt ? new Date(dt.replace(' ', 'T') + '+08:00').getTime() : NaN;
    if (Number.isFinite(ts) && ts < beginMs) continue;

    const score = announcementScore(type, title);
    if (score <= 0) continue; // 仅保留材料性为正的公告

    seen.add(artCode);
    scored.push({
      cand: { artCode, code, name, type, title, time: dt.slice(0, 16) },
      score,
      t: Number.isFinite(ts) ? ts : 0,
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || b.t - a.t)
    .slice(0, topN)
    .map((s) => s.cand);
}

/**
 * 公告列表（UI 用）：复用材料性筛选产出，按发布时间倒序，附原文链接。纯爬取，不落库。
 */
export async function listMaterialAnnouncements(
  daysOverride?: number,
  topN = 60,
): Promise<ResearchAnnouncementItem[]> {
  const cands = await aggregateAnnouncementCandidates(daysOverride, Math.max(topN, 60));
  return cands
    .slice()
    .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''))
    .slice(0, topN)
    .map((c) => ({
      artCode: c.artCode,
      code: c.code,
      name: c.name,
      type: c.type,
      title: c.title,
      time: c.time ?? '',
      url: announcementUrl(c.code, c.artCode),
    }));
}

/** 候选公告标题清单（供 agent 甄别；含 art_code 供二次取正文） */
export function formatAnnouncementTitles(list: AnnouncementCandidate[]): string {
  if (!list.length) return '';
  const lines = ['## 候选重大公告标题（待甄别，挑选明显影响标的者用 ann_content 取正文，传 art_code）'];
  list.forEach((a, i) => {
    lines.push(`${i + 1}. ${a.name}(${a.code})｜${a.type || '—'}｜${a.title}｜art_code=${a.artCode}`);
  });
  return lines.join('\n');
}

/** 阶段2：抓取 agent 选中公告的正文（去重、限速、截断），格式化回传 */
export async function fetchAnnouncementContents(artCodes: string[], cap = 20): Promise<string> {
  const uniq = [...new Set(artCodes.filter(Boolean))].slice(0, cap);
  const blocks: string[] = [];
  for (const code of uniq) {
    const text = await fetchAnnouncementContent(code);
    if (text) {
      blocks.push(`### art_code=${code}\n${text.slice(0, 1500)}`);
    }
    await new Promise((res) => setTimeout(res, 1100));
  }
  if (!blocks.length) return '未取到所选公告正文（art_code 无效或数据源限流）。';
  return ['## 选中公告正文摘录', ...blocks].join('\n\n');
}

/** 研报机会发现的统一 prompt（按需生成与定时任务共用） */
export const DISCOVER_PROMPT =
  '你是 A 股投研助手，请基于【近一日新发布的券商研报与全市场重大公告】做一份综合研报分析。\n\n' +
  '第一步：调用 research_reports(action=discover) 获取聚合摘要（窗口按运行日自动覆盖，含当日晨报）。摘要包含：' +
  '个股/行业板块研报热度聚类、评级上调/首次覆盖个股清单、个股/策略/宏观/晨报五类代表正文样本；' +
  '末尾的【历史研报机会对比】为近几次发现结果，【候选重大公告标题】为全市场重大公告标题清单（含 art_code）。\n' +
  '第二步：从【候选重大公告标题】中挑出明显影响标的（重大利好/利空）的公告，调用 research_reports(action=ann_content, codes=["art_code1","art_code2", ...]) 抓取其正文，codes 不超过 20 个；据正文研判每条公告对标的的影响（利好/利空/中性）。\n' +
  '第三步：综合研判——哪些板块被研报集中关注或密集上调（潜在主线/风口）、哪些个股有首次覆盖或评级上调的机会，结合策略/宏观/晨报样本提炼大势研判、政策/流动性主线、晨报浓缩重点；必要时用 mx_finance_data 核对现价/估值（≤2 次）。\n' +
  '第四步：对比【历史研报机会对比】，给出延续性结论——板块/主线延续、新增升温、退热降温。\n\n' +
  '【篇幅控制】hotSectors≤8、opportunities≤12、risks≤4、strategyNotes≤6、macroNotes≤6、morningNotes≤8、announcements≤20，每个文本字段≤60字。\n' +
  '【严格输出】最终只输出一个【完整合法】的 JSON 对象（闭合所有括号），不要任何额外文字、解释或 Markdown 代码围栏，结构如下：\n' +
  '{' +
  '"date":"string","marketDigest":"string",' +
  '"hotSectors":[{"name":"string","reportCount":number,"upgradeCount":number,"note":"string"}],' +
  '"opportunities":[{"code":"string","name":"string","sector":"string","rating":"string","ratingChange":"string","targetPrice":"string","reason":"string"}],' +
  '"themeSummary":"string",' +
  '"risks":[{"title":"string","detail":"string"}],' +
  '"continuity":{"persisting":"string","emerging":"string","fading":"string","note":"string"},' +
  '"strategyNotes":[{"org":"string","title":"string","point":"string"}],' +
  '"macroNotes":[{"org":"string","title":"string","point":"string"}],' +
  '"morningNotes":[{"org":"string","title":"string","point":"string"}],' +
  '"announcements":[{"code":"string","name":"string","type":"string","title":"string","impact":"string"}]' +
  '}\n' +
  'marketDigest 概述当日研报总量与上调家数等；reason 说明机会逻辑；impact 用「利好/利空/中性 + 一句话」；' +
  'continuity 无历史对比区块时置 null。数据不可用的字段：对象类置 null 或省略，数组类返回空数组。';

// ===== 情报研判（研报机会 + 全网热点 合并）=====
// 合并原「研报机会」（research_reports discover）+「每日热点研判」（trendradar_hotspots summary）
// 为一次 agent 运行，产出一份「研报机会 + 全网热点」综合情报，落 taskRun（taskName=情报研判），
// 作为今日计划的「情报」基准源，并供情报页 / 研报页 / 驾驶舱统一展示。

/** 情报研判统一任务名 */
export const INTEL_TASK_NAME = '情报研判';

/** 情报研判 prompt（研报机会 + 全网热点综合，竖排 Markdown，非 JSON） */
export const INTEL_PROMPT =
  '做一份 A 股「情报研判」，把【券商研报机会】与【全网热点】合并为一份盘前情报，供今日计划直接引用。只研判、不下单。\n\n' +
  '交易日校验（默认放行）：仅周一至周五触发，默认按交易日执行；接口异常一律按交易日继续，不据此判休市。\n\n' +
  '第1步 研报机会：调用 research_reports(action=discover) 取近一日五类研报（个股/行业/策略/宏观/晨报）聚合摘要——板块热度聚类、评级上调/首次覆盖清单、代表正文样本，末尾含候选重大公告标题（含 art_code）。从中挑出明显影响标的的重大公告，用 research_reports(action=ann_content, codes=[...]) 抓正文研判影响（codes≤20）。\n' +
  '第2步 全网热点：调用 trendradar_hotspots(action=summary) 取当日热点摘要，必要时 action=trending 补高频话题。提炼正在升温的题材风口与消息面，并按发酵阶段区分：【起爆前·消息催化】——有明确催化剂（政策/订单/事件）但尚未充分发酵、个股多在低位/平台、尚未连板放量；【已发酵/高位】——已连续大涨或连板、情绪透支。前者是今日计划个股短线「起爆前选股」的核心来源。\n' +
  '第3步 综合研判：把研报机会主线与全网热点风口交叉印证——哪些板块被研报集中关注/密集上调且同时是热点风口（高确定性主线）、哪些个股有首次覆盖或评级上调机会、哪些仅是情绪热点需警惕；并标注哪些属「起爆前·消息催化」（适合右侧介入前埋伏）哪些已「发酵高位」（追高风险）。必要时用 mx_finance_data 核对现价/估值（≤2 次）。\n' +
  '第4步 催化落库：把第2/3步识别出的「消息催化主线」用 record_catalysts 结构化入库（一次传数组），每条含 theme 题材、catalystType 催化类型、direction 受益方向、codes 相关标的、catalystWindow 预计时间窗、fermented 是否已发酵（起爆前未发酵传 false、已连板/大涨传 true）、note 催化要点。系统按 theme 去重并自动累计出现次数与首现日期，供今日计划识别「反复出现但未发酵」的潜伏主线。\n\n' +
  '输出（竖排清单，禁止 Markdown 表格，标注数据时间）：\n' +
  '📑 一、研报机会：①热门板块（≤6 条：板块｜研报数/上调数｜一句逻辑）②个股机会（≤10 条：名称(代码)｜评级/变动｜目标价｜逻辑）③重大公告影响（≤6 条：名称｜利好/利空/中性 + 一句话）。\n' +
  '🔥 二、全网热点：①起爆前·消息催化板块（≤6 条：题材｜催化剂｜预计时间窗｜受益方向，未充分发酵优先）②已发酵/高位需警惕（≤4 条：题材｜发酵程度｜追高风险）③消息面要点（≤4 条）。\n' +
  '🎯 三、交叉结论：研报与热点共振的高确定性主线（≤3 条）、起爆前催化主线（≤3 条：可右侧埋伏的方向）、仅情绪需警惕的方向、延续/新增/退热小结。\n' +
  '⚠️ 仅供参考，不构成投资建议。';

/** 旧版 discover prompt（仅供种子退役识别，勿用于运行） */
export const DISCOVER_PROMPT_LEGACY =
  '你是 A 股投研助手，请基于【当日新发布的券商研报】发现潜在的板块与个股机会。\n\n' +
  '第一步：调用 research_reports(action=discover, days=1) 获取当日新研报的聚合摘要' +
  '（含板块研报热度聚类、评级上调/首次覆盖个股清单、代表研报正文样本；摘要末尾若有【历史研报机会对比】区块，则为近几次发现结果）。\n' +
  '第二步：据此研判——哪些板块正被研报集中关注或密集上调（潜在主线/风口）、哪些个股有首次覆盖或评级上调的机会，' +
  '结合正文样本提炼逻辑；必要时可用 mx_finance_data 核对现价/估值（控制在 2 次以内）。\n' +
  '第三步：对比【历史研报机会对比】区块，给出延续性追加结论——哪些板块/主线延续（上次也热、本次仍热）、哪些新增升温（本次新出现）、哪些退热降温（上次热、本次弱化或消失）。\n\n' +
  '【篇幅控制】hotSectors≤8、opportunities≤12、risks≤4，每个文本字段≤60字。\n' +
  '【严格输出】最终只输出一个【完整合法】的 JSON 对象（闭合所有括号），不要任何额外文字、解释或 Markdown 代码围栏，结构如下：\n' +
  '{' +
  '"date":"string","marketDigest":"string",' +
  '"hotSectors":[{"name":"string","reportCount":number,"upgradeCount":number,"note":"string"}],' +
  '"opportunities":[{"code":"string","name":"string","sector":"string","rating":"string","ratingChange":"string","targetPrice":"string","reason":"string"}],' +
  '"themeSummary":"string",' +
  '"risks":[{"title":"string","detail":"string"}],' +
  '"continuity":{"persisting":"string","emerging":"string","fading":"string","note":"string"}' +
  '}\n' +
  'marketDigest 概述当日研报总量与上调家数等；reason 说明机会逻辑（评级/目标价/基本面催化）；' +
  'continuity 为与历史的延续性对比，无历史对比区块时置 null。' +
  '数据不可用的字段：对象类置 null 或省略，数组类返回空数组。';

/** 模块状态：容错探活（请求一次个股研报判通断） */
export async function status(): Promise<ResearchStatus> {
  const enabled = getValue('researchEnabled') !== 'false';
  try {
    await fetchList('stock', { pageSize: 1, days: 7 });
    return { enabled, online: true, detail: null };
  } catch (e) {
    return { enabled, online: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
