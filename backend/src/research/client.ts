import type { ResearchReportType } from '@stock-agent/shared';
import { getValue } from '../settings';
import { requestJson, requestText } from '../datasource/httpClient';

// 东方财富研报中心数据客户端（免费/无鉴权）：
// - 列表/元数据：/report/list（个股、行业）与 /report/jg（策略、宏观、晨报）
// - 研报正文：data.eastmoney.com 详情页服务端直出 HTML，抽取 .ctx-content 纯文本
// reportapi 有风控，统一带 UA + Referer，并对正文抓取串行限速（见 service 层）。

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://data.eastmoney.com/';

/** 研报类型 → reportapi 的 qType 取值 */
const QTYPE: Record<ResearchReportType, string> = {
  stock: '0',
  industry: '1',
  strategy: '2',
  macro: '3',
  morning: '4',
};

/** list 接口（个股/行业）与 jg 接口（策略/宏观/晨报）分流 */
const USE_JG: Record<ResearchReportType, boolean> = {
  stock: false,
  industry: false,
  strategy: true,
  macro: true,
  morning: true,
};

/**
 * 研报类型 → 详情页路径（拼 encodeUrl 抓正文）。
 * 东财详情页按 encodeUrl 取正文，路径仅需为已注册页面即可命中；
 * 券商晨报无独立详情页（zw_morning 等均 404），复用同为 jg 聚合类的 zw_strategy 页正常返回正文。
 */
const DETAIL_PAGE: Record<ResearchReportType, string> = {
  stock: 'zw_stock',
  industry: 'zw_industry',
  strategy: 'zw_strategy',
  macro: 'zw_macresearch',
  morning: 'zw_strategy',
};

function baseUrl(): string {
  return (getValue('researchBaseUrl').trim() || 'https://reportapi.eastmoney.com').replace(/\/$/, '');
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchJson(url: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
  return requestJson({
    sourceId: 'research',
    url,
    timeoutMs,
    headers: { 'User-Agent': DEFAULT_UA, Referer: REFERER },
    errorLabel: '研报接口 HTTP',
  });
}

export interface FetchListOpts {
  code?: string;
  industry?: string;
  rating?: string;
  days?: number;
  page?: number;
  pageSize?: number;
}

/** 拉取研报列表原始条目（east money 返回的 data[]） */
export async function fetchList(
  type: ResearchReportType,
  opts: FetchListOpts = {},
): Promise<Record<string, unknown>[]> {
  const endpoint = USE_JG[type] ? 'jg' : 'list';
  const end = new Date();
  const begin = new Date();
  begin.setDate(begin.getDate() - Math.max(1, opts.days ?? 30));

  const params = new URLSearchParams({
    industryCode: opts.industry || '*',
    pageSize: String(Math.min(Math.max(opts.pageSize ?? 30, 1), 100)),
    industry: '*',
    rating: opts.rating || '',
    ratingChange: '',
    beginTime: ymd(begin),
    endTime: ymd(end),
    pageNo: String(Math.max(opts.page ?? 1, 1)),
    fields: '',
    qType: QTYPE[type],
    orgCode: '',
    code: type === 'stock' ? opts.code || '*' : '*',
    rcode: '',
    p: String(Math.max(opts.page ?? 1, 1)),
    pageNum: String(Math.max(opts.page ?? 1, 1)),
    pageNumber: String(Math.max(opts.page ?? 1, 1)),
    _: String(Date.now()),
  });

  const json = await fetchJson(`${baseUrl()}/report/${endpoint}?${params.toString()}`);
  const data = json.data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

/** 详情页地址（拼 encodeUrl） */
export function detailUrl(type: ResearchReportType, encodeUrl: string): string {
  return `https://data.eastmoney.com/report/${DETAIL_PAGE[type]}.jshtml?encodeUrl=${encodeUrl}`;
}

/** PDF 全文地址（best-effort，按 infoCode 拼） */
export function pdfUrl(infoCode: string): string | null {
  return infoCode ? `https://pdf.dfcfw.com/pdf/H3_${infoCode}_1.pdf` : null;
}

/** 从详情页 HTML 抽取 .ctx-content 正文纯文本 */
function extractCtxContent(html: string): string | null {
  const startMatch = /<div[^>]*\bctx-content\b[^>]*>/i.exec(html);
  if (!startMatch) return null;
  const start = startMatch.index;
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = start;
  let depth = 0;
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    } else {
      depth += 1;
    }
  }
  if (end === -1) return null;
  const text = html
    .slice(start, end)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}

