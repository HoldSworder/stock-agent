import type { ScreenPick } from '@stock-agent/shared';
import { miaoxiang } from '../miaoxiang/client';
import type { ScreenEngine, EngineOutput, EngineRunInput } from './engines';
import { isTradableAShare } from './filter';
import type { SnapshotRow } from './snapshot';
import { getNlStrategy } from './nlStrategies';

// 自然语言选股链路（engine）：把妙想 mx_screener（自然语言条件选股）包成与 multifactor 并列的链路。
// 与多因子量化选股的区别：不做确定性硬筛/打分，直接由妙想按 keyword 量化筛选返回标的。
// 战法两条 pick 选股逻辑（尾盘/妙想）原文 keyword 迁移为预设（nlStrategies），与定时任务同源 → 选出结果一致。

/** 妙想响应的解析行（仅取选股留痕/复盘所需字段） */
interface NlRow {
  code: string;
  name: string;
  price: number;
  pct: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normCode(raw: unknown): string {
  const m = String(raw ?? '').match(/\d{6}/);
  return m ? m[0] : '';
}

// 妙想 stock-screen 响应嵌套较深，标的全量行在 allResults.result.dataList，
// 每行用稳定字段名携带数据：SECURITY_CODE / SECURITY_SHORT_NAME / NEWEST_PRICE / CHG。
// 这里递归定位「元素含 SECURITY_CODE 的数组」，避免硬编码 envelope 层级（兼容微调）。
function findDataList(node: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(node)) {
    const objs = node.filter(isRecord);
    if (objs.length > 0 && objs.some((o) => 'SECURITY_CODE' in o)) return objs;
    for (const it of node) {
      const found = findDataList(it);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(node)) {
    for (const v of Object.values(node)) {
      const found = findDataList(v);
      if (found) return found;
    }
  }
  return null;
}

// 兜底：partialResults 为前若干行的 Markdown 表（|序号|代码|名称|最新价|涨跌幅|…）。
// 仅当结构化 dataList 缺失时启用；按表头标题前缀定位列，避免列序/日期后缀差异。
function findMarkdownTable(node: unknown): string | null {
  if (typeof node === 'string') {
    return node.includes('|代码|') && node.includes('|名称|') ? node : null;
  }
  if (Array.isArray(node)) {
    for (const it of node) {
      const r = findMarkdownTable(it);
      if (r) return r;
    }
  } else if (isRecord(node)) {
    for (const v of Object.values(node)) {
      const r = findMarkdownTable(v);
      if (r) return r;
    }
  }
  return null;
}

function parseMarkdownRows(table: string): NlRow[] {
  const lines = table.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 3) return [];
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const headers = cells(lines[0]);
  const idxOf = (prefix: string) => headers.findIndex((h) => h.startsWith(prefix));
  const ci = idxOf('代码');
  const ni = idxOf('名称');
  const pi = idxOf('最新价');
  const ri = idxOf('涨跌幅');
  if (ci < 0) return [];
  const out: NlRow[] = [];
  for (const line of lines.slice(2)) {
    const c = cells(line);
    const code = normCode(c[ci]);
    if (!code) continue;
    out.push({
      code,
      name: ni >= 0 ? c[ni] ?? '' : '',
      price: pi >= 0 ? num(c[pi]) : 0,
      pct: ri >= 0 ? num(c[ri]) : 0,
    });
  }
  return out;
}

/** 解析妙想选股响应为结构化行：优先结构化 dataList（全量），回退 partialResults 表（前若干行） */
function parseScreenerRows(resp: unknown): NlRow[] {
  const dataList = findDataList(resp);
  const rows: NlRow[] = [];
  if (dataList) {
    for (const it of dataList) {
      const code = normCode(it.SECURITY_CODE);
      if (!code) continue;
      rows.push({
        code,
        name: String(it.SECURITY_SHORT_NAME ?? ''),
        price: num(it.NEWEST_PRICE),
        pct: num(it.CHG),
      });
    }
  }
  if (rows.length === 0) {
    const table = findMarkdownTable(resp);
    if (table) rows.push(...parseMarkdownRows(table));
  }
  // 去重保序
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.code) ? false : seen.add(r.code)));
}

/** A 股可交易性复用硬筛口径（剔科创/北交/ST），按 code+name 构造最小行判定 */
function tradable(row: NlRow): boolean {
  return isTradableAShare({ code: row.code, name: row.name } as SnapshotRow);
}

export const nlEngine: ScreenEngine = {
  info: {
    id: 'nl',
    name: '自然语言选股',
    description:
      '用自然语言条件经妙想 mx_screener 量化筛选标的（与多因子量化选股并列）。内置「尾盘动能套利 / 妙想量化」两条预设，与战法定时任务同源、选出结果一致。',
    enabled: true,
  },
  async produce(input: EngineRunInput): Promise<EngineOutput> {
    const emit = input.onProgress ?? (() => {});
    const nl = getNlStrategy(input.strategyId);
    emit({ stage: 'snapshot', label: '妙想自然语言筛选', status: 'running' });
    const resp = await miaoxiang.screener(nl.keyword);
    const rows = parseScreenerRows(resp);
    if (rows.length === 0) {
      throw new Error('妙想自然语言选股未返回可解析标的，请稍后重试或检查 MX_APIKEY');
    }
    emit({
      stage: 'snapshot',
      label: '妙想自然语言筛选',
      status: 'done',
      marketCount: rows.length,
    });
    emit({ stage: 'filter', label: 'A 股可交易性过滤', status: 'running' });
    const filtered = rows.filter(tradable);
    emit({
      stage: 'filter',
      label: 'A 股可交易性过滤',
      status: 'done',
      filteredCount: filtered.length,
    });
    const picks: ScreenPick[] = filtered.slice(0, input.topN).map((r, i) => ({
      rank: i + 1,
      code: r.code,
      name: r.name,
      price: r.price,
      pct: r.pct,
      industry: '',
      screenScore: 0,
      factors: [],
      thesis: null,
      riskTags: [],
      confidence: null,
      watchItems: [],
      invalidators: [],
      evalPrice: null,
      evalAt: null,
      evalReturn: null,
    }));
    return {
      strategyId: nl.id,
      strategyName: nl.name,
      marketCount: rows.length,
      filteredCount: filtered.length,
      context: nl.keyword,
      marketView: null,
      selectionLogic: nl.description,
      portfolioRisk: null,
      runId: null,
      picks,
    };
  },
};
