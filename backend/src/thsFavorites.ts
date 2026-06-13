import type { WatchlistSyncResult } from '@stock-agent/shared';
import { getQuotes } from './market/eastmoney';
import { getValue } from './settings';
import { listWatch, addWatch, updateWatch, removeWatch } from './watchlist';
import { requestJson } from './datasource/httpClient';
import { inferApiType } from './datasource/codes';

// 同花顺自选股双向同步：以同花顺为准的拉取调和 + 本地写透回同花顺。
// - 命名自选分组（type=0）走 ugc.10jqka.com.cn/optdata/selfgroup 接口（含 version 乐观锁）。
// - 扁平「我的自选」走 t.10jqka.com.cn/newcircle/group v2 接口，映射为特殊分组 tag=我的自选。
// - 动态/公式分组（type=1）不参与同步。
// 鉴权方式与 realPositions 一致：复用设置页的 thsCookie（含 userid）+ 海聊移动端 UA。

export class ThsFavoritesError extends Error {}

const UA =
  'Hexin_Gphone/11.28.03 (Royal Flush) hxtheme/0 innerversion/G037.09.028.1.32 followPhoneSystemTheme/0 userid/000000000 getHXAPPAccessibilityMode/0 hxNewFont/1 isVip/0 getHXAPPFontSetting/normal getHXAPPAdaptOldSetting/0 okhttp/3.14.9';
const UGC_BASE = 'https://ugc.10jqka.com.cn/optdata/selfgroup/open/api';
const SELF_V2_BASE = 'https://t.10jqka.com.cn';
const SELF_V2_LIST = '/newcircle/group/getSelfStockWithMarket/';
const SELF_V2_MODIFY = '/newcircle/group/modifySelfStock/';
const FROM = 'sjcg_gphone';

/** 扁平「我的自选」映射成的特殊分组 tag 名 */
export const SELF_TAG = '我的自选';

function cookieOrThrow(): string {
  const cookie = getValue('thsCookie');
  if (!cookie) throw new ThsFavoritesError('同花顺 Cookie 未配置，请到设置页填写');
  return cookie;
}

/** 写透前置：未配置 Cookie 返回 null（静默跳过），不抛错 */
function cookieOrNull(): string | null {
  const cookie = getValue('thsCookie');
  return cookie || null;
}

// ===== 底层请求（统一走 datasource/httpClient，sourceId=ths）=====

/** 校验 ugc 业务码（status_code===0），返回 data 字段 */
function checkUgc(json: Record<string, unknown>): Record<string, unknown> {
  const j = json as { status_code?: number; status_msg?: string; data?: unknown };
  if (j.status_code !== 0) {
    throw new ThsFavoritesError(`同花顺自选接口返回异常: ${j.status_msg ?? j.status_code}`);
  }
  return (j.data ?? {}) as Record<string, unknown>;
}

async function ugcGet(path: string, qs: Record<string, string>): Promise<unknown> {
  const cookie = cookieOrThrow();
  const json = await requestJson({
    sourceId: 'ths',
    url: `${UGC_BASE}${path}?${new URLSearchParams(qs)}`,
    headers: { 'User-Agent': UA, Cookie: cookie },
    isAuthFailure: (s) => s === 401 || s === 403,
    authFailureMessage: '同花顺 Cookie 已失效，请到设置页更新',
    errorLabel: '同花顺自选接口',
    makeError: (msg) => new ThsFavoritesError(msg),
  });
  return checkUgc(json);
}

async function ugcPost(path: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const cookie = cookieOrThrow();
  const json = await requestJson({
    sourceId: 'ths',
    url: `${UGC_BASE}${path}`,
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ ...form, from: FROM }).toString(),
    isAuthFailure: (s) => s === 401 || s === 403,
    authFailureMessage: '同花顺 Cookie 已失效，请到设置页更新',
    errorLabel: '同花顺自选接口',
    makeError: (msg) => new ThsFavoritesError(msg),
  });
  return checkUgc(json);
}

// ===== 拉取与解析 =====

interface RawGroup {
  id: string;
  name: string;
  type: number;
  /** code -> apiType */
  items: Array<{ code: string; apiType: string }>;
}

