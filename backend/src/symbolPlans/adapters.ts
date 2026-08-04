import type {
  BreadthEvidence,
  KlineBar,
  SymbolAssetType,
  SymbolBenchmark,
} from '@stock-agent/shared';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { capabilityOf, trackingIndexOf } from './capability';

// 资产适配层（计划 9.1）。纪律：technicalEvidence / structure 里不得出现
// 「如果是 ETF 就换一种高低点算法」这类分支；个股与 ETF 的差异全部收敛在这里，
// 只影响「输入哪些证据」与「执行闸门」，不改技术定义本身。

export interface AssetMetadata {
  assetType: SymbolAssetType;
  /** 涨跌幅上限（%），ETF 为 10，主板 10，创业板/科创 20，北交所 30 */
  limitPct: number;
  /** T+1 是否适用（A 股全适用，留字段以备将来） */
  t1: boolean;
  /** 所属板块（个股用于广度与 RS），取不到为 null */
  boardCode: string | null;
  boardName: string | null;
}

export interface ExecutionQualityItem {
  key: string;
  value: string;
  missing: boolean;
}

export interface AssetEventRisk {
  kind: string;
  date: string | null;
  note: string;
}

export interface SymbolIdentity {
  code: string;
  name: string;
  secid?: string;
}

/**
 * 涨跌幅上限（与 playbook/rules.ts 的 limitPct 口径一致）。
 * ST/*ST 主板股是 5%，只看代码段会漏判——涨停时算不出阻断，等于给出不可成交的买入建议。
 */
function limitPctOf(code: string, name?: string): number {
  if (name && /^\s*\*?ST/i.test(name)) return 5;
  if (/^(30|68)/.test(code)) return 20;
  if (/^(43|83|87|88|92)/.test(code)) return 30;
  return 10;
}

/** 场内基金代码段：51/52/56/58 沪市 ETF，15 深市 ETF，16 深市 LOF */
const FUND_PREFIX = /^(51|52|56|58|15|16)/;

/**
 * 资产类型判定。
 * 不能只凭「传了 secid」就判指数：ETF 同样有 secid（1.510300），HTTP 路由也直接透传 body.secid，
 * 一旦误判成指数就会恒定命中「指数不可直接交易」的硬阻断，整条链路锁成 wait。
 * secid 只用来解开唯一真正的歧义——6 位代码上的指数/个股撞码（000300 指数 vs 000300 个股）。
 */
export function inferAssetType(code: string, secid?: string): SymbolAssetType {
  if (FUND_PREFIX.test(code)) return 'etf';
  if (/^399/.test(code)) return 'index'; // 深证系指数，与个股代码段不重叠
  if (/^\d{6}$/.test(code)) {
    // 000xxx 个股在深市（secid 前缀 0.），同码的沪市/中证指数走 1. / 2.
    if (secid && (secid.startsWith('2.') || secid.startsWith('1.000'))) return 'index';
    return 'stock';
  }
  return 'index';
}

export interface SymbolAnalysisAdapter {
  assetType: SymbolAssetType;
  resolveBenchmarks(id: SymbolIdentity): Promise<SymbolBenchmark[]>;
  loadAssetMetadata(id: SymbolIdentity): Promise<AssetMetadata>;
  loadBreadthEvidence(id: SymbolIdentity): Promise<BreadthEvidence | null>;
  loadExecutionQuality(id: SymbolIdentity, bars: KlineBar[]): Promise<ExecutionQualityItem[]>;
  loadEventRisks(id: SymbolIdentity): Promise<AssetEventRisk[]>;
  /** 执行硬阻断：非空则动作锁定为等待 */
  hardBlocks(id: SymbolIdentity, bars: KlineBar[]): Promise<string[]>;
}

/** 宽基基准，个股与 ETF 共用。必须带 secid：000300 与个股撞码，不传会被解析成深市个股 */
const BROAD_MARKET: SymbolBenchmark = {
  code: '000300',
  name: '沪深300',
  role: 'broad_market',
  secid: '1.000300',
};

/**
 * 读板块广度日频快照（R3：只读快照，禁止实时遍历板块成分）。
 * 快照缺失或过期一律返回 missing=true，页面据此显示未覆盖。
 */
