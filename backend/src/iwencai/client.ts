import { randomBytes } from 'node:crypto';
import { getValue } from '../settings';
import { requestJson } from '../datasource/httpClient';

// 同花顺问财 OpenAPI（hithink-etf-selector）官方接口薄封装。
// 自然语言 ETF 智能选股 / 数据查询，POST <baseUrl>/v1/query2data。
// 鉴权：Authorization Bearer + 一组 X-Claw-* 网关头（含每次新生成的 64 位 hex Trace-Id）。
// apiKey 优先读设置页（iwencaiApiKey），回退进程环境变量 IWENCAI_API_KEY。

const QUERY_PATH = '/v1/query2data';
const SKILL_VERSION = '1.0.0';

type Json = Record<string, unknown>;

export class IwencaiError extends Error {}

/** 网关基址（设置页可覆盖，默认官方域），末尾去斜杠 */
function baseUrl(): string {
  return (getValue('iwencaiBaseUrl') || 'https://openapi.iwencai.com').replace(/\/+$/, '');
}

/** apiKey：设置页优先，回退环境变量 IWENCAI_API_KEY；均空则抛错 */
function apiKey(): string {
  const key = getValue('iwencaiApiKey') || (process.env.IWENCAI_API_KEY ?? '').trim();
  if (!key) {
    throw new IwencaiError('问财 IWENCAI_API_KEY 未配置，请到数据源页（同花顺问财 ETF 选股）填写 apiKey');
  }
  return key;
}

