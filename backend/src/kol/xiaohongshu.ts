import { createHash } from 'node:crypto';
import { requestJson, requestText, requestTextDetail } from '../datasource/httpClient';
import { getValue } from '../settings';

// 小红书博主笔记取数客户端（服务端渲染页直连 www.xiaohongshu.com）。
//
// 小红书的 web API（edith.xiaohongshu.com/api/sns/web/v1/user_posted）带三重签名
// （x-s / x-t / x-s-common），其中 x-s-common 由页面 axios 拦截器注入，且签名与 cookie、
// 浏览器指纹绑定校验，自行复刻是季度级失效的维护负担。因此这里走 SSR 页解析：
//   1. GET www.xiaohongshu.com/user/profile/<id>  → window.__INITIAL_STATE__ 拿资料 + 笔记列表
//   2. GET www.xiaohongshu.com/explore/<noteId>   → 同一个 __INITIAL_STATE__ 拿标题/正文/发布时间
// 全程纯 HTTP，不需要签名也不需要无头浏览器（实测无头浏览器直开主页反而被判风控，
// 而无 JS 的裸请求正常返回 200）。此路径与 RSSHub 官方小红书路由一致。
//
// 关键限制：免登录时服务端会把 noteId 抹成空串，只剩标题/封面/点赞数，
// 拿不到正文、发布时间与可跳转链接。填入 Cookie 后才有完整数据，见 service.ts 的降级处理。

export class XhsError extends Error {
  /** Cookie 失效 / 被判风控，供上层提示重新配置 */
  authFailure?: boolean;
}

const SOURCE_ID = 'xiaohongshu';
const ORIGIN = 'https://www.xiaohongshu.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 小红书 userId / noteId 均为 24 位十六进制 */
const ID_RE = /^[0-9a-f]{24}$/;

function authError(message: string): XhsError {
  const e = new XhsError(message);
  e.authFailure = true;
  return e;
}

/** 设置页填的登录 Cookie；空串表示走免登录降级模式 */
export function getCookie(): string {
  return getValue('xhsCookie').trim();
}

/** 是否已配置 Cookie（决定能否拿到正文与发布时间） */
export function hasCookie(): boolean {
  return getCookie().length > 0;
}

function pageHeaders(): Record<string, string> {
  const cookie = getCookie();
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

/**
 * 从 SSR 页里抠出 window.__INITIAL_STATE__。
 * 小红书直接把 JS 字面量塞进 script，里面的 undefined 不是合法 JSON，需先替换。
 * 该替换会误伤正文中恰好出现的 "undefined" 字样，属已知代价（RSSHub 同款处理）。
 */
export function extractInitialState(html: string): Record<string, unknown> {
  const m = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html);
  if (!m) {
    // 风控页不含该脚本，与「页面结构改版」表现一致，统一提示排查方向
    if (html.includes('安全限制') || html.includes('fe-verify-box')) {
      throw authError('小红书风控拦截（疑似 Cookie 失效或请求过于频繁）');
    }
    throw new XhsError('小红书页面未包含 __INITIAL_STATE__（疑似风控或页面改版）');
  }
  try {
    return JSON.parse(m[1].replaceAll('undefined', 'null')) as Record<string, unknown>;
  } catch {
    throw new XhsError('小红书 __INITIAL_STATE__ 解析失败（疑似页面改版）');
  }
}

/** 小红书把部分 SSR 字段包成 Vue ref 的序列化形态，取值需先剥 _rawValue */
function unref<T>(v: unknown): T {
  const o = v as { _rawValue?: T } | undefined;
  return (o?._rawValue ?? v) as T;
}

/** 单条笔记在列表页的引用信息（正文需另请求详情页） */
export interface XhsNoteRef {
  /** 24 位 noteId；免登录时小红书会抹成空串 */
  noteId: string;
  /** 访问详情页所需令牌 */
  xsecToken: string;
  /** 列表页标题（可能被截断，详情页有完整标题） */
  title: string;
  /** 点赞数（列表页返回展示串，如 "1万+"） */
  likedCount: string;
  /** normal / video */
  type: string;
  /** 是否置顶 */
  sticky: boolean;
}