function readBoardBreadthSnapshot(boardCode: string, boardName: string): BreadthEvidence {
  const cap = capabilityOf('boardBreadthSnapshot');
  const rows = db
    .select()
    .from(schema.boardNewHighSnapshots)
    .where(eq(schema.boardNewHighSnapshots.boardCode, boardCode))
    .orderBy(desc(schema.boardNewHighSnapshots.tradeDate))
    .limit(2)
    .all();

  const latest = rows[0];
  if (!latest) {
    return {
      scopeCode: boardCode,
      scopeName: boardName,
      scopeKind: 'board',
      tradeDate: '',
      newHighCount: 0,
      total: 0,
      ratio: 0,
      rank: null,
      trend: 'unknown',
      missing: true,
      note: `无板块广度快照（${cap.note}）`,
    };
  }

  // 快照超过 5 个自然日视为过期（跨长假容忍）
  const ageDays = (Date.now() - new Date(`${latest.tradeDate}T15:00:00+08:00`).getTime()) / 86_400_000;
  // 日期不可解析时 ageDays 为 NaN，NaN > 5 为 false 会把过期快照当成有效数据，必须显式判定
  const stale = !Number.isFinite(ageDays) || ageDays > 5;
  const prev = rows[1];
  const trend: BreadthEvidence['trend'] = !prev
    ? 'unknown'
    : latest.newHighCount > prev.newHighCount
      ? 'improving'
      : latest.newHighCount < prev.newHighCount
        ? 'deteriorating'
        : 'flat';

  return {
    scopeCode: latest.boardCode,
    scopeName: latest.boardName,
    scopeKind: 'board',
    tradeDate: latest.tradeDate,
    newHighCount: latest.newHighCount,
    total: latest.consTotal,
    ratio: latest.ratio,
    rank: latest.rank,
    trend,
    missing: stale,
    note: stale
      ? `广度快照为 ${latest.tradeDate}，已过期 ${Math.floor(ageDays)} 天，仅作参考`
      : `快照日 ${latest.tradeDate}，板块内 ${latest.newHighCount}/${latest.consTotal} 只创新高（横向第 ${latest.rank} 名）`,
  };
}

/** 通用执行质量：日均成交额与数据完整性，个股/ETF 共用 */
function commonExecutionQuality(bars: KlineBar[]): ExecutionQualityItem[] {
  const out: ExecutionQualityItem[] = [];
  const win = bars.slice(-20);
  if (win.length >= 5) {
    const avgAmount = win.reduce((s, b) => s + b.amount, 0) / win.length;
    out.push({
      key: '近20日日均成交额',
      value: avgAmount >= 1e8 ? `${(avgAmount / 1e8).toFixed(2)} 亿` : `${(avgAmount / 1e4).toFixed(0)} 万`,
      missing: false,
    });
  } else {
    out.push({ key: '近20日日均成交额', value: '样本不足', missing: true });
  }
  // 五档实测不可用，显式标缺失而不是给个假数
  const spread = capabilityOf('orderBookL2');
  out.push({
    key: '盘口价差/冲击成本',
    value: spread.verdict === 'available' ? '待接入' : spread.note,
    missing: spread.verdict !== 'available',
  });
  return out;
}

/** 涨跌停与停牌类硬阻断，个股/ETF 共用（ETF 也有 10% 限制） */
function commonHardBlocks(id: SymbolIdentity, bars: KlineBar[]): string[] {
  const out: string[] = [];
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!last) return ['无行情数据'];
  if (prev && prev.close > 0) {
    const pct = ((last.close - prev.close) / prev.close) * 100;
    const cap = limitPctOf(id.code, id.name);
    if (pct >= cap - 0.5) out.push('当根涨停，买入不可成交');
    if (pct <= -(cap - 0.5)) out.push('当根跌停，止损可能无法执行');
  }
  if (last.volume === 0 && last.amount === 0) out.push('疑似停牌（成交为零）');
  return out;
}

// ===== 个股适配层（计划 9.2）=====

/**
 * 个股元信息按 code 短期缓存。
 * 板块反查要扫 400 行快照并逐行 JSON.parse，而一次建上下文会经 resolveBenchmarks /
 * loadBreadthEvidence / 直接调用共触发三次；better-sqlite3 是同步 API，盘中批量求值时会明显阻塞事件循环。
 */
/**
 * 只缓存板块反查结果。limitPct 依赖 name（ST 判定），而 name 是可省参数——
 * 连 meta 一起缓存的话，首次不带 name 调用会把 ST 股的 10% 存住，
 * 10 分钟内即使带上「*ST」也拿不到正确的 5%，会算出一个不存在的涨停价喂给 LLM。
 */
const STOCK_BOARD_CACHE = new Map<string, { board: StockBoard; at: number }>();
const STOCK_META_TTL_MS = 10 * 60 * 1000;
const STOCK_META_MAX = 200;

interface StockBoard {
  boardCode: string | null;
  boardName: string | null;
}

