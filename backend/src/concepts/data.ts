import type { ConceptStockItem, ConceptWindow } from '@stock-agent/shared';
import { callAkshare } from '../market/akshare';
import { queryStock } from '../iwencai/client';
import { cached } from '../lib/ttlCache';

// 热门细分概念取数层（纯只读，best-effort）：
//  - 概念热度榜：同花顺「概念资金流·即时」(akshare stock_fund_flow_concept)，一次拿
//    概念名 + 涨跌幅 + 资金净额 + 公司家数 + 今日领涨股，覆盖六氟化钨等东财没有的细分概念。
//  - 概念成分股：同花顺成分接口已被 akshare 移除，改经问财 (hithink-stock-selector) 按概念名取板块全部标的，
//    带涨幅/总市值，用于「点击概念展开 + 标注龙头/今日领涨」。问财为按需调用（展开时才取）。

/** 概念资金流缓存时长（盘中变动，短缓存防抖） */
const FLOW_TTL_MS = 90 * 1000;
/** 成分股缓存时长（成分慢变，但涨幅会变；折中 5min） */
const CONS_TTL_MS = 5 * 60 * 1000;

type Row = Record<string, unknown>;

/** 安全转 number（含千分位/百分号/字符串）；不可解析返回 null */
function n(v: unknown): number | null {
  if (v == null || v === '') return null;
  const x = Number(String(v).replace(/[,%\s]/g, '').trim());
  return Number.isFinite(x) ? x : null;
}

function asRows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

/** 从行记录里按候选键名尽力取值（同花顺/问财列名随网页改版有出入，多名兜底） */
function pick(rec: Row, keys: string[]): unknown {
  for (const k of keys) {
    if (k in rec && rec[k] != null && rec[k] !== '') return rec[k];
  }
  return undefined;
}

/** 同花顺概念资金流榜一项 */
export interface ConceptFlowItem {
  name: string;
  pct: number | null;
  /** 资金净额（亿元） */
  netInflow: number | null;
  companies: number | null;
  leadStock: string;
  leadStockPct: number | null;
}

/** 窗口标签（3日/5日/…）→ akshare stock_fund_flow_concept 的 symbol 值 */
const WINDOW_SYMBOL: Record<ConceptWindow, string> = {
  '3日': '3日排行',
  '5日': '5日排行',
  '10日': '10日排行',
  '20日': '20日排行',
};

/**
 * 取同花顺概念资金流·近 N 日排行榜（缓存 90s，按窗口分键）。best-effort：失败/为空返回 []。
 * akshare 列：序号/行业/行业指数/涨跌幅(即时)或区间涨跌幅(N日排行)/流入资金/流出资金/净额/公司家数/领涨股/领涨股-涨跌幅/当前价。
 * 列名随同花顺改版及窗口口径有出入，按候选名兜底解析。
 */
export async function fetchConceptFundFlow(
  window: ConceptWindow = '5日',
  signal?: AbortSignal,
): Promise<ConceptFlowItem[]> {
  const symbol = WINDOW_SYMBOL[window] ?? WINDOW_SYMBOL['5日'];
  return cached(`concepts:ths-flow:${window}`, FLOW_TTL_MS, async () => {
    const data = await callAkshare('stock_fund_flow_concept', { symbol }, signal);
    const out: ConceptFlowItem[] = [];
    for (const rec of asRows(data)) {
      const name = String(pick(rec, ['行业', '概念', '名称', '行业名称']) ?? '').trim();
      if (!name) continue;
      out.push({
        name,
        pct: n(pick(rec, ['涨跌幅', '区间涨跌幅', '阶段涨跌幅', '行业-涨跌幅', '行业涨跌幅'])),
        netInflow: n(pick(rec, ['净额', '净额(亿)', '净额（亿）'])),
        companies: n(pick(rec, ['公司家数', '家数'])),
        leadStock: String(pick(rec, ['领涨股']) ?? '').trim(),
        leadStockPct: n(pick(rec, ['领涨股-涨跌幅', '涨跌幅.1', '领涨股涨跌幅'])),
      });
    }
    return out;
  });
}

/**
 * 取某概念的板块全部成分股（缓存 5min），经问财 (hithink-stock-selector)。
 * 同花顺成分接口已被 akshare 移除，问财是当前唯一可行的细分概念成分来源。
 * 返回带 code/name/price/pct/marketCap；龙头/领涨由 service 层据此标注。best-effort：失败抛错由路由降级。
 */
export async function fetchConceptStocks(
  concept: string,
  signal?: AbortSignal,
): Promise<ConceptStockItem[]> {
  const name = (concept ?? '').trim();
  if (!name) return [];
  return cached(`concepts:cons:${name}`, CONS_TTL_MS, async () => {
    // 按总市值从大到小排，便于龙头识别；limit 取 50 覆盖板块主要成分
    const json = await queryStock(`${name}概念股，按总市值从大到小排列`, {
      limit: '50',
      signal,
    });
    const columns = Array.isArray((json as Row).columns) ? ((json as Row).columns as Row[]) : [];
    // index_name（中文列名）→ datas 实际键名（问财键常带日期后缀）
    const keyOf = (indexName: string): string | null => {
      const col = columns.find((c) => String(c.index_name ?? '') === indexName);
      return col ? String(col.key ?? col.index_name ?? '') : null;
    };
    const codeKey = keyOf('股票代码') ?? '股票代码';
    const nameKey = keyOf('股票简称') ?? '股票简称';
    const priceKey = keyOf('最新价') ?? '最新价';
    const pctKey = keyOf('涨跌幅') ?? keyOf('涨跌幅:前复权') ?? '涨跌幅';
    const capKey = keyOf('总市值') ?? '总市值';
    const rows = asRows((json as Row).datas);
    const out: ConceptStockItem[] = [];
    for (const r of rows) {
      const code = String(r[codeKey] ?? '').slice(0, 6);
      if (!/^\d{6}$/.test(code)) continue;
      const capRaw = n(r[capKey]);
      // 问财总市值多为元，>1e8 视为元 → 换算亿
      const marketCap = capRaw == null ? null : capRaw > 1e8 ? capRaw / 1e8 : capRaw;
      out.push({
        code,
        name: String(r[nameKey] ?? ''),
        price: n(r[priceKey]),
        pct: n(r[pctKey]),
        marketCap,
        isLeader: false,
        isTopGainer: false,
      });
    }
    return out;
  });
}
