import type { BoardKind } from '@stock-agent/shared';
import { callAkshare } from '../market/akshare';
import { cached } from '../lib/ttlCache';

// 板块新高宽度取数层（经 aktools 透传 akshare，best-effort，纯只读）：
//  - 全市场创新高列表：同花顺 stock_rank_cxg_ths（窗口档：创月新高/半年新高/一年新高/历史新高），一次取数。
//  - 板块清单 + 成分股：东财 stock_board_{industry,concept}_name_em / _cons_em，按板块名取成分。
// 成分股慢变，按板块缓存 6h；创新高列表盘中变动，缓存 10min。失败一律降级返回空，由上层标 stale。

/** akshare 创新高窗口档（stock_rank_cxg_ths 的 symbol 取值） */
export type NewHighWindow = '创月新高' | '半年新高' | '一年新高' | '历史新高';

/** 成分股缓存时长（成分慢变） */
const CONS_TTL_MS = 6 * 3600_000;
/** 板块清单缓存时长 */
const BOARD_TTL_MS = 6 * 3600_000;
/** 全市场创新高列表缓存时长（盘中变动，短缓存防抖） */
const NEWHIGH_TTL_MS = 10 * 60_000;

/** 从 akshare 记录里尽力取 6 位股票代码（兼容创新高榜「股票代码」与成分榜「代码」列名） */
function pickCode(rec: Record<string, unknown>): string | null {
  const cand = rec['股票代码'] ?? rec['代码'] ?? rec['品种代码'] ?? rec['stock_code'] ?? rec['code'];
  const m = String(cand ?? '').trim().match(/\d{6}/);
  return m ? m[0] : null;
}

/** 行业/概念对应的 akshare 函数名（清单 + 成分） */
function funcs(kind: BoardKind): { name: string; cons: string } {
  return kind === 'industry'
    ? { name: 'stock_board_industry_name_em', cons: 'stock_board_industry_cons_em' }
    : { name: 'stock_board_concept_name_em', cons: 'stock_board_concept_cons_em' };
}

/** 单个板块元信息（东财代码 + 名称 + 口径） */
export interface BoardMeta {
  code: string;
  name: string;
  kind: BoardKind;
}

/**
 * 全市场创新高个股代码集合（按窗口档，缓存 10min）。
 * best-effort：取数失败/为空返回空集，由上层标 stale。
 */
export async function fetchMarketNewHighSet(
  window: NewHighWindow,
  signal?: AbortSignal,
): Promise<Set<string>> {
  return cached(`breadth:cxg:${window}`, NEWHIGH_TTL_MS, async () => {
    const data = await callAkshare('stock_rank_cxg_ths', { symbol: window }, signal);
    const set = new Set<string>();
    if (Array.isArray(data)) {
      for (const rec of data as Array<Record<string, unknown>>) {
        const c = pickCode(rec);
        if (c) set.add(c);
      }
    }
    return set;
  });
}

/**
 * 取某口径的全部板块清单（东财，缓存 6h）。
 * best-effort：失败返回 []。
 */
export async function fetchBoards(kind: BoardKind, signal?: AbortSignal): Promise<BoardMeta[]> {
  return cached(`breadth:boards:${kind}`, BOARD_TTL_MS, async () => {
    const data = await callAkshare(funcs(kind).name, {}, signal);
    const out: BoardMeta[] = [];
    if (Array.isArray(data)) {
      for (const rec of data as Array<Record<string, unknown>>) {
        const name = String(rec['板块名称'] ?? rec['名称'] ?? '').trim();
        const code = String(rec['板块代码'] ?? rec['代码'] ?? '').trim();
        if (name && code) out.push({ code, name, kind });
      }
    }
    return out;
  });
}

/**
 * 取单个板块的成分股 6 位代码（按板块名，缓存 6h）。
 * akshare 成分接口以板块名称（symbol）为入参。best-effort：失败/为空返回 []。
 */
export async function fetchBoardConstituents(
  kind: BoardKind,
  boardName: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const name = (boardName ?? '').trim();
  if (!name) return [];
  return cached(`breadth:cons:${kind}:${name}`, CONS_TTL_MS, async () => {
    try {
      const data = await callAkshare(funcs(kind).cons, { symbol: name }, signal);
      const codes = new Set<string>();
      if (Array.isArray(data)) {
        for (const rec of data as Array<Record<string, unknown>>) {
          const c = pickCode(rec);
          if (c) codes.add(c);
        }
      }
      return Array.from(codes);
    } catch (e) {
      console.warn(`[breadth] 取板块成分失败 ${kind}:${name}：`, e instanceof Error ? e.message : e);
      return [];
    }
  });
}