function stockMetadataOf(id: SymbolIdentity): AssetMetadata {
  const now = Date.now();
  const hit = STOCK_BOARD_CACHE.get(id.code);
  if (hit && now - hit.at < STOCK_META_TTL_MS) {
    return { assetType: 'stock', limitPct: limitPctOf(id.code, id.name), t1: true, ...hit.board };
  }

  let boardCode: string | null = null;
  let boardName: string | null = null;
  try {
    // 所属板块从广度快照的成分反查：快照已按板块存 core_codes，避免实时拉成分
    const rows = db
      .select()
      .from(schema.boardNewHighSnapshots)
      .orderBy(desc(schema.boardNewHighSnapshots.tradeDate))
      .limit(400)
      .all();
    const found = rows.find((r) => {
      try {
        const codes = JSON.parse(r.coreCodes) as string[];
        return Array.isArray(codes) && codes.includes(id.code);
      } catch {
        return false;
      }
    });
    if (found) {
      boardCode = found.boardCode;
      boardName = found.boardName;
    }
  } catch {
    /* 快照不可用时按无板块处理 */
  }

  const board: StockBoard = { boardCode, boardName };
  for (const [k, v] of STOCK_BOARD_CACHE) {
    if (now - v.at >= STOCK_META_TTL_MS) STOCK_BOARD_CACHE.delete(k);
  }
  while (STOCK_BOARD_CACHE.size >= STOCK_META_MAX) {
    const oldest = STOCK_BOARD_CACHE.keys().next().value;
    if (oldest == null) break;
    STOCK_BOARD_CACHE.delete(oldest);
  }
  STOCK_BOARD_CACHE.set(id.code, { board, at: now });
  return { assetType: 'stock', limitPct: limitPctOf(id.code, id.name), t1: true, ...board };
}

export const stockAdapter: SymbolAnalysisAdapter = {
  assetType: 'stock',

  async resolveBenchmarks(id) {
    const out: SymbolBenchmark[] = [];
    const meta = await this.loadAssetMetadata(id);
    if (meta.boardCode && meta.boardName) {
      out.push({ code: meta.boardCode, name: meta.boardName, role: 'sector' });
    }
    out.push(BROAD_MARKET);
    return out;
  },

  async loadAssetMetadata(id) {
    return stockMetadataOf(id);
  },

  async loadBreadthEvidence(id) {
    const meta = await this.loadAssetMetadata(id);
    if (!meta.boardCode || !meta.boardName) {
      return {
        scopeCode: '',
        scopeName: '',
        scopeKind: 'board',
        tradeDate: '',
        newHighCount: 0,
        total: 0,
        ratio: 0,
        rank: null,
        trend: 'unknown',
        missing: true,
        note: '该个股未映射到板块广度快照，广度证据缺失',
      };
    }
    return readBoardBreadthSnapshot(meta.boardCode, meta.boardName);
  },

  async loadExecutionQuality(id, bars) {
    const out = commonExecutionQuality(bars);
    out.push({ key: '涨跌幅上限', value: `${limitPctOf(id.code, id.name)}%`, missing: false });
    out.push({ key: '交易制度', value: 'T+1，当日买入不可当日卖出', missing: false });
    return out;
  },

  async loadEventRisks(id) {
    const out: AssetEventRisk[] = [];
    // 解禁与增减持实测可用，含未来解禁日
    try {
      const { getLockupAndHolders } = await import('../market/datacenter');
      const text = await getLockupAndHolders(id.code);
      if (text && !text.includes('暂无')) {
        out.push({ kind: '解禁/增减持', date: null, note: text.slice(0, 300) });
      }
    } catch {
      /* 取不到按无事件处理 */
    }
    // 未来财报日历实测不可用，显式声明缺口而不是假装覆盖
    const cal = capabilityOf('stockFutureEarningsCalendar');
    if (cal.verdict !== 'available') {
      out.push({ kind: '财报/业绩预告日', date: null, note: `未覆盖：${cal.note}` });
    }
    return out;
  },

  async hardBlocks(id, bars) {
    return commonHardBlocks(id, bars);
  },
};

// ===== ETF 适配层（计划 9.3）=====