/** content 形如 "code1|code2,type1|type2"，逗号前为代码段、后为对应市场类型段 */
function parseContent(content: string): Array<{ code: string; apiType: string }> {
  if (!content) return [];
  const idx = content.indexOf(',');
  const codesSeg = idx >= 0 ? content.slice(0, idx) : content;
  const typesSeg = idx >= 0 ? content.slice(idx + 1) : '';
  const codes = codesSeg.split('|').filter(Boolean);
  const types = typesSeg.split('|').filter(Boolean);
  return codes.map((code, i) => ({ code, apiType: types[i] ?? '' }));
}

/** 拉取全部分组原始数据（含 version 与 type，供调和与写透共用） */
async function queryGroupsRaw(): Promise<{ version: string; groups: RawGroup[] }> {
  const data = (await ugcGet('/group/v1/query', { from: FROM, types: '0,1' })) as {
    version?: unknown;
    group_list?: unknown;
  };
  const list = Array.isArray(data.group_list) ? (data.group_list as Array<Record<string, unknown>>) : [];
  const groups: RawGroup[] = list.map((g) => ({
    id: String(g.id ?? ''),
    name: String(g.name ?? ''),
    type: Number(g.type ?? 0),
    items: parseContent(typeof g.content === 'string' ? g.content : ''),
  }));
  return { version: String(data.version ?? ''), groups };
}

/** 拉取扁平「我的自选」：v2 接口返回 {code, marketid} 列表 */
async function fetchSelfStocks(): Promise<Array<{ code: string; apiType: string }>> {
  const cookie = cookieOrThrow();
  const json = (await requestJson({
    sourceId: 'ths',
    url: `${SELF_V2_BASE}${SELF_V2_LIST}`,
    headers: { 'User-Agent': UA, Cookie: cookie },
    isAuthFailure: (s) => s === 401 || s === 403,
    authFailureMessage: '同花顺 Cookie 已失效，请到设置页更新',
    errorLabel: '同花顺我的自选接口',
    makeError: (msg) => new ThsFavoritesError(msg),
  })) as { errorCode?: number; errorMsg?: string; result?: unknown };
  if (json.errorCode !== 0) {
    throw new ThsFavoritesError(`同花顺我的自选返回异常: ${json.errorMsg ?? json.errorCode}`);
  }
  const result = Array.isArray(json.result) ? (json.result as Array<Record<string, unknown>>) : [];
  return result.map((r) => ({ code: String(r.code ?? ''), apiType: String(r.marketid ?? '') }));
}

