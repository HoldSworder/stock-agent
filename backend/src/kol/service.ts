import { and, desc, eq, inArray, lt, max } from 'drizzle-orm';
import type {
  KolAccount,
  KolImage,
  KolPlatform,
  KolPost,
  KolRefreshResult,
  KolSearchResult,
} from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { nowIso } from '../util';
import { getValue } from '../settings';
import { cacheImages, pruneImages } from './images';
import { fetchLongText, fetchUserTimeline, searchUsers, WeiboError } from './weibo';
import {
  fetchNoteDetail,
  fetchUserProfile,
  hasCookie,
  noteUrl,
  parseUserId,
  syntheticNoteKey,
  XhsError,
} from './xiaohongshu';

// 大V观点服务：名单增删、发帖抓取入库、时间流读取。
// 抓取串行 + 间隔，避免触发平台限流。
// 微博实测 0.5s 间隔连续 8 次仍全部 200；小红书风控更严且逐篇拉正文请求量大，间隔取得更保守。

/** 微博账号间隔（毫秒），保守避开限流 */
const ACCOUNT_GAP_MS = 800;
/** 小红书账号间隔（毫秒） */
const XHS_ACCOUNT_GAP_MS = 3000;
/** 小红书笔记详情请求间隔（毫秒），社区实测 ≥2.5s 基本不触发风控 */
const XHS_DETAIL_GAP_MS = 2500;
/**
 * 每轮详情请求总量上限（整轮跨账号共享，不是每账号）。
 * 小红书按请求密度风控，实测密集请求会直接让 web_session 失效，故取值保守。
 */
const XHS_DETAIL_MAX = 10;
/** 抓取窗口默认天数（设置页未配置或填了非法值时的兜底） */
const DEFAULT_FETCH_DAYS = 2;
/** 置顶帖若早于此天数则跳过（置顶常年不变，避免刷屏；实测但斌置顶为 2024 年） */
const TOP_POST_MAX_AGE_DAYS = 7;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 默认关注名单：财经领域高活跃账号，用户可在页面自行增删。
// UID 与认证串均经 /api/kol/search 实测核对，勿凭印象改动（改错只会拉到同名小号）。
const SEED_ACCOUNTS: Array<Pick<KolAccount, 'uid' | 'screenName' | 'verifiedReason'>> = [
  { uid: '1249424622', screenName: '但斌', verifiedReason: '深圳东方港湾投资管理股份有限公司董事长' },
  { uid: '1642088277', screenName: '财经网', verifiedReason: '财经网官方微博' },
  { uid: '2258727970', screenName: '央视财经', verifiedReason: '中央广播电视总台' },
  { uid: '1638782947', screenName: '新浪财经', verifiedReason: '新浪财经官方微博' },
  { uid: '1702925432', screenName: '第一财经', verifiedReason: '第一财经' },
  { uid: '1664176597', screenName: '证券时报', verifiedReason: '证券时报官方微博' },
  { uid: '1663937380', screenName: '财新网', verifiedReason: '财新网官方微博' },
];

/** 首次启动播种默认名单；表非空则跳过（用户删过的不再回填） */
export function seedAccounts(): void {
  const existing = db.select({ uid: schema.kolAccounts.uid }).from(schema.kolAccounts).all();
  if (existing.length > 0) return;
  const now = nowIso();
  db.insert(schema.kolAccounts)
    .values(
      SEED_ACCOUNTS.map((a, i) => ({
        uid: a.uid,
        platform: 'weibo' as const,
        screenName: a.screenName,
        avatar: null,
        verifiedReason: a.verifiedReason,
        followersCount: null,
        enabled: 1,
        sortOrder: i,
        addedAt: now,
      })),
    )
    .onConflictDoNothing()
    .run();
  console.log(`[kol] 已播种默认大V名单 ${SEED_ACCOUNTS.length} 个`);
}

type AccountRow = typeof schema.kolAccounts.$inferSelect;

/** 库里 platform 为自由文本，读出时收敛到已知平台，脏数据一律按微博处理 */
const toPlatform = (v: string): KolPlatform => (v === 'xiaohongshu' ? 'xiaohongshu' : 'weibo');

