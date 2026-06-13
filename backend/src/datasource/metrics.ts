import type { DataSourceStats } from '@stock-agent/shared';

// 数据源调用统计（进程内内存聚合）。
// 仅用于「数据源」页可观测：请求数 / 错误数 / 错误率 / 缓存命中 / 最近调用与最近错误。
// 进程重启即清零，与行情 15s 内存缓存同属轻量内存态，不落库（KISS）。

interface SourceMetric {
  requests: number;
  errors: number;
  cacheHits: number;
  lastCallAt: string | null;
  lastError: string | null;
  lastLatencyMs: number | null;
}

const metrics = new Map<string, SourceMetric>();

function ensure(sourceId: string): SourceMetric {
  let m = metrics.get(sourceId);
  if (!m) {
    m = { requests: 0, errors: 0, cacheHits: 0, lastCallAt: null, lastError: null, lastLatencyMs: null };
    metrics.set(sourceId, m);
  }
  return m;
}

export interface RecordInput {
  ok: boolean;
  /** 命中内存缓存（不计入错误，但计入请求与命中数） */
  cacheHit?: boolean;
  latencyMs: number;
  /** ok=false 时的错误信息 */
  error?: string;
}

/** 记录一次逻辑请求（一次调用聚合一次，重试不重复计数） */
export function record(sourceId: string, input: RecordInput): void {
  const m = ensure(sourceId);
  m.requests += 1;
  m.lastCallAt = new Date().toISOString();
  m.lastLatencyMs = input.latencyMs;
  if (input.cacheHit) m.cacheHits += 1;
  if (!input.ok) {
    m.errors += 1;
    m.lastError = input.error ?? '未知错误';
  }
}

function toStats(m: SourceMetric): DataSourceStats {
  return {
    requests: m.requests,
    errors: m.errors,
    errorRate: m.requests > 0 ? m.errors / m.requests : null,
    cacheHits: m.cacheHits,
    lastCallAt: m.lastCallAt,
    lastError: m.lastError,
    lastLatencyMs: m.lastLatencyMs,
  };
}

/** 取单个数据源统计（无记录返回空统计） */
export function statsFor(sourceId: string): DataSourceStats {
  const m = metrics.get(sourceId);
  return m
    ? toStats(m)
    : { requests: 0, errors: 0, errorRate: null, cacheHits: 0, lastCallAt: null, lastError: null, lastLatencyMs: null };
}

/** 全量统计快照（sourceId -> 统计） */
export function snapshot(): Record<string, DataSourceStats> {
  const out: Record<string, DataSourceStats> = {};
  for (const [id, m] of metrics) out[id] = toStats(m);
  return out;
}