// ===================== 上市公司公告（东方财富公告大全，免费/无鉴权） =====================
// 列表 np-anotice-stock（含标题/类型 column_name/标的/art_code），正文 np-cnotice-stock 直出 notice_content。
// 注意：这两个接口仅在带 cb（JSONP 回调）时返回真实数据，否则返回字段类型模板；
// 且 notice_content 含未转义的原始换行/制表符（非法 JSON 控制符），需在字符串内转义后再 JSON.parse。

const ANN_LIST_BASE = 'https://np-anotice-stock.eastmoney.com';
const ANN_CONTENT_BASE = 'https://np-cnotice-stock.eastmoney.com';
const ANN_CB = 'jsonp_sa'; // 固定 JSONP 回调名（仅用于触发真实数据返回）

/** 仅转义 JSON 字符串内部的原始控制符（结构空白处不动），使东财 JSONP 正文可被严格解析 */
function escapeControlInsideStrings(json: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inStr) {
      if (esc) {
        out += c;
        esc = false;
        continue;
      }
      if (c === '\\') {
        out += c;
        esc = true;
        continue;
      }
      if (c === '"') {
        out += c;
        inStr = false;
        continue;
      }
      const code = c.charCodeAt(0);
      if (code <= 0x1f) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else out += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += c;
    } else {
      if (c === '"') inStr = true;
      out += c;
    }
  }
  return out;
}

/** 拉取东财 JSONP 接口并解析（剥离 cb 包裹 + 字符串内控制符转义）；失败抛错 */
async function fetchAnnJsonp(url: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
  const raw = await requestText({
    sourceId: 'research',
    url,
    timeoutMs,
    headers: { 'User-Agent': DEFAULT_UA, Referer: REFERER },
    errorLabel: '公告接口 HTTP',
  });
  const text = raw.trim();
  const m = text.match(/^[A-Za-z0-9_$.]+\(([\s\S]*)\)\s*;?\s*$/);
  const body = m ? m[1] : text;
  return JSON.parse(escapeControlInsideStrings(body)) as Record<string, unknown>;
}

/** 东方财富公告原文详情页 URL（人读，非接口） */
export function announcementUrl(code: string, artCode: string): string {
  return `https://data.eastmoney.com/notices/detail/${code}/${artCode}.html`;
}

export interface FetchAnnListOpts {
  /** 翻页页数（每页 pageSize 条，按时间倒序），默认 3 */
  pages?: number;
  /** 每页条数，默认 100 */
  pageSize?: number;
}

/** 拉取全市场公告列表原始条目（按时间倒序，合并多页 data.list） */
export async function fetchAnnouncementList(opts: FetchAnnListOpts = {}): Promise<Record<string, unknown>[]> {
  const pages = Math.min(Math.max(opts.pages ?? 3, 1), 8);
  const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 100);
  const out: Record<string, unknown>[] = [];
  for (let p = 1; p <= pages; p++) {
    const params = new URLSearchParams({
      cb: ANN_CB,
      sr: '-1',
      page_size: String(pageSize),
      page_index: String(p),
      ann_type: 'A',
      client_source: 'web',
      f_node: '0',
      s_node: '0',
    });
    try {
      const json = await fetchAnnJsonp(`${ANN_LIST_BASE}/api/security/ann?${params.toString()}`);
      const data = json.data as Record<string, unknown> | undefined;
      const list = data?.list;
      if (Array.isArray(list)) out.push(...(list as Record<string, unknown>[]));
    } catch {
      break; // 翻页失败即止，用已拿到的部分
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  return out;
}

/** 拉取单条公告正文（notice_content 纯文本）；失败返回 null */
export async function fetchAnnouncementContent(artCode: string, timeoutMs = 15000): Promise<string | null> {
  if (!artCode) return null;
  const params = new URLSearchParams({
    cb: ANN_CB,
    art_code: artCode,
    client_source: 'web',
    page_index: '1',
  });
  try {
    const json = await fetchAnnJsonp(`${ANN_CONTENT_BASE}/api/content/ann?${params.toString()}`, timeoutMs);
    const data = json.data as Record<string, unknown> | undefined;
    const content = typeof data?.notice_content === 'string' ? (data.notice_content as string) : '';
    const text = content.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return text || null;
  } catch {
    return null;
  }
}

/** 拉取并抽取研报正文；失败返回 null（由 service 决定回退） */
export async function fetchContent(
  type: ResearchReportType,
  encodeUrl: string,
  timeoutMs = 15000,
): Promise<string | null> {
  const url = detailUrl(type, encodeUrl);
  try {
    const html = await requestText({
      sourceId: 'research',
      url,
      timeoutMs,
      headers: { 'User-Agent': DEFAULT_UA, Referer: REFERER },
      errorLabel: '研报正文',
    });
    return extractCtxContent(html);
  } catch {
    return null;
  }
}