function toAccount(r: AccountRow): KolAccount {
  return {
    uid: r.uid,
    platform: toPlatform(r.platform),
    screenName: r.screenName,
    redId: r.redId ?? '',
    avatar: r.avatar ?? '',
    verifiedReason: r.verifiedReason ?? '',
    followersCount: r.followersCount ?? '',
    enabled: r.enabled === 1,
    addedAt: r.addedAt,
  };
}

/** 关注名单（按 sortOrder 升序） */
export function listAccounts(): KolAccount[] {
  return db
    .select()
    .from(schema.kolAccounts)
    .orderBy(schema.kolAccounts.sortOrder)
    .all()
    .map(toAccount);
}

/**
 * 添加大V（uid 已存在则更新昵称等资料，保持幂等）。
 * 小红书候选项来自主页链接，前端拿不到昵称头像，这里现场抓一次主页回填。
 */
export async function addAccount(input: KolSearchResult): Promise<KolAccount> {
  const platform = input.platform ?? 'weibo';
  let uid = input.uid.trim();
  let { screenName, avatar, verifiedReason, followersCount, redId } = input;

  if (platform === 'xiaohongshu') {
    uid = await parseUserId(uid);
    // 抓不到资料就不让加，避免名单里留一条只有 ID 的空壳
    const p = await fetchUserProfile(uid);
    screenName = p.nickname;
    avatar = p.avatar;
    verifiedReason = p.desc;
    followersCount = p.fansCount;
    redId = p.redId;
  } else if (!/^\d+$/.test(uid)) {
    throw new Error('微博 UID 必须为纯数字');
  }

  // 用行数当 sortOrder 会在删过账号后与存量值相撞，取现有最大值 +1
  const maxOrder =
    db.select({ v: max(schema.kolAccounts.sortOrder) }).from(schema.kolAccounts).get()?.v ?? -1;
  const row = {
    uid,
    platform,
    screenName: screenName || uid,
    redId: redId || null,
    avatar: avatar || null,
    verifiedReason: verifiedReason || null,
    followersCount: followersCount || null,
    enabled: 1,
    sortOrder: maxOrder + 1,
    addedAt: nowIso(),
  };
  db.insert(schema.kolAccounts)
    .values(row)
    .onConflictDoUpdate({
      target: schema.kolAccounts.uid,
      set: {
        platform: row.platform,
        screenName: row.screenName,
        redId: row.redId,
        avatar: row.avatar,
        verifiedReason: row.verifiedReason,
        followersCount: row.followersCount,
      },
    })
    .run();
  const saved = db
    .select()
    .from(schema.kolAccounts)
    .where(eq(schema.kolAccounts.uid, uid))
    .get();
  if (!saved) throw new Error('大V添加失败');
  return toAccount(saved);
}

/** 删除大V及其历史发帖 */
export function removeAccount(uid: string): boolean {
  const existing = db.select().from(schema.kolAccounts).where(eq(schema.kolAccounts.uid, uid)).get();
  if (!existing) return false;
  db.delete(schema.kolPosts).where(eq(schema.kolPosts.uid, uid)).run();
  db.delete(schema.kolAccounts).where(eq(schema.kolAccounts.uid, uid)).run();
  return true;
}

/** 启停大V（暂停后不再参与定时抓取，历史发帖保留） */
export function toggleAccount(uid: string, enabled: boolean): boolean {
  const existing = db.select().from(schema.kolAccounts).where(eq(schema.kolAccounts.uid, uid)).get();
  if (!existing) return false;
  db.update(schema.kolAccounts)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(schema.kolAccounts.uid, uid))
    .run();
  return true;
}

/** 已入库笔记的发布时间（bid → ISO），用于零请求判断是否已超出抓取窗口 */
function knownCreatedAt(bids: string[]): Map<string, string> {
  if (bids.length === 0) return new Map();
  const rows = db
    .select({ bid: schema.kolPosts.bid, createdAt: schema.kolPosts.createdAt })
    .from(schema.kolPosts)
    .where(inArray(schema.kolPosts.bid, bids))
    .all();
  return new Map(rows.map((r) => [r.bid, r.createdAt]));
}