export const etfAdapter: SymbolAnalysisAdapter = {
  assetType: 'etf',

  async resolveBenchmarks(id) {
    const out: SymbolBenchmark[] = [];
    const idx = trackingIndexOf(id.code);
    // secid 为 null 的境外指数（如恒生科技）取不到东财 K 线，不登记为基准，
    // 否则相对强弱会静默算不出来；它的影响改由 loadEventRisks 的跨境说明覆盖
    if (idx?.secid) {
      out.push({
        code: idx.indexCode,
        name: idx.indexName,
        role: 'underlying_index',
        secid: idx.secid,
      });
    }
    out.push(BROAD_MARKET);
    return out;
  },

  async loadAssetMetadata(id) {
    return { assetType: 'etf', limitPct: 10, t1: true, boardCode: null, boardName: null };
  },

  async loadBreadthEvidence(id) {
    // ETF 成分广度需要「跟踪指数代码 + 指数成分」两者齐备。
    // 实测：成分数据可用，但 ETF→指数自动解析不可用，故只支持内置映射表内的 ETF。
    const idx = trackingIndexOf(id.code);
    const cap = capabilityOf('etfIndexAutoResolve');
    if (!idx) {
      return {
        scopeCode: '',
        scopeName: '',
        scopeKind: 'index',
        tradeDate: '',
        newHighCount: 0,
        total: 0,
        ratio: 0,
        rank: null,
        trend: 'unknown',
        missing: true,
        note: `${id.code} 未登记跟踪指数，成分广度缺失（${cap.note}）`,
      };
    }
    // MVP：指数成分广度快照尚未按指数落库（board_newhigh_snapshots 只按板块存），
    // 因此这里显式标缺失而不是拿基金季报前十大冒充分母。
    return {
      scopeCode: idx.indexCode,
      scopeName: idx.indexName,
      scopeKind: 'index',
      tradeDate: '',
      newHighCount: 0,
      total: 0,
      ratio: 0,
      rank: null,
      trend: 'unknown',
      missing: true,
      note: `跟踪 ${idx.indexName}（${idx.indexCode}），但指数成分广度快照尚未落库，本项未覆盖`,
    };
  },

  async loadExecutionQuality(id, bars) {
    const out = commonExecutionQuality(bars);
    // IOPV / 折溢价实测可用，直接复用 etf/data 的取数，不重复实现
    try {
      const { fetchEtfQuote } = await import('../etf/data');
      const q = await fetchEtfQuote(id.code);
      const premium =
        q.premiumPct ??
        (q.iopv != null && q.iopv > 0 && q.price != null && q.price > 0
          ? ((q.price - q.iopv) / q.iopv) * 100
          : null);
      out.push(
        premium != null
          ? { key: '折溢价', value: `${premium.toFixed(2)}%`, missing: false }
          : { key: '折溢价', value: 'IOPV 与集思录均不可用', missing: true },
      );
      out.push(
        q.iopv != null
          ? { key: 'IOPV', value: q.iopv.toFixed(4), missing: false }
          : { key: 'IOPV', value: '取数失败', missing: true },
      );
    } catch {
      out.push({ key: '折溢价', value: '取数失败', missing: true });
    }
    // 跟踪误差实测不可用
    out.push({ key: '跟踪误差', value: '未接入数据源', missing: true });
    out.push({ key: '涨跌幅上限', value: '10%', missing: false });
    return out;
  },

  async loadEventRisks(id) {
    const out: AssetEventRisk[] = [];
    const idx = trackingIndexOf(id.code);
    if (idx?.indexCode === 'HSTECH') {
      out.push({
        kind: '跨境交易日错位',
        date: null,
        note: '跟踪港股指数，存在 A 股与港股休市错位、隔夜跳空与汇率影响；指数点位不可直接作为 ETF 下单价',
      });
    }
    out.push({ kind: '指数调仓生效日', date: null, note: '未覆盖：无数据源' });
    out.push({ kind: '份额拆分/折算', date: null, note: '未覆盖：无折算事件台账，跨折算日成交量不可比' });
    return out;
  },

  async hardBlocks(id, bars) {
    return commonHardBlocks(id, bars);
  },
};

/** 指数适配层：可分析但不可交易 */
export const indexAdapter: SymbolAnalysisAdapter = {
  assetType: 'index',
  async resolveBenchmarks() {
    return [BROAD_MARKET];
  },
  async loadAssetMetadata() {
    return { assetType: 'index', limitPct: 0, t1: false, boardCode: null, boardName: null };
  },
  async loadBreadthEvidence() {
    return null;
  },
  async loadExecutionQuality(_id, bars) {
    return commonExecutionQuality(bars);
  },
  async loadEventRisks() {
    return [{ kind: '不可直接交易', date: null, note: '指数只作市场参考，动作须落到对应 ETF 或个股' }];
  },
  async hardBlocks() {
    return ['指数不可直接交易，动作须落到可交易载体'];
  },
};

export function adapterFor(assetType: SymbolAssetType): SymbolAnalysisAdapter {
  return assetType === 'etf' ? etfAdapter : assetType === 'index' ? indexAdapter : stockAdapter;
}