/** 博主主页资料 + 笔记列表 */
export interface XhsProfile {
  userId: string;
  /** 小红书号（用户可见的账号名，与 userId 是两套 ID），用于和 App 里的账号核对 */
  redId: string;
  nickname: string;
  avatar: string;
  /** 个人简介，用于填「认证信息」位 */
  desc: string;
  /** 粉丝数展示串，如 "1万+" */
  fansCount: string;
  notes: XhsNoteRef[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * 从 HTML 里收集 noteId → xsec_token 映射。
 * __INITIAL_STATE__ 的 noteCard.xsecToken 是主来源，这里作为兜底：
 * 登录态下笔记列表是服务端渲染的，a 标签 href 上带着同样的令牌。
 */
function collectTokensFromHtml(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/\/explore\/([0-9a-f]{24})\?xsec_token=([^"&\s]+)/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

/** 拉取博主主页：资料 + 首屏笔记列表（约 30 条，含置顶） */
export async function fetchUserProfile(userId: string, signal?: AbortSignal): Promise<XhsProfile> {
  if (!ID_RE.test(userId)) throw new XhsError(`小红书用户 ID 格式非法：${userId}`);
  const html = await requestText({
    sourceId: SOURCE_ID,
    url: `${ORIGIN}/user/profile/${userId}`,
    headers: pageHeaders(),
    timeoutMs: 20_000,
    maxAttempts: 2,
    retryBaseMs: 1200,
    errorLabel: `小红书博主(${userId})主页`,
    makeError: (m) => new XhsError(m),
    signal,
  });

  const state = extractInitialState(html);
  const user = state.user as Record<string, unknown> | undefined;
  if (!user) throw new XhsError('小红书主页未返回用户数据（疑似页面改版）');

  const pageData = unref<Record<string, unknown>>(user.userPageData) ?? {};
  const basic = (pageData.basicInfo ?? {}) as Record<string, unknown>;
  if (!basic.nickname) {
    const reason = str((pageData.result as Record<string, unknown> | undefined)?.message);
    throw new XhsError(`小红书未返回博主资料${reason ? `：${reason}` : '（用户不存在或已注销）'}`);
  }

  const interactions = (pageData.interactions ?? []) as Array<Record<string, unknown>>;
  const fans = interactions.find((i) => str(i.type) === 'fans');

  // notes 是按 tab 分组的二维数组，下标 0 为「笔记」tab；收藏 tab 是他人内容不能混入
  const tabs = unref<unknown[][]>(user.notes) ?? [];
  const rawNotes = (tabs[0] ?? []) as Array<Record<string, unknown>>;
  const tokens = collectTokensFromHtml(html);

  const notes: XhsNoteRef[] = [];
  for (const item of rawNotes) {
    const card = (item.noteCard ?? {}) as Record<string, unknown>;
    const noteId = str(card.noteId) || str(item.id);
    const interact = (card.interactInfo ?? {}) as Record<string, unknown>;
    notes.push({
      noteId,
      xsecToken: str(card.xsecToken) || tokens.get(noteId) || '',
      title: str(card.displayTitle),
      likedCount: str(interact.likedCount),
      type: str(card.type),
      sticky: interact.sticky === true,
    });
  }

  return {
    userId,
    redId: str(basic.redId),
    nickname: str(basic.nickname),
    avatar: str(basic.imageb) || str(basic.images),
    desc: str(basic.desc),
    fansCount: str(fans?.count),
    notes,
  };
}

/** 笔记里的一张图 */
export interface XhsImage {
  /** 图床直链。路径里带分钟级时间戳，疑似短时效签名，取到后应尽快落盘 */
  url: string;
  /** 图床文件 id，用作本地缓存文件名（同一张图跨轮次稳定） */
  fileId: string;
  width: number;
  height: number;
}

/** 笔记详情（只取入库需要的字段） */
export interface XhsNoteDetail {
  title: string;
  /** 已清洗的正文 */
  desc: string;
  /** 发布时间 ISO */
  createdAt: string;
  likedCount: number;
  commentCount: number;
  shareCount: number;
  /** 笔记配图（视频笔记为封面）。小红书大量信息画在图里，正文往往只是引子 */
  images: XhsImage[];
}

const num = (v: unknown): number => {
  // 小红书互动数可能是 "1万+" 这类展示串，无法解析时按 0 计
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 清洗笔记正文：
 * - `#话题[话题]#` 归一为 `#话题#`，让前端按话题标签渲染
 * - 其余 `[xx]` 表情占位原样保留，前端未收录时会降级成浅色小标签
 */
export function cleanDesc(raw: string): string {
  return raw
    .replaceAll(/#([^#\n]{1,40})\[话题\]#/g, '#$1#')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 解析 note.imageList。
 * urlDefault 是原图，infoList 里还有 WB_PRV（预览）/ WB_DFT（默认）两档，
 * 这里只取 urlDefault：落盘一份即可，前端缩放由 CSS 负责。
 */
export function parseImageList(raw: unknown): XhsImage[] {
  if (!Array.isArray(raw)) return [];
  const out: XhsImage[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    const url = str(item.urlDefault) || str(item.url);
    if (!url) continue;
    out.push({
      url,
      fileId: str(item.fileId),
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
    });
  }
  return out;
}

/** 笔记发布时间（毫秒时间戳）转 ISO；异常值回退空串由调用方处理 */
function msToIso(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** 拼详情页地址（xsec_token 缺失时仍可尝试，小红书多数情况会重定向到风控页） */
export function noteUrl(noteId: string, xsecToken: string): string {
  const q = xsecToken ? `?xsec_token=${xsecToken}&xsec_source=pc_user` : '';
  return `${ORIGIN}/explore/${noteId}${q}`;
}

/** 拉取单篇笔记全文；失败返回 null 由调用方决定是否降级保留标题 */
export async function fetchNoteDetail(
  noteId: string,
  xsecToken: string,
  signal?: AbortSignal,
): Promise<XhsNoteDetail | null> {
  try {
    const html = await requestText({
      sourceId: SOURCE_ID,
      url: noteUrl(noteId, xsecToken),
      headers: { ...pageHeaders(), Referer: `${ORIGIN}/` },
      timeoutMs: 20_000,
      maxAttempts: 2,
      retryBaseMs: 1500,
      errorLabel: `小红书笔记(${noteId})`,
      makeError: (m) => new XhsError(m),
      signal,
    });
    const state = extractInitialState(html);
    const noteState = (state.note ?? {}) as Record<string, unknown>;
    const map = unref<Record<string, unknown>>(noteState.noteDetailMap) ?? {};
    const firstId = str(unref(noteState.firstNoteId)) || noteId;
    const entry = (map[firstId] ?? map[noteId]) as Record<string, unknown> | undefined;
    const note = entry?.note as Record<string, unknown> | undefined;
    if (!note) return null;

    const interact = (note.interactInfo ?? {}) as Record<string, unknown>;
    return {
      title: str(note.title),
      desc: cleanDesc(str(note.desc)),
      createdAt: msToIso(note.time),
      likedCount: num(interact.likedCount),
      commentCount: num(interact.commentCount),
      shareCount: num(interact.shareCount),
      images: parseImageList(note.imageList),
    };
  } catch (e) {
    console.warn(`[kol] 小红书笔记详情拉取失败 noteId=${noteId}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * 免登录降级模式下笔记没有 noteId，用「作者 + 标题」合成稳定主键。
 * 标题不变即幂等，改标题会被当作新笔记——这是没有 noteId 时可接受的代价。
 */
export function syntheticNoteKey(userId: string, title: string): string {
  const h = createHash('sha1').update(`${userId}|${title}`).digest('hex').slice(0, 16);
  return `xhs-t-${userId}-${h}`;
}

/** 从字符串里直接抠 userId（裸 ID 或含 user/profile/ 的地址），抠不到返回空串 */
function matchUserId(s: string): string {
  if (ID_RE.test(s)) return s;
  return /user\/profile\/([0-9a-f]{24})/.exec(s)?.[1] ?? '';
}

/**
 * 展开 App 分享短链（xhslink.com/a/xxx 或 /m/xxx），返回跳转后的长地址。
 * 只能用 GET：社区实测 /m 类型对 HEAD 请求不返回 Location。
 * 这里不跟随重定向，直接读一跳的 Location，省掉抓整页 HTML 的开销。
 */
async function expandShortLink(url: string, signal?: AbortSignal): Promise<string> {
  // 走统一 HTTP 层复用超时/重试/计量，避免这一处成为唯一无超时无限体积的裸 fetch
  const res = await requestTextDetail({
    sourceId: SOURCE_ID,
    url,
    headers: { 'User-Agent': UA },
    redirect: 'manual',
    timeoutMs: 10000,
    maxAttempts: 2,
    signal,
    errorLabel: '小红书分享短链',
    makeError: (m) => new XhsError(m),
  });
  if (res.location) return res.location;
  // 少数短链不走 3xx 而是返回一个带跳转脚本的中间页，从正文里捞
  if (res.status === 200) return res.text;
  throw new XhsError(`小红书分享短链展开失败（HTTP ${res.status}）`);
}

/**
 * 从主页链接、App 分享短链或裸 ID 解析出 24 位 userId；解析不出抛错。
 *
 * 注意小红书号（redId，如 95852292902）不是 userId，两者无公开互查入口：
 * 站内搜索接口需要签名，redId 也不能直接拼进主页地址。因此支持分享短链，
 * 让用户不必去网页版翻主页——在 App 里点分享复制链接即可。
 */
export async function parseUserId(input: string, signal?: AbortSignal): Promise<string> {
  const s = input.trim();
  const direct = matchUserId(s);
  if (direct) return direct;

  // App 分享口令形如「…… http://xhslink.com/a/xxx，复制本条信息，打开【小红书】App……」，
  // 允许整段粘进来，从中捞出短链即可
  const short =
    /https?:\/\/xhslink\.com\/\S+/.exec(s)?.[0] ??
    (/^xhslink\.com\/\S+$/.test(s) ? `https://${s}` : '');
  if (short) {
    const clean = short.split(/[，,。\s]/)[0];
    const expanded = await expandShortLink(clean, signal);
    const fromShort = matchUserId(expanded);
    if (fromShort) return fromShort;
    // 失效/伪造的 token 一律跳到站点首页，这是「链接不可用」最明确的信号
    if (/^https?:\/\/(www\.)?xiaohongshu\.com\/?$/.test(expanded.trim())) {
      throw new XhsError('分享链接已失效，请回 App 重新复制一次（分享链接有时效）');
    }
    throw new XhsError('该分享链接不是博主主页（分享的若是某篇笔记，请改为分享博主主页）');
  }

  if (/^\d{6,}$/.test(s)) {
    throw new XhsError('这是小红书号，不是用户 ID。小红书未开放按小红书号检索，请粘贴博主主页链接或 App 分享链接');
  }
  throw new XhsError('无法识别小红书用户，请粘贴博主主页链接、App 分享链接或 24 位用户 ID');
}

/**
 * 健康探测。
 * 配了 Cookie 就校验 Cookie 是否仍然有效（失效时页面还能打开，但拿不到 noteId，
 * 只探主页会误判为健康）；没配就退化成「主页 SSR 能否解析出笔记」。
 */
export async function ping(signal?: AbortSignal): Promise<void> {
  const cookie = getCookie();
  if (cookie) {
    const json = await requestJson({
      sourceId: SOURCE_ID,
      url: 'https://edith.xiaohongshu.com/api/sns/web/v2/user/me',
      headers: {
        'User-Agent': UA,
        Cookie: cookie,
        Referer: `${ORIGIN}/`,
        Accept: 'application/json, text/plain, */*',
      },
      timeoutMs: 15_000,
      maxAttempts: 2,
      retryBaseMs: 800,
      errorLabel: '小红书登录态校验',
      makeError: (m) => new XhsError(m),
      signal,
    });
    const data = json.data as { user_id?: string } | undefined;
    if (json.code !== 0 || !data?.user_id) {
      throw authError('小红书 Cookie 已失效，请到设置页重新粘贴（有效期约 7-30 天）');
    }
    return;
  }
  // 「一洪财智说」为长期活跃的公开博主，仅用于探测 SSR 链路连通性
  const p = await fetchUserProfile('6437c1bc000000000d01b4c1', signal);
  if (p.notes.length === 0) throw new XhsError('小红书主页返回空笔记列表（疑似风控或页面改版）');
}