/**
 * 抓取窗口下界（ISO）：早于此时间的发帖不再收取。
 * 天数由设置页按平台配置，非法值回退默认值。
 */
export function fetchCutoff(platform: KolPlatform): string {
  const raw = getValue(platform === 'weibo' ? 'weiboFetchDays' : 'xhsFetchDays');
  const days = Number(raw);
  const safe = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : DEFAULT_FETCH_DAYS;
  return new Date(Date.now() - safe * 24 * 3600 * 1000).toISOString();
}

/** 配图 JSON 反序列化；脏数据按无图处理，不因一条坏记录整页报错 */
function parseImages(raw: string | null): KolImage[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as KolImage[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 时间流：按发布时间倒序，可按大V或平台过滤 */
export function feed(uid?: string, limit = 50, platform?: KolPlatform): KolPost[] {
  const conds = [
    ...(uid ? [eq(schema.kolPosts.uid, uid)] : []),
    ...(platform ? [eq(schema.kolPosts.platform, platform)] : []),
  ];
  const base = db.select().from(schema.kolPosts);
  const rows = (conds.length > 0 ? base.where(and(...conds)) : base)
    .orderBy(desc(schema.kolPosts.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200))
    .all();
  return rows.map((r) => ({
    bid: r.bid,
    uid: r.uid,
    platform: toPlatform(r.platform),
    screenName: r.screenName,
    avatar: r.avatar ?? '',
    text: r.text,
    createdAt: r.createdAt,
    url: r.url ?? `https://m.weibo.cn/detail/${r.bid}`,
    isRetweet: r.isRetweet === 1,
    retweetText: r.retweetText,
    reposts: r.reposts,
    comments: r.comments,
    attitudes: r.attitudes,
    images: parseImages(r.images),
    titleOnly: r.titleOnly === 1,
  }));
}

/** 置顶帖是否已过期（超过 TOP_POST_MAX_AGE_DAYS 的置顶不入库，避免长期占据流顶部） */
function isStaleTop(post: { isTop?: boolean; createdAt: string }): boolean {
  if (!post.isTop) return false;
  const age = Date.now() - new Date(post.createdAt).getTime();
  return age > TOP_POST_MAX_AGE_DAYS * 24 * 3600 * 1000;
}

/** 已入库的 bid 集合（用于判定新增数并跳过重复补拉正文） */
function existingBids(bids: string[]): Set<string> {
  if (bids.length === 0) return new Set();
  const rows = db
    .select({ bid: schema.kolPosts.bid })
    .from(schema.kolPosts)
    .where(inArray(schema.kolPosts.bid, bids))
    .all();
  return new Set(rows.map((r) => r.bid));
}

/** 抓取回填账号头像/昵称/小红书号，免得种子名单一直没头像、老数据一直没小红书号 */
function backfillProfile(
  account: AccountRow,
  screenName: string,
  avatar: string,
  redId?: string,
): void {
  const needRedId = !!redId && account.redId !== redId;
  if (account.avatar && account.screenName === screenName && !needRedId) return;
  db.update(schema.kolAccounts)
    .set({
      avatar: avatar || account.avatar,
      screenName: screenName || account.screenName,
      redId: redId || account.redId,
    })
    .where(eq(schema.kolAccounts.uid, account.uid))
    .run();
}

/** 抓取单个微博大V并入库，返回新增条数 */
async function refreshWeiboAccount(account: AccountRow, signal?: AbortSignal): Promise<number> {
  // 微博时间线每条自带 created_at，按抓取窗口过滤是纯本地筛选，不产生额外请求。
  // 置顶帖时间可能很旧但内容仍在置顶位，由 isStaleTop 单独判定，不走窗口。
  const cutoff = fetchCutoff('weibo');
  const posts = (await fetchUserTimeline(account.uid, signal)).filter(
    (p) => !isStaleTop(p) && (p.isTop || p.createdAt >= cutoff),
  );
  if (posts.length === 0) return 0;
  const known = existingBids(posts.map((p) => p.bid));
  const now = nowIso();
  let inserted = 0;

  for (const p of posts) {
    const isNew = !known.has(p.bid);
    // 长文正文被截断，仅新帖补拉全文（已入库的正文已是全文，避免重复请求）
    let text = p.text;
    if (isNew && p.isLongText) {
      const full = await fetchLongText(p.bid, signal);
      if (full) text = full;
    }
    db.insert(schema.kolPosts)
      .values({
        bid: p.bid,
        uid: account.uid,
        platform: 'weibo',
        screenName: p.screenName || account.screenName,
        avatar: p.avatar || account.avatar,
        text,
        createdAt: p.createdAt,
        url: p.url,
        isRetweet: p.isRetweet ? 1 : 0,
        retweetText: p.retweetText,
        reposts: p.reposts,
        comments: p.comments,
        attitudes: p.attitudes,
        titleOnly: 0,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.kolPosts.bid,
        // 互动数会随时间增长，复抓时刷新；正文保持首次入库的全文
        set: {
          reposts: p.reposts,
          comments: p.comments,
          attitudes: p.attitudes,
          fetchedAt: now,
        },
      })
      .run();
    if (isNew) inserted += 1;
  }

  if (posts[0]) backfillProfile(account, posts[0].screenName, posts[0].avatar);
  return inserted;
}

/**
 * 一轮抓取内跨账号共享的详情请求预算（整轮共享，不是每账号）。
 *
 * 原先预算是「每账号 10 篇」，账号数一多请求量就线性膨胀（5 个账号 = 55 次/轮）。
 * 配图回填又让「需要详情」的笔记从「仅新笔记」扩大到「新笔记 + 存量缺图笔记」，
 * 等于每轮都把预算打满。小红书对请求密度很敏感，实测会直接让登录态失效，
 * 因此改成整轮共享一份预算，加账号不再放大请求量。
 */
interface DetailBudget {
  /** 本轮剩余的详情请求数 */
  left: number;
  /** 是否已经发过详情请求（决定要不要先 sleep 间隔） */
  used: boolean;
}

/**
 * 抓取单个小红书博主并入库，返回新增条数。
 *
 * 时间语义是这里最容易出错的地方，分三种情况：
 *  1. 有 Cookie 且拉到详情 → createdAt 是真实发布时间，正常入库；
 *  2. 有 Cookie 但本轮没轮到补拉（每轮限量）或详情请求失败 → 跳过不入库，下轮再补。
 *     绝不能拿抓取时刻当发布时间，否则几个月前的老笔记会顶着「刚刚」霸占整个时间流；
 *  3. 完全没 Cookie → 小红书把 noteId 抹成空串，只能降级为「仅标题」记录：
 *     用「作者+标题」合成主键保证幂等，时间取首次抓到的时刻（前端会标注非发布时间）。
 *
 * 从降级模式升级到全文模式后，同一篇笔记会以真实 noteId 重新入库，
 * 旧的合成键记录成了带假时间的重影，因此在确认 Cookie 生效时一并清掉。
 */
async function refreshXhsAccount(
  account: AccountRow,
  budget: DetailBudget,
  signal?: AbortSignal,
): Promise<number> {
  const profile = await fetchUserProfile(account.uid, signal);
  if (profile.notes.length === 0) return 0;
  backfillProfile(account, profile.nickname, profile.avatar, profile.redId);

  const withCookie = hasCookie();
  const now = nowIso();
  const profileUrl = `https://www.xiaohongshu.com/user/profile/${account.uid}`;

  // 拿得到 noteId 说明 Cookie 生效，此时不该再存在任何「仅标题」记录：
  // 它们要么是降级期留下的合成键重影，要么是旧版本拿假时间入的库，一律清掉重抓。
  // 删掉后这些笔记会重新变成「新笔记」，在后续几轮里带真实发布时间补回来。
  if (withCookie && profile.notes.some((n) => n.noteId)) {
    const dropped = db
      .delete(schema.kolPosts)
      .where(and(eq(schema.kolPosts.uid, account.uid), eq(schema.kolPosts.titleOnly, 1)))
      .run();
    const n = Number(dropped.changes ?? 0);
    if (n > 0) console.log(`[kol] ${account.screenName}：Cookie 已生效，清理 ${n} 条仅标题记录待重抓`);
  }

  // 先算出各笔记的主键，一次性查出已入库的，避免逐条查库
  const entries = profile.notes.map((n) => ({
    note: n,
    bid: n.noteId || syntheticNoteKey(account.uid, n.title),
  }));
  const known = existingBids(entries.map((e) => e.bid));
  // 已入库笔记的发布时间直接读库，判断「是否已超出抓取窗口」不用花任何网络请求
  const knownTime = knownCreatedAt(entries.map((e) => e.bid));
  const cutoff = fetchCutoff('xiaohongshu');

  let inserted = 0;
  let deferred = 0;
  let skippedOld = 0;

  for (const { note, bid } of entries) {
    if (signal?.aborted) break;
    const isNew = !known.has(bid);

    // 主页列表按发布时间倒序（实测：连续 12 条严格递减），因此一旦遇到超窗的笔记，
    // 后面只会更旧，整个账号可以就此打住。置顶帖会乱序出现在最前，不参与此判断。
    if (!note.sticky) {
      const at = knownTime.get(bid);
      if (at && at < cutoff) break;
    }

    // 只有新笔记才需要补拉详情（正文 + 真实发布时间 + 配图），预算整轮共享
    let detail = null;
    if (isNew && withCookie && note.noteId && budget.left > 0) {
      if (budget.used) await sleep(XHS_DETAIL_GAP_MS);
      detail = await fetchNoteDetail(note.noteId, note.xsecToken, signal);
      budget.left -= 1;
      budget.used = true;
    }

    // 已入库的老笔记：没有详情就没有可更新的内容，跳过（互动数留待有详情时再刷）
    if (!isNew && !detail) continue;

    // 拿不到真实发布时间就不入库。曾经这里会用 Date.now() 顶上，结果 Cookie 失效期间
    // 整批历史笔记被打上「当前时间」涌到时间流顶部，把真正的新内容挤没了，
    // 而且假日期让按日期筛选彻底失去意义。宁可这轮不收，下轮再来。
    if (!detail?.createdAt) {
      deferred += 1;
      continue;
    }
    const createdAt = detail.createdAt;

    // 超出窗口：列表有序，后面只会更旧，直接结束该账号
    if (!note.sticky && createdAt < cutoff) {
      skippedOld += 1;
      break;
    }
    if (isStaleTop({ isTop: note.sticky, createdAt })) continue;

    // 小红书大量信息画在图里，正文常常只是引子，所以配图必须留下来。
    // 图床地址是短时效签名，只能抓到当下就把字节拉回本地；失败不阻断入库。
    const images = detail.images.length
      ? await cacheImages(detail.images, 'xiaohongshu', signal)
      : [];

    const title = detail.title || note.title;
    const text = detail.desc ? `${title}\n\n${detail.desc}`.trim() : title;

    db.insert(schema.kolPosts)
      .values({
        bid,
        uid: account.uid,
        platform: 'xiaohongshu',
        screenName: profile.nickname || account.screenName,
        avatar: profile.avatar || account.avatar,
        text,
        createdAt,
        url: note.noteId ? noteUrl(note.noteId, note.xsecToken) : profileUrl,
        isRetweet: 0,
        retweetText: null,
        reposts: detail.shareCount,
        comments: detail.commentCount,
        // 列表页点赞数是 "1万+" 这类展示串，只有详情页给的是数字
        attitudes: detail.likedCount,
        images: images.length > 0 ? JSON.stringify(images) : null,
        titleOnly: 0,
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.kolPosts.bid,
        // createdAt 不覆盖，保住首次入库时确认过的真实发布时间。
        // 配图仅在本轮确实缓存成功时才覆盖，避免下载失败把已有的图清空。
        set: {
          reposts: detail.shareCount,
          comments: detail.commentCount,
          attitudes: detail.likedCount,
          ...(images.length > 0 ? { images: JSON.stringify(images) } : {}),
          fetchedAt: now,
        },
      })
      .run();
    if (isNew) inserted += 1;
  }

  if (deferred > 0) {
    console.log(
      `[kol] ${account.screenName}：${deferred} 篇拿不到发布时间（配额用尽或 Cookie 失效），留待下轮（整轮共享 ${XHS_DETAIL_MAX} 篇）`,
    );
  }
  if (skippedOld > 0) {
    console.log(`[kol] ${account.screenName}：已扫到抓取窗口之外，本轮提前结束`);
  }
  return inserted;
}

/** 平台对应的启停键与禁用提示 */
function assertPlatformEnabled(platform: KolPlatform): void {
  if (platform === 'weibo' && getValue('weiboEnabled') !== 'true') {
    throw new WeiboError('微博数据源已在数据源页禁用');
  }
  if (platform === 'xiaohongshu' && getValue('xhsEnabled') !== 'true') {
    throw new XhsError('小红书数据源已在数据源页禁用');
  }
}

/** 全量轮覆盖的平台 */
const ALL_PLATFORMS: KolPlatform[] = ['weibo', 'xiaohongshu'];

/** 平台 → 启停设置键 */
const enabledKey = (p: KolPlatform) => (p === 'weibo' ? 'weiboEnabled' : 'xhsEnabled');

/**
 * 进行中的抓取（按平台维度）。
 *
 * 定时任务的 job 锁管不到手动入口 POST /api/kol/refresh，两者并行时小红书详情预算各算各的、
 * 请求量直接翻倍——而密集请求实测会让 web_session 失效。这里在 service 层做进程内互斥：
 * 同平台重入直接复用在跑的那一轮，不再新开请求。
 */
const inflightRefresh = new Map<KolPlatform, Promise<KolRefreshResult>>();

/** 单平台一轮抓取；该平台已有一轮在跑则复用它 */
function refreshPlatform(
  signal: AbortSignal | undefined,
  platform: KolPlatform,
): Promise<KolRefreshResult> {
  const running = inflightRefresh.get(platform);
  if (running) {
    console.log(`[kol] 已有抓取在进行中（${platform}），复用本轮结果`);
    return running;
  }
  const task = runRefresh(signal, platform).finally(() => inflightRefresh.delete(platform));
  inflightRefresh.set(platform, task);
  return task;
}

/**
 * 全量轮（手动「抓取最新」）：逐平台各自取锁，再合并计数。
 *
 * 原先全量轮与两个单平台轮共用一把锁，撞上任一单平台定时轮（微博 10 分钟一轮、小红书
 * 1 小时一轮，很容易命中）就直接复用那一轮的 Promise——返回的只是单平台结果，另一平台
 * 本轮压根没抓，接口却把它当成一次成功的全量抓取回给用户。分平台取锁后，撞上的那个平台
 * 复用在跑的轮次，没撞上的平台照常新起一轮，两边计数合并后才是如实的全量结果。
 */
async function refreshEveryPlatform(signal?: AbortSignal): Promise<KolRefreshResult> {
  const settled = await Promise.all(
    ALL_PLATFORMS.map(async (p) => {
      // 禁用的平台整体跳过（与原先「逐账号跳过被禁用平台」等效）
      if (getValue(enabledKey(p)) !== 'true') return null;
      try {
        return await refreshPlatform(signal, p);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.warn(`[kol] ${p} 本轮整体失败: ${error}`);
        return { platform: p, error };
      }
    }),
  );

  const ok = settled.filter((r): r is KolRefreshResult => r != null && !('error' in r));
  const bad = settled.filter(
    (r): r is { platform: KolPlatform; error: string } => r != null && 'error' in r,
  );
  if (!ok.length) {
    if (bad.length) throw new WeiboError(bad.map((b) => `${b.platform}：${b.error}`).join('；'));
    throw new WeiboError('微博与小红书数据源均已在数据源页禁用');
  }
  return {
    accounts: ok.reduce((s, r) => s + r.accounts, 0),
    inserted: ok.reduce((s, r) => s + r.inserted, 0),
    // 整体失败的平台也要如实进 failed，否则前端会把「一个平台全挂」显示成全量成功
    failed: [...ok.flatMap((r) => r.failed), ...bad.map((b) => `${b.platform}(整体失败)`)],
  };
}

/**
 * 抓取启用的大V最新发帖并入库，可按平台过滤（两套定时分别调用）。
 * 串行 + 间隔避免限流；单个大V失败只记 warn 并计入 failed，不阻断整轮。
 * 同一平台同时只允许一轮在跑，重入复用在跑的 Promise；不带 platform 的全量轮逐平台分别取锁。
 */
export function refreshAll(
  signal?: AbortSignal,
  platform?: KolPlatform,
): Promise<KolRefreshResult> {
  return platform ? refreshPlatform(signal, platform) : refreshEveryPlatform(signal);
}

async function runRefresh(
  signal: AbortSignal | undefined,
  platform: KolPlatform,
): Promise<KolRefreshResult> {
  assertPlatformEnabled(platform);

  const accounts = db
    .select()
    .from(schema.kolAccounts)
    .where(and(eq(schema.kolAccounts.enabled, 1), eq(schema.kolAccounts.platform, platform)))
    .orderBy(schema.kolAccounts.sortOrder)
    .all();

  let inserted = 0;
  let scanned = 0;
  const failed: string[] = [];
  // 小红书详情请求预算整轮共享，账号增加不会线性放大请求量
  const budget: DetailBudget = { left: XHS_DETAIL_MAX, used: false };
  for (const [i, a] of accounts.entries()) {
    if (signal?.aborted) break;
    const p = toPlatform(a.platform);
    scanned += 1;
    try {
      inserted +=
        p === 'xiaohongshu'
          ? await refreshXhsAccount(a, budget, signal)
          : await refreshWeiboAccount(a, signal);
    } catch (e) {
      failed.push(a.screenName);
      console.warn(`[kol] 抓取${p === 'xiaohongshu' ? '小红书博主' : '大V'} ${a.screenName}(${a.uid}) 失败:`, e instanceof Error ? e.message : e);
    }
    if (i < accounts.length - 1) {
      await sleep(p === 'xiaohongshu' ? XHS_ACCOUNT_GAP_MS : ACCOUNT_GAP_MS);
    }
  }
  // 全部账号皆失败视为数据源不可用，抛错让调度/接口显性报错
  if (scanned > 0 && failed.length === scanned) {
    throw new WeiboError(`全部 ${scanned} 个大V抓取失败（疑似平台风控升级或网络不可用）`);
  }
  return { accounts: scanned, inserted, failed };
}

/** 按昵称搜索微博用户，标注是否已在关注名单（小红书搜索接口需签名，不支持） */
export async function search(
  q: string,
  signal?: AbortSignal,
): Promise<Array<KolSearchResult & { added: boolean }>> {
  const list = await searchUsers(q, signal);
  const added = new Set(listAccounts().map((a) => a.uid));
  return list.map((u) => ({ ...u, platform: 'weibo' as const, added: added.has(u.uid) }));
}

/** 预览小红书博主资料（添加前确认是不是要找的人）；支持主页链接与 App 分享短链 */
export async function previewXhsUser(
  input: string,
  signal?: AbortSignal,
): Promise<KolSearchResult & { added: boolean }> {
  const uid = await parseUserId(input, signal);
  const p = await fetchUserProfile(uid, signal);
  const added = listAccounts().some((a) => a.uid === uid);
  return {
    uid,
    platform: 'xiaohongshu',
    redId: p.redId,
    screenName: p.nickname,
    avatar: p.avatar,
    followersCount: p.fansCount,
    verifiedReason: p.desc,
    added,
  };
}

/** 清理过期发帖（默认保留 30 天），避免库无限增长 */
export function pruneOldPosts(keepDays = 30): number {
  const cutoff = new Date(Date.now() - keepDays * 24 * 3600 * 1000).toISOString();
  const res = db.delete(schema.kolPosts).where(lt(schema.kolPosts.createdAt, cutoff)).run();
  return Number(res.changes ?? 0);
}

/** 清理过期配图缓存（与 pruneOldPosts 同保留期），返回删除的文件数 */
export function pruneCachedImages(keepDays = 30): Promise<number> {
  return pruneImages(keepDays);
}
