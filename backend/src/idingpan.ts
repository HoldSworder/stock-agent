import type { IdingpanPushResult, WatchItem } from '@stock-agent/shared';
import { getValue } from './settings';
import { listWatch } from './watchlist';
import { requestJson } from './datasource/httpClient';
import { toCodeId } from './datasource/codes';

// 本系统 → 爱盯盘 单向镜像（同花顺为唯一权威源，爱盯盘只读镜像，不回流）。
// 通道：爱盯盘云 API（base https://52etf.site，Authorization: Bearer <token>）。
// 经源码确认：爱盯盘仅在本地变更后「自动上传」云备份，启动/登录时不会「自动下载并应用」
// 云快照。因此推送只是新建一条云备份，用户需在爱盯盘「备份恢复」里对该记录点「恢复」生效。
// token 由本机一次性脚本 scripts/harvest-idp-token.mjs 提取后写入设置（idpToken）。

export class IdingpanError extends Error {}

const BASE = 'https://52etf.site';
const RECORDS = `${BASE}/api/data-records`;

interface IdpRecordMeta {
  id: number;
  type: string;
  platform: string;
  createdAt: string;
}

interface IdpStock {
  codeId: string;
}

interface IdpGroup {
  name: string;
  stocks: IdpStock[];
}

interface IdpConfig {
  stockGroup?: IdpGroup[];
  [k: string]: unknown;
}

/** 云备份的数据信封（POST 时作为 data 字段） */
interface IdpEnvelope {
  schema?: string;
  appVersion?: string;
  savedAt?: string;
  config: IdpConfig;
  otherCache?: unknown;
  [k: string]: unknown;
}

function tokenOrThrow(): string {
  const t = getValue('idpToken');
  if (!t) {
    throw new IdingpanError('爱盯盘 token 未配置，请先在本机运行 scripts/harvest-idp-token.mjs 提取');
  }
  return t;
}

// ===== 底层请求（统一走 datasource/httpClient，sourceId=idingpan）=====

const AUTH_FAILURE_MSG = '爱盯盘 token 已失效，请重新运行 harvest-idp-token 脚本提取';

async function listRecords(): Promise<IdpRecordMeta[]> {
  const token = tokenOrThrow();
  const data = await requestJson({
    sourceId: 'idingpan',
    url: `${RECORDS}?page=1&pageSize=20`,
    headers: { Authorization: `Bearer ${token}` },
    isAuthFailure: (s) => s === 401 || s === 403,
    authFailureMessage: AUTH_FAILURE_MSG,
    errorLabel: '爱盯盘云接口',
    makeError: (msg) => new IdingpanError(msg),
  });
  const records = Array.isArray(data.records) ? (data.records as IdpRecordMeta[]) : [];
  return records;
}

/** 取最新一条云备份的数据信封；云端为空返回 null */
async function fetchLatestEnvelope(): Promise<IdpEnvelope | null> {
  const records = await listRecords();
  if (records.length === 0) return null;
  const latest = records.reduce((a, b) => (b.id > a.id ? b : a));
  const token = tokenOrThrow();
  const data = await requestJson({
    sourceId: 'idingpan',
    url: RECORDS,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'get', id: latest.id }),
    isAuthFailure: (s) => s === 401 || s === 403,
    authFailureMessage: AUTH_FAILURE_MSG,
    errorLabel: '爱盯盘云接口',
    makeError: (msg) => new IdingpanError(msg),
  });
  const record = data.record as { data?: IdpEnvelope } | undefined;
  return record?.data ?? null;
}

/** 爱盯盘连通性探测（数据源页健康检查用）：拉取云备份记录列表 */
export async function pingIdingpan(): Promise<void> {
  await listRecords();
}

// ===== 合并 =====

function parseTags(tags: string | null | undefined): string[] {
  return (tags ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface MergeResult {
  config: IdpConfig;
  groups: number;
  codes: number;
}

/**
 * 以本系统 watchlist 为准构建受管分组（按 tags 派生），合并进爱盯盘配置：
 * - 同名分组以系统内容覆盖；
 * - 爱盯盘自有分组（系统无对应 tag）原样保留；
 * - 无 tag 的标的不归入任何分组（爱盯盘以分组组织，无落点），跳过。
 */
function buildMergedConfig(local: WatchItem[], base: IdpEnvelope | null): MergeResult {
  // tag -> 有序去重 codeId 列表
  const managed = new Map<string, string[]>();
  const seenInTag = new Map<string, Set<string>>();
  const allCodeIds = new Set<string>();
  for (const item of local) {
    const codeId = toCodeId(item.code);
    if (!codeId) continue;
    for (const tag of parseTags(item.tags)) {
      const list = managed.get(tag) ?? [];
      const seen = seenInTag.get(tag) ?? new Set<string>();
      if (!seen.has(codeId)) {
        list.push(codeId);
        seen.add(codeId);
      }
      managed.set(tag, list);
      seenInTag.set(tag, seen);
      allCodeIds.add(codeId);
    }
  }

  const managedNames = new Set(managed.keys());
  const baseGroups = base?.config?.stockGroup ?? [];
  // 爱盯盘自有分组（系统未托管）原样保留在前
  const kept = baseGroups.filter((g) => g && typeof g.name === 'string' && !managedNames.has(g.name));
  // 受管分组（系统派生）按插入顺序追加
  const mirrored: IdpGroup[] = Array.from(managed.entries()).map(([name, codeIds]) => ({
    name,
    stocks: codeIds.map((codeId) => ({ codeId })),
  }));

  const config: IdpConfig = { ...(base?.config ?? {}), stockGroup: [...kept, ...mirrored] };
  return { config, groups: mirrored.length, codes: allCodeIds.size };
}

// ===== 推送 =====

/**
 * 本系统 → 爱盯盘单向镜像：以最新云备份为基底合并 watchlist，POST 新建一条手动备份。
 * 爱盯盘端不自动应用，需用户在「备份恢复」里对该记录点「恢复」生效。
 * 注意爱盯盘手动备份有每日次数上限，勿频繁调用。
 */
export async function pushToIdingpan(): Promise<IdingpanPushResult> {
  const token = tokenOrThrow();
  const local = listWatch();
  const base = await fetchLatestEnvelope();
  const { config, groups, codes } = buildMergedConfig(local, base);

  const envelope: IdpEnvelope = base
    ? { ...base, savedAt: new Date().toISOString(), config }
    : {
        schema: 'data-config',
        appVersion: '2.29.1',
        savedAt: new Date().toISOString(),
        config,
        otherCache: {},
      };

  const data = await requestJson({
    sourceId: 'idingpan',
    url: RECORDS,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: envelope, type: '手动备份' }),
    isAuthFailure: (s) => s === 401 || s === 403,
    authFailureMessage: AUTH_FAILURE_MSG,
    errorLabel: '爱盯盘云接口',
    makeError: (msg) => new IdingpanError(msg),
  });
  const record = data.record as { id?: unknown } | undefined;
  const rawId = record?.id ?? data.id;
  const recordId = rawId != null ? String(rawId) : null;

  return {
    groups,
    codes,
    recordId,
    note: '已推送为爱盯盘云端「手动备份」。爱盯盘不会自动应用，请在爱盯盘「备份恢复」里对最新一条记录点「恢复」生效。',
  };
}
