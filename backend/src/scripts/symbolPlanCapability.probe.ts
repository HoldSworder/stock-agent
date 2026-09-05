// Phase 0 能力矩阵实测：把「计划里假设有、但仓库未验证」的四项数据能力打一遍真实请求，
// 产出 可用 / 降级 / 不可用 三态结论，供后续阶段决定是否打开对应增强能力。
// 只读探测，不写库。运行：cd backend && pnpm exec tsx src/scripts/symbolPlanCapability.probe.ts
import { getKline } from '../market/eastmoney';
import { callAkshare } from '../market/akshare';
import { callAstock } from '../astock/client';
import { getLockupAndHolders } from '../market/datacenter';
import type { KlinePeriod } from '@stock-agent/shared';

type Verdict = '可用' | '降级' | '不可用';

interface ProbeRow {
  capability: string;
  verdict: Verdict;
  detail: string;
}

const rows: ProbeRow[] = [];
const push = (capability: string, verdict: Verdict, detail: string): void => {
  rows.push({ capability, verdict, detail });
  console.log(`[${verdict}] ${capability} — ${detail}`);
};

/** 探测样本：一只行业 ETF、一只跨境 ETF、一只普通个股 */
const ETF_INDUSTRY = '159516'; // 半导体设备ETF
const ETF_CROSS_BORDER = '513180'; // 恒生科技指数ETF
const STOCK = '600519'; // 贵州茅台

