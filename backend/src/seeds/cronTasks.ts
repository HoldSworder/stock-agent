import { sql } from 'drizzle-orm';
import type { ScheduledTaskInput } from '@stock-agent/shared';
import { db, schema } from '../db/client';
import { createTask } from '../tasks';

// 迁移自 openclaw 的股票定时任务种子。
// 默认 enabled=false：配置好 DeepSeek / 妙想 key 并验证后，再到 WebUI 逐个启用，避免误触发实盘/产生费用。
// thinking 默认 off（沿用 openclaw 关闭推理的最佳实践）。

const TZ = 'Asia/Shanghai';
const base = {
  tz: TZ,
  modelConfig: { thinking: false, maxSteps: 14 },
  enabled: false,
} as const;

const SEEDS: ScheduledTaskInput[] = [
  {
    ...base,
    name: '旺财-0900-盘前规划',
    description: '开盘前对热门主线板块做盘前规划，输出当日候选与计划',
    cronExpr: '0 9 * * 1-5',
    prompt:
      '现在是开盘前。请扫描当日 A 股主线热门板块，结合资金流与消息面，输出今日值得关注的板块与候选标的、买点思路与风险提示。给出依据来源，最后用 save_stock_picks 留痕候选标的。',
    notifyChannels: ['webui', 'telegram'],
    timeoutSec: 900,
  },
  {
    ...base,
    name: '妙想-0933-开盘选股买入',
    description: '量化筛选主板热门板块标的，给出开盘买入候选',
    cronExpr: '33 9 * * 1-5',
    prompt:
      '量化筛选：主板、涨幅 2-7%、量比>1.2、成交额>3亿、流通市值 50-800 亿、MACD>0、价格在 20 日均线上的热门板块标的。二次过滤后给出不超过 3 只买入候选，含现价与买点理由，并用 save_stock_picks 留痕。',
    notifyChannels: ['webui', 'telegram'],
    timeoutSec: 600,
  },
  {
    ...base,
    name: '妙想-1015-卖点检查一',
    description: '盘中第一次卖点检查，可止损/止盈，允许补仓',
    cronExpr: '15 10 * * 1-5',
    prompt:
      '盘中第一次卖点检查。查询模拟盘持仓，对每只标的研判是否触发止损/止盈，给出明确操作建议（持有/减仓/清仓/补仓）。每条建议附依据。',
    notifyChannels: ['webui', 'telegram'],
    timeoutSec: 600,
  },
  {
    ...base,
    name: '妙想-1443-卖点检查二',
    description: '收盘前卖点检查，仅卖不补',
    cronExpr: '43 14 * * 1-5',
    prompt:
      '收盘前卖点检查。查询模拟盘持仓，仅做卖点研判（持有/减仓/清仓），不允许补仓。触发卖出条件的给出明确操作与依据。',
    notifyChannels: ['webui', 'telegram'],
    timeoutSec: 600,
  },
  {
    ...base,
    name: '尾盘选股-1445-动能套利筛选',
    description: '尾盘动能套利逻辑筛选，输出含现价',
    cronExpr: '45 14 * * 1-5',
    prompt:
      '执行尾盘动能套利筛选：选出尾盘有持续动能、适合次日套利的标的。输出必须包含每只标的的现价，便于判断介入时机，并用 save_stock_picks 留痕。推送用竖排清单，禁止表格。',
    notifyChannels: ['webui', 'telegram'],
    timeoutSec: 600,
  },
  {
    ...base,
    name: '妙想-1505-收盘复盘',
    description: '日终复盘，无交易操作',
    cronExpr: '5 15 * * 1-5',
    prompt:
      '收盘复盘：回顾今日模拟盘持仓与当日选股表现，结合 query_history 对比此前留痕，总结今日得失与明日关注点。无需交易操作。',
    notifyChannels: ['webui', 'telegram'],
    timeoutSec: 600,
  },
  {
    ...base,
    name: '总裁ETF-0950-早盘扫描',
    description: '早盘扫描候选 ETF，给出操作建议',
    cronExpr: '50 9 * * 1-5',
    prompt:
      '早盘扫描候选 ETF，结合量价与折溢价给出操作建议。约束：每条建议附依据来源；同板块不重复建仓；高折溢价标的显式提示风险。',
    notifyChannels: ['webui', 'telegram'],
    timeoutSec: 600,
  },
  {
    ...base,
    name: '总裁ETF-1440-盘中卖点检查',
    description: '盘中检查 ETF 持仓卖点',
    cronExpr: '40 14 * * 1-5',
    prompt: '盘中检查 ETF 持仓卖点，给出持有/减仓/清仓建议，每条附依据。',
    notifyChannels: ['webui', 'telegram'],
    timeoutSec: 600,
  },
  {
    ...base,
    name: '总裁ETF-1630-次日规划',
    description: '根据收盘数据给出次日开盘操作策略',
    cronExpr: '30 16 * * 1-5',
    prompt:
      '根据当日收盘数据给出次日开盘 ETF 操作策略。约束：每条建议附依据；同板块不重复建仓；高折溢价显式提示风险。',
    notifyChannels: ['webui', 'telegram'],
    timeoutSec: 600,
  },
  {
    ...base,
    name: '真实持仓-1440-卖点检查',
    description: '盘中检查真实持仓卖点（数据源：同花顺账本 → OpenViking 快照）',
    cronExpr: '40 14 * * 1-5',
    prompt:
      '检查用户真实持仓的卖出信号。先用 real_positions 读取真实持仓（含现价、成本、持有/当日盈亏），再对每只标的用 mx_finance_data 补充尾盘量价信号研判是否触发止损/止盈，给出明确操作建议（持有/减仓/清仓）与依据。注意这是真实账户，仅做研判与提醒，不可下单。推送用竖排清单，禁止表格，含现价。',
    notifyChannels: ['webui', 'telegram'],
    timeoutSec: 600,
  },
];

export function seedCronTasksIfEmpty(): void {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(schema.scheduledTasks)
    .get();
  if ((row?.c ?? 0) > 0) return;
  for (const s of SEEDS) createTask(s);
  console.log(`[seed] 已写入 ${SEEDS.length} 个定时任务（默认禁用，配置后到 WebUI 启用）`);
}
