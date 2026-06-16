import { createHash } from 'node:crypto';
import type { ClsTelegraph } from '@stock-agent/shared';
import { callAkshare } from '../market/akshare';
import { fetchTelegraph as fetchClsDirect } from './client';

// 财经快讯/电报服务：首选财联社电报签名直连（client.ts，绕开 akshare），命中即为真·财联社。
// 直连失效（财联社改版导致签名/路径失效）时，按序降级到同花顺/富途/东财/新浪全球快讯
// （经 akshare 透传，旧版亦可用），保证失效期间仍有数据。akshare 版财联社 stock_info_global_cls
// 因未发送签名参数恒超时，已从兜底链移除。各源统一映射为强类型 ClsTelegraph[] 并标注实际来源
// source。源无情绪字段，tag 恒为 neutral。每源以短超时 + 单次尝试快速失败，避免前端长时间等待。

type Row = Record<string, unknown>;

/** 单源快速失败超时（毫秒）：财联社旧版会挂起，短超时尽快切下一源 */
const SOURCE_TIMEOUT_MS = 12_000;

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

/** 拼装稳定 id：来源+时间+标题/内容前缀 的短哈希，供前端去重与 key */
function makeId(source: string, time: string, text: string): string {
  return createHash('md5').update(`${source} ${time} ${text}`).digest('hex').slice(0, 12);
}

/** 完整 datetime 串（YYYY-MM-DD HH:mm:ss）转 ISO；解析失败回退原串 */
function datetimeToIso(raw: string): string {
  if (!raw) return '';
  const d = new Date(raw.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? raw : d.toISOString();
}

interface SourceDef {
  /** akshare 函数名 */
  func: string;
  /** 来源中文名（写入 ClsTelegraph.source） */
  name: string;
  /** 把单条记录映射为 ClsTelegraph（除 id/source 外） */
  map: (row: Row) => { time: string; title: string; content: string; url: string | null };
}

// 兜底优先级（财联社签名直连为首选，见 telegraph()）：同花顺 > 富途 > 东财全球 > 新浪。
const SOURCES: SourceDef[] = [
  {
    func: 'stock_info_global_ths',
    name: '同花顺',
    map: (r) => ({
      time: datetimeToIso(str(r['发布时间'])),
      title: str(r['标题']),
      content: str(r['内容']),
      url: str(r['链接']) || null,
    }),
  },
  {
    func: 'stock_info_global_futu',
    name: '富途',
    map: (r) => ({
      time: datetimeToIso(str(r['发布时间'])),
      title: str(r['标题']),
      content: str(r['内容']),
      url: str(r['链接']) || null,
    }),
  },
  {
    func: 'stock_info_global_em',
    name: '东财',
    map: (r) => ({
      time: datetimeToIso(str(r['发布时间'])),
      title: str(r['标题']),
      content: str(r['摘要']),
      url: str(r['链接']) || null,
    }),
  },
  {
    func: 'stock_info_global_sina',
    name: '新浪',
    map: (r) => ({
      time: datetimeToIso(str(r['时间'])),
      title: '',
      content: str(r['内容']),
      url: null,
    }),
  },
];

/** 拉取单源并映射；空数组/抛错由调用方判定是否切下一源 */
async function fetchSource(def: SourceDef, signal?: AbortSignal): Promise<ClsTelegraph[]> {
  const data = await callAkshare(def.func, {}, signal, 'cls', SOURCE_TIMEOUT_MS, 1);
  if (!Array.isArray(data)) return [];
  return (data as Row[]).map((row) => {
    const m = def.map(row);
    return {
      id: makeId(def.name, m.time, m.content || m.title),
      time: m.time,
      title: m.title,
      content: m.content,
      tag: 'neutral' as const,
      source: def.name,
      // 兜底源无加红信息，重点筛选不可用
      important: false,
      url: m.url,
    } satisfies ClsTelegraph;
  });
}

/**
 * 拉取财经快讯：首选财联社签名直连（真·财联社电报，含 important 加红标记），失败/空再按兜底优先级降级。
 * 始终返回全量，「全部/重点」由前端按 important 本地切换；全部失败/为空抛出聚合错误。
 */
export async function telegraph(limit = 50, signal?: AbortSignal): Promise<ClsTelegraph[]> {
  const errors: string[] = [];

  // 首选：财联社签名直连，命中即真·财联社电报
  try {
    const list = await fetchClsDirect(limit, signal);
    if (list.length > 0) return list;
    errors.push('财联社直连: 空数据');
  } catch (e) {
    errors.push(`财联社直连: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const def of SOURCES) {
    try {
      const list = await fetchSource(def, signal);
      if (list.length === 0) {
        errors.push(`${def.name}(${def.func}): 空数据`);
        continue;
      }
      // 统一按时间倒序（最新在前），截断到 limit
      list.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
      return list.slice(0, Math.max(1, limit));
    } catch (e) {
      errors.push(`${def.name}(${def.func}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(
    `全部财经快讯源不可用（财联社签名可能失效，参照 RSSHub lib/routes/cls 更新 sv/签名）：${errors.join('；')}`,
  );
}

/** 健康探测：任一快讯源能取到 1 条即在线（首源不通会快速降级） */
export async function ping(signal?: AbortSignal): Promise<void> {
  await telegraph(1, signal);
}