/** 单项探测包一层，失败不中断整轮 */
async function probe(capability: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    push(capability, '不可用', `探测抛错：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ===== 1. 分钟线可回溯深度（计划 4.1 目标上限 320 根）=====

async function probeMinuteDepth(): Promise<void> {
  for (const period of ['60m', '15m'] as KlinePeriod[]) {
    const label = `分钟线深度 ${period}`;
    const t0 = Date.now();
    const bars = await getKline(ETF_INDUSTRY, period, 320);
    const ms = Date.now() - t0;
    const span =
      bars.length > 0 ? `${bars[0].time} → ${bars[bars.length - 1].time}` : '无数据';
    if (bars.length >= 320) {
      push(label, '可用', `请求 320 根，实得 ${bars.length} 根，${ms}ms，区间 ${span}`);
    } else if (bars.length >= 120) {
      push(
        label,
        '降级',
        `请求 320 根，实得 ${bars.length} 根（不足目标），${ms}ms，区间 ${span}。证据层需按实际样本降级并写入 warnings`,
      );
    } else {
      push(label, '不可用', `请求 320 根，实得 ${bars.length} 根，${ms}ms，样本过少不足以做结构判断`);
    }
  }
}

// ===== 2. 五档盘口（计划 4.8 盘口价差 / 冲击成本的前置）=====

/**
 * sidecar 的五档端点名。
 *
 * 别再往这里塞猜的名字：首轮探测就是靠猜（quotes/quote/l2_quotes/snapshot）全 404，
 * 把本来一直可用的五档误判成「无数据源」，价差闸门因此空转了一个月。
 * 要加候选先去 `GET /api/manifest` 对一遍真实端点名，那份清单就是权威。
 * 端点的入参名也来自 manifest：mootdx_quote 收的是 symbols（复数、逗号分隔），不是 symbol。
 */
const L2_ENDPOINTS = ['mootdx_quote'];

async function probeOrderBook(): Promise<void> {
  const label = '五档盘口';
  const tried: string[] = [];
  for (const ep of L2_ENDPOINTS) {
    try {
      const res = await callAstock(ep, { symbols: [STOCK] }, undefined, 'astockdata', 12_000, 1);
      const text = JSON.stringify(res);
      // 判定是否真含买卖档位字段（bid/ask 或 买一/卖一）
      const hasBook = /bid1|ask1|bid_1|ask_1|买一|卖一|bid_p|ask_p/i.test(text);
      if (hasBook) {
        push(label, '可用', `端点 ${ep} 返回含买卖档位字段，可据此算价差`);
        return;
      }
      tried.push(`${ep}(无档位字段)`);
    } catch (e) {
      tried.push(`${ep}(${e instanceof Error ? e.message.slice(0, 40) : 'err'})`);
    }
  }
  push(label, '不可用', `试过 ${tried.join(' / ')}，未取到买卖档位。4.8 的盘口价差/冲击成本保持缺失标记`);
}

// ===== 3. ETF 跟踪指数与成分（计划 4.7 ETF 侧广度的前置）=====

/** 从 akshare 结果里粗略数行数 */
function countRows(res: unknown): number {
  const data = (res as { data?: unknown })?.data ?? res;
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    const first = Object.values(data as Record<string, unknown>)[0];
    if (Array.isArray(first)) return first.length;
  }
  return 0;
}

async function probeEtfIndexMapping(): Promise<void> {
  // 3.1 ETF → 跟踪指数代码：先看 fund_etf_spot_em / fund_etf_basic 之类是否带指数字段
  const mapLabel = 'ETF→跟踪指数代码';
  let indexCode: string | null = null;
  try {
    const res = await callAkshare('fund_etf_spot_em', {}, undefined, 'akshare', 30_000, 1);
    const text = JSON.stringify(res).slice(0, 4000);
    const hasIndexField = /跟踪指数|指数代码|index_code|underlying/i.test(text);
    push(
      mapLabel,
      hasIndexField ? '降级' : '不可用',
      hasIndexField
        ? 'fund_etf_spot_em 出现疑似指数字段，需人工确认字段名与覆盖度后才可依赖'
        : 'fund_etf_spot_em 无跟踪指数字段。需手工维护 ETF→指数映射表，或保持缺失',
    );
  } catch (e) {
    push(mapLabel, '不可用', `fund_etf_spot_em 失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 3.2 指数成分股：若能拿到指数代码，验证 index_stock_cons 能否给出全量成分
  const consLabel = '跟踪指数成分股（含权重）';
  // 半导体设备ETF 159516 跟踪中证半导体材料设备主题指数，代码 H30184 / 931743 视口径而定，
  // 这里用一个常见宽基指数验证接口本身是否可用，避免因单一代码猜错而误判接口不可用。
  for (const probeIndex of ['000300', '931743']) {
    try {
      const res = await callAkshare(
        'index_stock_cons_weight_csindex',
        { symbol: probeIndex },
        undefined,
        'akshare',
        30_000,
        1,
      );
      const n = countRows(res);
      if (n > 0) {
        indexCode = probeIndex;
        push(consLabel, '可用', `index_stock_cons_weight_csindex(${probeIndex}) 返回 ${n} 行成分（含权重）`);
        break;
      }
    } catch {
      /* 换下一个候选 */
    }
  }
  if (!indexCode) {
    push(
      consLabel,
      '不可用',
      'index_stock_cons_weight_csindex 未取到成分。ETF 侧成分广度与头部集中度保持缺失，不得用基金季报前十大冒充',
    );
  }

  // 3.3 现有 fetchEtfConstituents 的实际口径（基金季报持仓）
  const holdLabel = 'ETF 基金季报持仓（现有实现）';
  try {
    const { fetchEtfConstituents } = await import('../etf/data');
    const list = await fetchEtfConstituents(ETF_CROSS_BORDER);
    push(
      holdLabel,
      list.length >= 20 ? '降级' : '不可用',
      `fetchEtfConstituents(${ETF_CROSS_BORDER}) 返回 ${list.length} 只。季报口径滞后且常只有前十大，` +
        `仅可作定性参考，不能当指数成分广度分母`,
    );
  } catch (e) {
    push(holdLabel, '不可用', `失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ===== 4. 个股未来事件日历（计划 9.2 事件风险的前置）=====

async function probeEventCalendar(): Promise<void> {
  // 4.1 已有能力：解禁 + 增减持（含未来解禁日）
  const lockupLabel = '个股解禁/增减持（现有实现）';
  try {
    const text = await getLockupAndHolders(STOCK);
    const ok = text.length > 20 && !text.includes('暂无');
    push(
      lockupLabel,
      ok ? '可用' : '降级',
      ok ? `getLockupAndHolders 返回 ${text.length} 字符，含未来解禁安排` : `返回内容为空或无数据：${text.slice(0, 60)}`,
    );
  } catch (e) {
    push(lockupLabel, '不可用', `失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // 4.2 缺口验证：财报预约披露日 / 业绩预告日
  const calLabel = '财报预约披露日/业绩预告日历';
  const candidates: Array<[string, Record<string, string>]> = [
    ['stock_yjyg_em', { date: '20260630' }],
    ['stock_report_disclosure', { market: 'sse', period: '2026年报' }],
    ['stock_yysj_em', { symbol: 'sh', date: '20260630' }],
  ];
  const tried: string[] = [];
  for (const [fn, params] of candidates) {
    try {
      const res = await callAkshare(fn, params, undefined, 'akshare', 30_000, 1);
      const n = countRows(res);
      if (n > 0) {
        push(calLabel, '可用', `${fn} 返回 ${n} 行，可作事件日历来源（需确认是否含未来日期）`);
        return;
      }
      tried.push(`${fn}(0行)`);
    } catch (e) {
      tried.push(`${fn}(${e instanceof Error ? e.message.slice(0, 30) : 'err'})`);
    }
  }
  push(calLabel, '不可用', `试过 ${tried.join(' / ')}。事件日历保持缺失标记，仅用解禁安排兜底`);
}

// ===== 汇总 =====

async function main(): Promise<void> {
  console.log('=== Phase 0 能力矩阵实测 ===\n');
  await probe('分钟线深度', probeMinuteDepth);
  await probe('五档盘口', probeOrderBook);
  await probe('ETF 指数映射', probeEtfIndexMapping);
  await probe('个股事件日历', probeEventCalendar);

  console.log('\n=== 能力矩阵 ===\n');
  console.log('| 能力 | 结论 | 说明 |');
  console.log('|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.capability} | ${r.verdict} | ${r.detail} |`);
  }
  const unusable = rows.filter((r) => r.verdict === '不可用');
  console.log(
    `\n合计 ${rows.length} 项：可用 ${rows.filter((r) => r.verdict === '可用').length}，` +
      `降级 ${rows.filter((r) => r.verdict === '降级').length}，不可用 ${unusable.length}`,
  );
  if (unusable.length > 0) {
    console.log('\n不可用项按计划 17.2 保持增强项状态，不进 MVP 门禁：');
    for (const r of unusable) console.log(`- ${r.capability}`);
  }
}

await main();
