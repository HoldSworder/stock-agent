import type { KolPost, KolSearchResult } from '@stock-agent/shared';
import { requestJson, requestText } from '../datasource/httpClient';
import { getValue } from '../settings';

// 微博大V博文取数客户端（免登录访客态直连 m.weibo.cn）。
//
// 微博现已对个人主页时间线强制风控：裸请求 getIndex 返回 432，.com 域 passport 换来的
// 访客 SUB 也会被判为未登录（ok:-100 跳 sso/signin）。可行路径是 .cn 域三步握手：
//   1. POST visitor.passport.weibo.cn/visitor/genvisitor2  → 访客 SUB / SUBP cookie
//   2. GET  m.weibo.cn/api/config                          → data.st 即 XSRF-TOKEN
//   3. GET  m.weibo.cn/api/container/getIndex              → 带 SUB cookie + X-XSRF-TOKEN 头
// 缺 X-XSRF-TOKEN 即复现 432，这是整个流程的关键。
//
// 注意：此为逆向私有流程，微博风控升级会失效（RSSHub 社区在此反复踩坑）。失效时
// scripts/kol.selfcheck.ts 会第一时间报错；用户也可在设置页填 weiboCookie 走登录态兜底。

export class WeiboError extends Error {
  /** 会话失效（432 / ok:-100），调用方可重建会话后重试一次 */
  sessionExpired?: boolean;
}

const SOURCE_ID = 'weibo';
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
/** 访客会话主动过期时间：微博访客 SUB 寿命不明，20 分钟重建一次足够保守 */
const SESSION_TTL_MS = 20 * 60 * 1000;

interface Session {
  /** Cookie 头完整值 */
  cookie: string;
  /** XSRF-TOKEN（m.weibo.cn/api/config 的 data.st） */
  st: string;
  bornAt: number;
}

let session: Session | null = null;

function sessionError(message: string): WeiboError {
  const e = new WeiboError(message);
  e.sessionExpired = true;
  return e;
}

/** 从 JSONP 回调（window.xxx && xxx({...})）中剥出 JSON */
function unwrapJsonp(text: string): Record<string, unknown> {
  const m = /\(\s*(\{[\s\S]*\})\s*\)/.exec(text);
  if (!m) throw new WeiboError('微博访客接口返回非预期格式（疑似风控页）');
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    throw new WeiboError('微博访客接口响应解析失败');
  }
}

/** 第 1 步：换取访客身份 cookie（SUB/SUBP），失败抛 WeiboError */
async function fetchVisitorCookie(signal?: AbortSignal): Promise<string> {
  const text = await requestText({
    sourceId: SOURCE_ID,
    url: 'https://visitor.passport.weibo.cn/visitor/genvisitor2',
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://m.weibo.cn/',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'cb=visitor_gray_callback&tid=&from=weibo',
    timeoutMs: 12_000,
    maxAttempts: 2,
    retryBaseMs: 600,
    errorLabel: '微博访客身份',
    makeError: (m) => new WeiboError(m),
    signal,
  });
  const json = unwrapJsonp(text);
  const data = json.data as { sub?: string; subp?: string } | undefined;
  if (!data?.sub) throw new WeiboError(`微博访客身份获取失败（retcode=${String(json.retcode)}）`);
  return data.subp ? `SUB=${data.sub}; SUBP=${data.subp}` : `SUB=${data.sub}`;
}