/** 装配符合问财网关规范的请求头（Bearer + X-Claw-*，Trace-Id 每次新生成；skillId 由调用方传入） */
function buildHeaders(callType: 'normal' | 'retry', skillId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey()}`,
    'Content-Type': 'application/json',
    'X-Claw-Call-Type': callType,
    'X-Claw-Skill-Id': skillId,
    'X-Claw-Skill-Version': SKILL_VERSION,
    'X-Claw-Plugin-Id': 'none',
    'X-Claw-Plugin-Version': 'none',
    'X-Claw-Trace-Id': randomBytes(32).toString('hex'),
  };
}

export interface QueryOptions {
  /** 分页，正整数字符串，默认 '1' */
  page?: string;
  /** 每页条数，正整数字符串，默认 '10' */
  limit?: string;
  /** 调用类型：normal 正常 / retry 放宽条件重试 */
  callType?: 'normal' | 'retry';
  /** 调用统计归属源 id（ETF=iwencai，个股=iwencai-stock） */
  sourceId?: string;
  signal?: AbortSignal;
}

/** 兼容旧命名 */
export type QueryEtfOptions = QueryOptions;

/**
 * 通用自然语言数据查询：POST /v1/query2data，skillId 决定网关侧能力路由/计量。
 * 返回网关原始信封（含 datas / code_count / chunks_info 等）；
 * 无 datas 的 dict 通常为网关错误（额度不足 / 次数超限 / skill 未开通），由调用方判定。
 */
export function query2data(query: string, skillId: string, opts: QueryOptions = {}): Promise<Json> {
  const body = {
    query,
    page: opts.page ?? '1',
    limit: opts.limit ?? '10',
    is_cache: '1',
    expand_index: 'true',
  };
  return requestJson({
    sourceId: opts.sourceId ?? 'iwencai',
    url: `${baseUrl()}${QUERY_PATH}`,
    method: 'POST',
    headers: buildHeaders(opts.callType ?? 'normal', skillId),
    body: JSON.stringify(body),
    signal: opts.signal,
    timeoutMs: 30000,
    maxAttempts: 2,
    retryBaseMs: 600,
    isAuthFailure: (s) => s === 401 || s === 403,
    authFailureMessage: '问财网关鉴权失效，请检查 IWENCAI_API_KEY',
    errorLabel: '问财网关',
    makeError: (msg) => new IwencaiError(msg),
  });
}

/** ETF 智能选股：自然语言条件查询符合的 ETF（skill 取设置 iwencaiSkillId） */
export function queryEtf(query: string, opts: QueryOptions = {}): Promise<Json> {
  const skill = getValue('iwencaiSkillId') || 'hithink-etf-selector';
  return query2data(query, skill, { sourceId: 'iwencai', ...opts });
}

/** 个股智能选股：自然语言条件查询符合的 A 股（skill 取设置 iwencaiStockSkillId） */
export function queryStock(query: string, opts: QueryOptions = {}): Promise<Json> {
  const skill = getValue('iwencaiStockSkillId') || 'hithink-stock-selector';
  return query2data(query, skill, { sourceId: 'iwencai-stock', ...opts });
}

/** 个股 L2 独有指标行（DDX/DDY，免费源没有） */
export interface StockL2Row {
  code: string;
  name: string;
  /** 最新价（best-effort） */
  price: number | null;
  /** DDX 大单动向（同花顺 L2 口径） */
  ddx: number | null;
  /** DDY 涨跌动因（同花顺 L2 口径） */
  ddy: number | null;
}

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 批量查个股 DDX/DDY（问财个股 skill）。问财列 index_name=ddx/ddy，
 * 实际 datas 键带日期后缀（如 ddx[20260617]），故按 columns 的 index_name→key 映射取值。
 * 无 datas（额度/鉴权/skill 未开通）抛 IwencaiError，由调用方降级到妙想。
 */
export async function queryStockL2(codes: string[], signal?: AbortSignal): Promise<StockL2Row[]> {
  const valid = codes.filter((c) => /^\d{6}$/.test(c));
  if (valid.length === 0) return [];
  const json = await queryStock(`${valid.join('、')} ddx ddy`, {
    limit: String(Math.max(valid.length, 10)),
    signal,
  });
  assertEnvelope(json);
  const columns = Array.isArray(json.columns) ? (json.columns as Json[]) : [];
  // index_name（ddx/ddy/股票代码…）→ datas 实际键名
  const keyOf = (indexName: string): string | null => {
    const col = columns.find((c) => String(c.index_name ?? '') === indexName);
    return col ? String(col.key ?? col.index_name ?? '') : null;
  };
  const codeKey = keyOf('股票代码') ?? '股票代码';
  const nameKey = keyOf('股票简称') ?? '股票简称';
  const priceKey = keyOf('最新价') ?? '最新价';
  const ddxKey = keyOf('ddx');
  const ddyKey = keyOf('ddy');
  const rows = Array.isArray(json.datas) ? (json.datas as Json[]) : [];
  return rows.map((r) => ({
    // 问财返回 600519.SH，截前 6 位对齐内部代码
    code: String(r[codeKey] ?? '').slice(0, 6),
    name: String(r[nameKey] ?? ''),
    price: toNum(r[priceKey]),
    ddx: ddxKey ? toNum(r[ddxKey]) : null,
    ddy: ddyKey ? toNum(r[ddyKey]) : null,
  }));
}

export const iwencai = { queryEtf, queryStock, queryStockL2, query2data };

export type IwencaiClient = typeof iwencai;

/** 网关信封校验：无 datas 视为业务错误，抛出携带 detail 的 IwencaiError */
function assertEnvelope(json: Json | null): void {
  if (!json || !('datas' in json)) {
    const msg =
      (json && typeof json.message === 'string' && json.message) ||
      (json && typeof json.msg === 'string' && json.msg) ||
      '问财网关返回异常（无 datas，疑似额度/鉴权/skill 未开通问题）';
    throw new IwencaiError(String(msg));
  }
}

/**
 * 健康探测：最小一次 ETF 查询（limit=1）验证网关连通与 apiKey 有效。
 * apiKey 未配置或鉴权失效会抛错；返回不含 datas（网关业务错误）也抛错暴露 detail。
 */
export async function pingIwencai(signal?: AbortSignal): Promise<void> {
  assertEnvelope(await queryEtf('沪深300ETF', { limit: '1', signal }));
}

/** 健康探测：最小一次个股查询（limit=1）验证个股 skill 已开通且网关连通 */
export async function pingIwencaiStock(signal?: AbortSignal): Promise<void> {
  assertEnvelope(await queryStock('贵州茅台 最新价', { limit: '1', signal }));
}