function parseTags(tags: string | null | undefined): string[] {
  return (tags ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinTags(tags: string[]): string | null {
  const uniq = Array.from(new Set(tags));
  return uniq.length > 0 ? uniq.join(',') : null;
}

// ===== 同步调和（以同花顺为准） =====

/**
 * 拉取同花顺自选并以其为准调和本地 watchlist。
 * 仅同步命名分组(type=0) + 我的自选；保留本地自有 tag，不误删手动标的。
 */
export async function syncFavorites(): Promise<WatchlistSyncResult> {
  const { groups } = await queryGroupsRaw();
  const namedGroups = groups.filter((g) => g.type === 0);
  const selfStocks = await fetchSelfStocks();

  // 同花顺托管的 tag 命名空间（所有命名分组名 + 我的自选）
  const thsTagNamespace = new Set<string>([...namedGroups.map((g) => g.name), SELF_TAG]);

  // 期望状态：code -> 同花顺 tag 集合（只收 6 位数字代码，过滤指数/美股等）
  const desired = new Map<string, Set<string>>();
  const addThsTag = (code: string, tag: string) => {
    if (!/^\d{6}$/.test(code)) return;
    const set = desired.get(code) ?? new Set<string>();
    set.add(tag);
    desired.set(code, set);
  };
  for (const g of namedGroups) for (const it of g.items) addThsTag(it.code, g.name);
  for (const it of selfStocks) addThsTag(it.code, SELF_TAG);

  // 「最新优先」主序列：同花顺列表顶部=最新。我的自选时间线优先，再补命名分组内标的。
  // 据此分配递减 addedAt（第 0 位=最新=最大时间戳），使 added_at DESC 与同花顺顺序一致。
  const order: string[] = [];
  const seen = new Set<string>();
  const pushOrd = (code: string) => {
    if (/^\d{6}$/.test(code) && !seen.has(code)) {
      seen.add(code);
      order.push(code);
    }
  };
  for (const it of selfStocks) pushOrd(it.code);
  for (const g of namedGroups) for (const it of g.items) pushOrd(it.code);
  const base = Date.now();
  const addedAtByCode = new Map<string, string>();
  order.forEach((code, i) => addedAtByCode.set(code, new Date(base - i * 1000).toISOString()));

  // 批量解析名称（东方财富）；解析不到名称的代码跳过（指数/北交所/退市等）
  const allCodes = Array.from(desired.keys());
  const quotes = allCodes.length > 0 ? await getQuotes(allCodes) : [];
  const nameMap = new Map(quotes.filter((q) => q.name).map((q) => [q.code, q.name]));

  const added: string[] = [];
  const removed: string[] = [];
  const skipped: string[] = [];
  let regrouped = 0;

  const local = listWatch();
  const localMap = new Map(local.map((i) => [i.code, i]));

  // 1) 远端存在的标的：upsert，合并 = 本地自有 tag ∪ 同花顺 tag
  for (const [code, thsTags] of desired) {
    const name = nameMap.get(code);
    if (!name) {
      skipped.push(code);
      continue;
    }
    const addedAt = addedAtByCode.get(code);
    const existing = localMap.get(code);
    if (!existing) {
      addWatch({ code, name, tags: joinTags([...thsTags]), note: null, addedAt });
      added.push(code);
      continue;
    }
    const localOwnTags = parseTags(existing.tags).filter((t) => !thsTagNamespace.has(t));
    const merged = joinTags([...localOwnTags, ...thsTags]);
    const tagsChanged = merged !== (existing.tags ?? null);
    // 即使 tags 未变也按同花顺顺序重打 addedAt，确保排序与同花顺一致
    updateWatch(code, { tags: tagsChanged ? merged : undefined, addedAt });
    if (tagsChanged) regrouped += 1;
  }

  // 2) 远端缺失的本地标的：剥离同花顺 tag；全为同花顺 tag 则删除，否则保留本地自有 tag
  for (const item of local) {
    if (desired.has(item.code)) continue;
    const tags = parseTags(item.tags);
    const hadThsTag = tags.some((t) => thsTagNamespace.has(t));
    if (!hadThsTag) continue; // 纯手动标的，保持不动
    const ownTags = tags.filter((t) => !thsTagNamespace.has(t));
    if (ownTags.length > 0) {
      updateWatch(item.code, { tags: joinTags(ownTags) });
      regrouped += 1;
    } else {
      removeWatch(item.code);
      removed.push(item.code);
    }
  }

  return { groups: namedGroups.length, added, removed, regrouped, skipped };
}

// ===== 写透（本地 WebUI 变更回写同花顺） =====

interface PushCtx {
  version: string;
  /** 命名分组 name -> id */
  byName: Map<string, string>;
}

async function loadPushCtx(): Promise<PushCtx> {
  const { version, groups } = await queryGroupsRaw();
  const byName = new Map<string, string>();
  for (const g of groups) if (g.type === 0) byName.set(g.name, g.id);
  return { version, byName };
}

/** 找分组 id，不存在则新建并返回新 id（同步刷新 version） */
async function ensureGroupId(ctx: PushCtx, name: string): Promise<string> {
  const existing = ctx.byName.get(name);
  if (existing) return existing;
  const data = await ugcPost('/group/v1/add', { name, type: '0', version: ctx.version });
  if (data.version != null) ctx.version = String(data.version);
  const id = String(data.id ?? '');
  if (!id) throw new ThsFavoritesError(`新建分组「${name}」未返回 id`);
  ctx.byName.set(name, id);
  return id;
}

async function addItemToGroup(ctx: PushCtx, groupId: string, code: string): Promise<void> {
  const data = await ugcPost('/content/v1/add', {
    id: groupId,
    content: `${code},${inferApiType(code)}`,
    num: '1',
    version: ctx.version,
  });
  if (data.version != null) ctx.version = String(data.version);
}

async function deleteItemFromGroup(ctx: PushCtx, groupId: string, code: string): Promise<void> {
  const data = await ugcPost('/content/v1/delete', {
    id: groupId,
    content: `${code},${inferApiType(code)}`,
    num: '1',
    version: ctx.version,
  });
  if (data.version != null) ctx.version = String(data.version);
}

/** 我的自选增删（v2 接口，op=add/del，stockcode=code_apitype） */
async function modifySelfStock(op: 'add' | 'del', code: string): Promise<void> {
  const cookie = cookieOrThrow();
  const qs = new URLSearchParams({ op, stockcode: `${code}_${inferApiType(code)}` });
  const json = (await requestJson({
    sourceId: 'ths',
    url: `${SELF_V2_BASE}${SELF_V2_MODIFY}?${qs}`,
    headers: { 'User-Agent': UA, Cookie: cookie },
    errorLabel: '同花顺我的自选写入',
    makeError: (msg) => new ThsFavoritesError(msg),
  })) as { errorCode?: number; errorMsg?: string };
  if (json.errorCode !== 0) {
    throw new ThsFavoritesError(`同花顺我的自选写入异常: ${json.errorMsg ?? json.errorCode}`);
  }
}

/** 把一只标的加入给定 tag 对应的同花顺分组/我的自选 */
async function pushAddTags(ctx: PushCtx, code: string, tags: string[]): Promise<void> {
  for (const tag of tags) {
    if (tag === SELF_TAG) {
      await modifySelfStock('add', code);
    } else {
      const id = await ensureGroupId(ctx, tag);
      await addItemToGroup(ctx, id, code);
    }
  }
}

/** 把一只标的从给定 tag 对应的同花顺分组/我的自选移除 */
async function pushRemoveTags(ctx: PushCtx, code: string, tags: string[]): Promise<void> {
  for (const tag of tags) {
    if (tag === SELF_TAG) {
      await modifySelfStock('del', code);
    } else {
      const id = ctx.byName.get(tag);
      if (id) await deleteItemFromGroup(ctx, id, code);
    }
  }
}

/**
 * 写透：本地某标的 tags 由 oldTags 变为 newTags 时，对同花顺做对应增删。
 * 未配置 Cookie 时静默跳过。出错抛 ThsFavoritesError，由调用方按 best-effort 处理。
 */
export async function pushTagsDiff(
  code: string,
  oldTagsStr: string | null,
  newTagsStr: string | null,
): Promise<void> {
  if (!/^\d{6}$/.test(code)) return;
  if (!cookieOrNull()) return;
  const oldTags = parseTags(oldTagsStr);
  const newTags = parseTags(newTagsStr);
  const toAdd = newTags.filter((t) => !oldTags.includes(t));
  const toDel = oldTags.filter((t) => !newTags.includes(t));
  if (toAdd.length === 0 && toDel.length === 0) return;
  const ctx = await loadPushCtx();
  await pushAddTags(ctx, code, toAdd);
  await pushRemoveTags(ctx, code, toDel);
}

/**
 * 写透：删除一个分组。命名分组调 delete_group；「我的自选」非真实分组容器，不可删，跳过。
 * 未配置 Cookie 时静默跳过。
 */
export async function pushDeleteGroup(name: string): Promise<void> {
  if (name === SELF_TAG) return;
  if (!cookieOrNull()) return;
  const ctx = await loadPushCtx();
  const id = ctx.byName.get(name);
  if (!id) return; // 同花顺无此分组，无需删除
  await ugcPost('/group/v1/delete', { ids: id, version: ctx.version });
}

/** 写透：本地删除某标的时，从其所有 tag 对应的同花顺分组/我的自选移除 */
export async function pushRemove(code: string, tagsStr: string | null): Promise<void> {
  if (!/^\d{6}$/.test(code)) return;
  if (!cookieOrNull()) return;
  const tags = parseTags(tagsStr);
  if (tags.length === 0) return;
  const ctx = await loadPushCtx();
  await pushRemoveTags(ctx, code, tags);
}