/** 第 2 步：取 XSRF-TOKEN（缺此头 getIndex 恒返回 432） */
async function fetchXsrfToken(cookie: string, signal?: AbortSignal): Promise<string> {
  const json = await requestJson({
    sourceId: SOURCE_ID,
    url: 'https://m.weibo.cn/api/config',
    headers: {
      'User-Agent': UA,
      Cookie: cookie,
      Referer: 'https://m.weibo.cn/',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/plain, */*',
    },
    timeoutMs: 12_000,
    maxAttempts: 2,
    retryBaseMs: 600,
    errorLabel: '微博 XSRF-TOKEN',
    makeError: (m) => new WeiboError(m),
    signal,
  });
  const st = (json.data as { st?: string } | undefined)?.st;
  if (!st) throw new WeiboError('微博 XSRF-TOKEN 获取失败（api/config 无 data.st）');
  return st;
}

/**
 * 取当前会话：优先用设置页填的 weiboCookie（登录态，配额更宽），否则走访客态握手。
 * 会话在内存缓存 20 分钟，force=true 时强制重建（用于 432/ok:-100 后重试）。
 */
async function getSession(force = false, signal?: AbortSignal): Promise<Session> {
  if (!force && session && Date.now() - session.bornAt < SESSION_TTL_MS) return session;
  const manual = getValue('weiboCookie').trim();
  const cookie = manual || (await fetchVisitorCookie(signal));
  const st = await fetchXsrfToken(cookie, signal);
  session = { cookie, st, bornAt: Date.now() };
  return session;
}

/** 带会话请求 m.weibo.cn JSON 接口；会话失效自动重建一次后重试 */
async function requestWithSession(
  url: string,
  referer: string,
  errorLabel: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const s = await getSession(attempt > 1, signal);
    try {
      const json = await requestJson({
        sourceId: SOURCE_ID,
        url,
        headers: {
          'User-Agent': UA,
          Cookie: s.cookie,
          Referer: referer,
          'X-Requested-With': 'XMLHttpRequest',
          'MWeibo-Pwa': '1',
          'X-XSRF-TOKEN': s.st,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        timeoutMs: 15_000,
        // 会话失效需重建后才有意义，故单次尝试，由本函数外层控制重试
        maxAttempts: 1,
        errorLabel,
        makeError: (m) => (m.includes('432') ? sessionError(m) : new WeiboError(m)),
        signal,
      });
      // ok:-100 表示被判未登录，与 432 同属会话失效
      if (json.ok !== 1 && json.ok !== undefined) {
        throw sessionError(`${errorLabel}被拒（ok=${String(json.ok)}，疑似访客会话失效）`);
      }
      return json;
    } catch (e) {
      const expired = e instanceof WeiboError && e.sessionExpired;
      if (!expired || attempt === 2) throw e;
    }
  }
  throw new WeiboError(`${errorLabel}失败`);
}

/** 微博原始 mblog 结构（仅取用到的字段） */
interface Mblog {
  id?: string;
  bid?: string;
  text?: string;
  created_at?: string;
  isLongText?: boolean;
  isTop?: number;
  reposts_count?: number;
  comments_count?: number;
  attitudes_count?: number;
  user?: { id?: number | string; screen_name?: string; profile_image_url?: string };
  retweeted_status?: { text?: string; user?: { screen_name?: string } };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** 微博外链包了一层跳转（weibo.cn/sinaurl?u=<encoded>），还原成真实目标地址 */
function unwrapSinaUrl(href: string): string {
  const m = /[?&]u=([^&]+)/.exec(href);
  if (!m || !/sinaurl/i.test(href)) return href;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return href;
  }
}

/**
 * 清洗微博正文 HTML：话题/@ 等锚文本保留（#xx# 本身就在文本里），
 * 表情图转成其 alt 文案，<br> 转换行，其余标签剥掉。
 *
 * 外链例外：微博把 URL 显示成「网页链接」这类占位文字，锚文本本身没有信息量且不可点。
 * 这类锚点整体替换为真实 URL，前端才能渲染成可点击链接。话题锚点不受影响（其文本 #xx# 有意义）。
 */
export function stripHtml(html: string): string {
  return html
    .replace(
      /<a\s[^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?(网页链接|查看图片|微博视频|网页链接)(?:(?!<\/a>)[\s\S])*?<\/a>/gi,
      (_all, href: string) => ` ${unwrapSinaUrl(href)} `,
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img[^>]*alt=["']([^"']*)["'][^>]*>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 微博时间串（如 "Fri Jul 31 10:00:10 +0800 2026"）转 ISO；解析失败回退空串 */
function weiboTimeToIso(raw: string): string {
  if (!raw) return '';
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/** 单条 mblog → KolPost；缺 bid 或时间视为无效返回 null */
function mapPost(m: Mblog): KolPost | null {
  const bid = String(m.bid ?? '').trim();
  const createdAt = weiboTimeToIso(String(m.created_at ?? ''));
  if (!bid || !createdAt) return null;
  const uid = String(m.user?.id ?? '');
  const rt = m.retweeted_status;
  return {
    bid,
    uid,
    platform: 'weibo',
    screenName: String(m.user?.screen_name ?? ''),
    avatar: String(m.user?.profile_image_url ?? ''),
    text: stripHtml(String(m.text ?? '')),
    createdAt,
    url: `https://m.weibo.cn/detail/${m.id ?? bid}`,
    isRetweet: !!rt,
    retweetText: rt ? stripHtml(`${rt.user?.screen_name ? `@${rt.user.screen_name}: ` : ''}${rt.text ?? ''}`) : null,
    reposts: num(m.reposts_count),
    comments: num(m.comments_count),
    attitudes: num(m.attitudes_count),
    /** 正文被截断需补拉全文，由 service 层决定是否补 */
    isLongText: !!m.isLongText,
    isTop: m.isTop === 1,
  };
}

/**
 * 拉取指定大V最新博文（单页约 10 条，含置顶）。
 * 置顶帖的 createdAt 可能是很久以前（实测但斌置顶为 2024 年），由 service 层按 isTop 处理。
 */
export async function fetchUserTimeline(uid: string, signal?: AbortSignal): Promise<KolPost[]> {
  const json = await requestWithSession(
    `https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}&containerid=107603${uid}`,
    `https://m.weibo.cn/u/${uid}`,
    `微博大V(${uid})时间线`,
    signal,
  );
  const cards = (json.data as { cards?: Array<{ mblog?: Mblog }> } | undefined)?.cards ?? [];
  const out: KolPost[] = [];
  for (const c of cards) {
    if (!c.mblog) continue;
    const p = mapPost(c.mblog);
    if (p) out.push(p);
  }
  return out;
}

/** 拉取长文全文（isLongText 的博文正文会被截断）；失败返回 null 由调用方保留截断正文 */
export async function fetchLongText(bid: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const json = await requestWithSession(
      `https://m.weibo.cn/statuses/extend?id=${bid}`,
      `https://m.weibo.cn/detail/${bid}`,
      `微博长文(${bid})`,
      signal,
    );
    const full = (json.data as { longTextContent?: string } | undefined)?.longTextContent;
    const text = full ? stripHtml(full) : '';
    return text || null;
  } catch (e) {
    console.warn(`[kol] 长文补拉失败 bid=${bid}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** 按昵称搜索微博用户，供页面添加大V；返回粉丝数与认证信息辅助辨别真身 */
export async function searchUsers(q: string, signal?: AbortSignal): Promise<KolSearchResult[]> {
  const containerid = encodeURIComponent(`100103type=3&q=${q}`);
  const json = await requestWithSession(
    `https://m.weibo.cn/api/container/getIndex?containerid=${containerid}&page_type=searchall`,
    'https://m.weibo.cn/',
    `微博用户搜索(${q})`,
    signal,
  );
  interface UserCard {
    user?: {
      id?: number | string;
      screen_name?: string;
      profile_image_url?: string;
      followers_count?: number | string;
      verified_reason?: string;
    };
  }
  const cards = (json.data as { cards?: Array<UserCard & { card_group?: UserCard[] }> } | undefined)?.cards ?? [];
  const out: KolSearchResult[] = [];
  const seen = new Set<string>();
  for (const card of cards) {
    for (const g of card.card_group ?? [card]) {
      const u = g.user;
      const uid = String(u?.id ?? '').trim();
      if (!u || !uid || seen.has(uid)) continue;
      seen.add(uid);
      out.push({
        uid,
        screenName: String(u.screen_name ?? ''),
        avatar: String(u.profile_image_url ?? ''),
        // 微博返回的是「1313.3万」这类展示串，原样透传由前端展示
        followersCount: String(u.followers_count ?? ''),
        verifiedReason: String(u.verified_reason ?? ''),
      });
    }
  }
  return out;
}

/** 健康探测：能完成访客握手并取到 1 条博文即在线 */
export async function ping(signal?: AbortSignal): Promise<void> {
  // 财经网（官方蓝V，长期活跃），仅用于探测流程连通性
  const list = await fetchUserTimeline('1642088277', signal);
  if (list.length === 0) throw new WeiboError('微博时间线返回空（疑似风控升级）');
}
