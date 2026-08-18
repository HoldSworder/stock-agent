import type OpenAI from 'openai';
import { miaoxiang, MiaoxiangQuotaError, isTradeRejected } from '../miaoxiang/client';
import { formatPositions, formatBalance, formatOrders } from '../miaoxiang/format';
import {
  MAX_TRADE_REJECTS,
  guardMxTradeParams,
  isTradeRejectCapped,
  noteTradeReject,
} from '../miaoxiang/tradeGuard';
import { sendTelegram } from '../notify/telegram';
import { fetchRealPositions } from '../realPositions';
import { evaluateDiscipline } from '../positions/discipline';
import { syncFavorites } from '../thsFavorites';
import {
  executeSimTrade,
  getStrategy,
  getStrategySnapshot,
  setPositionThesis,
  setTradeReason,
  shanghaiDate,
} from '../strategy/sim';
import { syncMiaoxiangStrategy } from '../strategy/miaoxiangSync';
import { dimensionLabel, proposeSkillUpdate } from '../strategy/skill';
import { assertTradeAllowed, SafetyError } from '../safety/guard';
import { broadcastWatch } from '../watch/bus';
import { nowIso } from '../util';
import * as trendradar from '../trendradar/service';
import * as research from '../research/service';
import { runDecision } from '../decision/service';
import * as plan from '../plan/service';
import { buildPlanContext } from '../plan/context';
import * as etf from '../etf/service';
import * as etfRepo from '../etf/repo';
import * as rotation from '../rotation/service';
import * as screener from '../screener/service';
import * as radar from '../radar/service';
import * as themes from '../themes/service';
import * as symbolMarks from '../symbolMarks/repo';
import * as symbolPlanOrch from '../symbolPlans/orchestrator';

/**
 * 每份上下文的提案被拒次数（含写入时刻，用于 TTL 清扫）。
 * 达到 2 次就降级落观察计划，不让模型无限重试。
 * 上下文本身有 TTL，这里跟着上下文 id 走即可，成功或降级后立即清除；
 * 但模型首拒即放弃时不会走到那两条清除路径，故每次写入顺带清掉过期键，避免条目永久驻留。
 */
const proposalRetries = new Map<string, { tries: number; at: number }>();
/** 提案重试记录的存活上限：略长于上下文缓存 TTL（30 分钟），过期即视为该轮已结束 */
const PROPOSAL_RETRY_TTL_MS = 2 * 60 * 60 * 1000;

/** 写入重试计数，并顺带清扫超过 TTL 的历史条目 */
function setProposalRetries(contextId: string, tries: number): void {
  const now = Date.now();
  for (const [k, v] of proposalRetries) {
    if (now - v.at > PROPOSAL_RETRY_TTL_MS) proposalRetries.delete(k);
  }
  proposalRetries.set(contextId, { tries, at: now });
}
import { formatCandidates, formatTechnicalContext } from '../symbolPlans/format';
import {
  getIndices,
  getGlobalIndices,
  getFutures,
  getEmotion,
  getLadder,
  getTurnoverTotal,
  getSectorMoneyFlow,
  getSectorByChange,
  getQuotes,
  getQuoteWithLimits,
  getStockFundFlow,
} from '../market/eastmoney';
import { getDragonTiger, getFinancialStatements, getLockupAndHolders } from '../market/datacenter';
import { callAkshare } from '../market/akshare';
import { callAstock } from '../astock/client';
import { queryStock as iwencaiQueryStock, queryStockL2 } from '../iwencai/client';
import { buildSentimentOverview, formatForAgent as formatSentiment } from '../sentiment/service';
import { buildMacroOverview, formatMacroForAgent } from '../market/macro';
import { buildUsMapping, formatUsMappingForAgent } from '../market/usMapping';
import { buildDragonOverview, formatDragonForAgent } from '../dragon/service';
import { getAttribution, formatAttributionForAgent } from '../positions/attribution';
import { getStockCapital, formatCapitalForAgent } from '../capital/service';
import { getStockIndicators, formatIndicatorsForAgent } from '../market/indicators';
import { getPriceLevels, formatLevelsForAgent } from '../market/levels';
import { getChipDistribution, formatChipForAgent } from '../market/chip';
import { listReviews } from '../repo';
import type { MarketReviewResult } from '@stock-agent/shared';
import type {
  KlinePeriod,
  MarketStance,
  NewsCatalystInput,
  PlanFocusSector,
  PlanItemStatus,
  PlanTrigger,
  ResearchReportType,
  SkillDimension,
  SymbolMarkKind,
  SymbolMarkPoint,
  SymbolTradePlanProposal,
  ToolAvailability,
  ToolInfo,
} from '@stock-agent/shared';
import { getOverrides } from './toolConfig';

/** K 线标注形态中文名（工具回执文案用） */
const MARK_KIND_LABEL: Record<SymbolMarkKind, string> = {
  price_line: '价位线',
  point: '点位',
  range: '区间',
  trend_line: '趋势线',
};

export interface ToolContext {
  runId: string | null;
  /** 绑定的战法 id：存在时挂载并允许 sim_trade / sim_positions 工具 */
  strategyId?: string | null;
  /** 战法是否启用 Skill 自迭代：存在时挂载 propose_skill_update 工具 */
  skillEnabled?: boolean;
  /** 强制成交：sim_trade 跳过 A 股交易时段校验（如收盘后按收盘价补买） */
  forceTrade?: boolean;
  /** 运行中止信号：透传给网络类工具，abort 后即时中断在飞 fetch（省外部请求与等待） */
  signal?: AbortSignal;
}

export interface ToolDef {
  definition: OpenAI.Chat.Completions.ChatCompletionTool;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

// 妙想日配额耗尽时的工具降级文案：不硬报错，引导模型改走免费源并标注深度指标缺失。
const MX_QUOTA_FALLBACK =
  '妙想今日配额已用尽（使用次数已达上限），本工具今日不可用。请改用免费源完成本次研判：' +
  '量价/涨跌停/换手/量比/成交额/主力净流入用 stock_quotes；DDX/DDY 用 stock_l2_indicators（问财）；' +
  '估值历史分位、北向资金、财务报表等妙想独有的深度指标今日无法获取，请在结论中明确标注该项「数据缺失」，切勿臆造数值。';

/** 解析字符串数组参数（条件清单），过滤非字符串与空串 */
function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

/**
 * 智能截断：超长时保留头部+尾部，中部省略，避免一刀切尾部丢弃关键数据行。
 * 行情/财务/委托数据通常头尾都有关键信息（标题、汇总、最新一条）。
 */
function preview(value: unknown, max = 8000): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.length <= max) return s;
  const headLen = Math.floor(max * 0.7);
  const tailLen = max - headLen;
  const omitted = s.length - max;
  return `${s.slice(0, headLen)}\n...[中部省略 ${omitted} 字符]...\n${s.slice(-tailLen)}`;
}

/** 把 LLM 传入的触发条件对象归一为 PlanTrigger（无效返回 null） */
function asTrigger(v: unknown): PlanTrigger | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const value = typeof o.value === 'number' ? o.value : parseFloat(String(o.value ?? ''));
  if (!Number.isFinite(value)) return null;
  const type = o.type === 'breakout' || o.type === 'pullback' ? o.type : 'price';
  return { type, value, note: typeof o.note === 'string' ? o.note : undefined };
}

/**
 * 把 LLM 传入的大盘研判归一为共享 MarketStance；只有 bias 非法才返回 null。
 *
 * positionPct 不能当「缺了就整份作废」的必填项：marketStance 在工具 schema 里不是
 * required，模型漏填、或给成 "30%"（Number("30%") = NaN）都会让整个对象归零，
 * 而 stance 为 null 时 resolveTimingLevel 返回 undefined、下游 lv 兜底成 'balanced'，
 * 于是 bias='bear' 本该触发的防守档「禁新开多」硬纪律被静默关掉。
 * 丢一个仓位数字，远好过丢掉整份研判连同它的防守闸门。
 */
function asMarketStance(v: unknown): MarketStance | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.bias !== 'bull' && o.bias !== 'bear' && o.bias !== 'neutral') return null;
  const rawPct = typeof o.positionPct === 'number' ? o.positionPct : Number(o.positionPct);
  const timingLevel =
    o.timingLevel === 'attack' ||
    o.timingLevel === 'balanced' ||
    o.timingLevel === 'defense'
      ? o.timingLevel
      : undefined;
  // 取不到仓位时按 bias/timingLevel 给一个保守上限，不能让它变成「无约束」
  const fallbackPct =
    o.bias === 'bear' || timingLevel === 'defense' ? 0 : o.bias === 'bull' ? 50 : 30;
  const positionPct = Number.isFinite(rawPct) ? rawPct : fallbackPct;
  return {
    bias: o.bias,
    ...(timingLevel ? { timingLevel } : {}),
    positionPct: Math.min(Math.max(positionPct, 0), 100),
    support: asString(o.support),
    resistance: asString(o.resistance),
    summary: asString(o.summary),
  };
}

/** 把重点板块列表归一为共享 PlanFocusSector，丢弃缺少必填名称的脏项 */
function asFocusSectors(v: unknown): PlanFocusSector[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const o = item as Record<string, unknown>;
    const name = asString(o.name).trim();
    if (!name) return [];
    return [
      {
        name,
        strength: asString(o.strength),
        reason: asString(o.reason),
      },
    ];
  });
}

/** save_today_plan 中复用的触发条件 JSON schema */
const TRIGGER_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['price', 'breakout', 'pullback'] },
    value: { type: 'number', description: '触发价位（元）' },
    note: { type: 'string' },
  },
  required: ['type', 'value'],
} as const;

export const tools: ToolDef[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'mx_finance_data',
        description:
          '妙想全市场金融数据查询，支持 A股/港股/美股/基金/债券/ETF。用自然语言描述要查的标的与指标，可一次查多只多指标。' +
          '【妙想有日限量，按需省用】：仅用于免费源拿不到的深度数据（估值/财务/份额变化/北向资金等）；' +
          '现价/涨跌/量比/换手/振幅/成交额/涨跌停/主力净流入请走 stock_quotes（免费），DDX/DDY 请走 stock_l2_indicators，不要用本工具查这些免费可得指标。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '自然语言查询语句' } },
          required: ['query'],
        },
      },
    },
    run: async (args, ctx) => {
      try {
        return preview(await miaoxiang.financeData(asString(args.query), ctx.signal));
      } catch (e) {
        if (e instanceof MiaoxiangQuotaError) return preview(MX_QUOTA_FALLBACK);
        throw e;
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'mx_assistant_ask',
        description:
          '妙想金融问答助手（东方财富 robo-advisor，独立新门户）。用自然语言一次提问，返回【已加工好的自然语言答案】（含实时行情/资金面/最新动态/研判与引用来源）。' +
          '适合需要「综合研判型自然语言解读」而非单纯取数的场景（如某股近期资金与动态综述）；deepThink=true 触发深度思考（更慢）。' +
          '【妙想有日限量】：纯量价指标请走 stock_quotes（免费），不要用本工具取价。',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '自然语言问题，可一次问多只股票、多指标' },
            deepThink: { type: 'boolean', description: '是否深度思考（更慢，默认 false）' },
          },
          required: ['question'],
        },
      },
    },
    run: async (args, ctx) => {
      try {
        return preview(
          await miaoxiang.assistantAsk(asString(args.question), {
            deepThink: args.deepThink === true,
            signal: ctx.signal,
          }),
        );
      } catch (e) {
        if (e instanceof MiaoxiangQuotaError) return preview(MX_QUOTA_FALLBACK);
        throw e;
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'mx_screener',
        description: '妙想选股，用自然语言描述选股条件（板块、量价、技术信号、财务等）筛选标的。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '自然语言选股条件' } },
          required: ['query'],
        },
      },
    },
    run: async (args, ctx) => preview(await miaoxiang.screener(asString(args.query), ctx.signal)),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'mx_search',
        description: '妙想金融资讯搜索，查询个股/板块/宏观相关新闻与公告。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    },
    run: async (args, ctx) => preview(await miaoxiang.search(asString(args.query), ctx.signal)),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'mx_self_select',
        description: '自选股管理。action=get 读取自选股；action=manage 用自然语言增删自选股。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['get', 'manage'] },
            query: { type: 'string', description: 'manage 时的自然语言指令' },
          },
          required: ['action'],
        },
      },
    },
    run: async (args, ctx) => {
      const action = asString(args.action, 'get');
      if (action === 'get') return preview(await miaoxiang.selfSelectGet(ctx.signal));
      return preview(await miaoxiang.selfSelectManage(asString(args.query), ctx.signal));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'mx_simulator',
        description:
          '妙想模拟盘查询（返回精简文本）。action=positions 查持仓（已过滤清仓项）；action=balance 查资金；action=orders 查委托（已过滤废单/撤单失败）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['positions', 'balance', 'orders'] },
          },
          required: ['action'],
        },
      },
    },
    run: async (args, ctx) => {
      const action = asString(args.action, 'positions');
      if (action === 'balance') return preview(formatBalance(await miaoxiang.balance(ctx.signal)));
      if (action === 'orders') return preview(formatOrders(await miaoxiang.orders(ctx.signal)));
      return preview(formatPositions(await miaoxiang.positions(ctx.signal)));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'real_positions',
        description:
          '查询用户【真实持仓】（直连同花顺投资账本接口，含现金、实时现价、成本、持有盈亏、今日实时当日盈亏）。真实持仓卖点检查、复盘真实账户时调用。注意：这是真实账户，只读，不可下单。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => {
      const pf = await fetchRealPositions();
      const lines = [
        `数据时间: ${pf.asOf}（来源 ${pf.sourceDate}）`,
        `总资产: ${pf.totalAsset.toFixed(2)} | 现金: ${pf.cash.toFixed(2)} | 持仓市值: ${pf.totalMarketValue.toFixed(2)}`,
        `累计持有盈亏: ${pf.totalHoldProfit.toFixed(2)} | 当日盈亏: ${pf.totalTodayProfit.toFixed(2)}`,
        `持仓 ${pf.positionCount} 只：`,
        ...pf.positions.map(
          (p) =>
            `- ${p.name}(${p.code}) 现价${p.price} 成本${p.avgCost} ${p.qty}股 市值${p.marketValue.toFixed(0)} ` +
            `持有盈亏${p.holdProfit.toFixed(0)}(${(p.holdRate * 100).toFixed(2)}%) ` +
            `当日${p.todayProfit.toFixed(0)}(${(p.todayRate * 100).toFixed(2)}%) 仓位${(p.positionRate * 100).toFixed(1)}%`,
        ),
      ];
      return preview(lines.join('\n'));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'get_position_discipline',
        description:
          '对【真实持仓】做确定性纪律体检（只读，硬规则不经 AI 估算）：逐票判定破止损 / 达止盈 / 临近止损 / 超期持有 / 单票超配，并给账户级总仓位/集中度告警与直白可执行建议。生成今日计划、盘中卖点检查时调用，把破纪律持仓优先纳入计划（减仓/卖出）。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => {
      const rep = await evaluateDiscipline();
      const flagged = rep.items.filter((it) => it.status !== 'healthy');
      const lines = [
        `纪律体检（${rep.asOf}）：止损 ${rep.counts.stopLoss} / 止盈 ${rep.counts.takeProfit} / 超配 ${rep.counts.overweight} / 超期 ${rep.counts.overHold} / 健康 ${rep.counts.healthy}`,
        `阈值：止损 ${rep.config.stopLossPct}% · 止盈 ${rep.config.takeProfitPct}% · 最长持有 ${rep.config.maxHoldDays ?? '不限'} 日 · 单票上限 ${rep.config.singleMaxWeightPct}% · 总仓上限 ${rep.config.totalMaxPositionPct}%`,
        `账户：总仓位 ${(rep.account.totalPositionRate * 100).toFixed(1)}%${rep.account.overTotal ? '（超总仓上限）' : ''} · 现金 ${(rep.account.cashRate * 100).toFixed(1)}%` +
          (rep.account.topConcentration
            ? ` · 最大单一 ${rep.account.topConcentration.name}(${rep.account.topConcentration.code}) ${(rep.account.topConcentration.rate * 100).toFixed(1)}%`
            : ''),
      ];
      if (rep.account.warnings.length) lines.push('账户告警：' + rep.account.warnings.join('；'));
      if (flagged.length) {
        lines.push(`破纪律持仓 ${flagged.length} 只：`);
        for (const it of flagged) {
          lines.push(
            `- ${it.name}(${it.code}) [${it.status}] 现价${it.price} 成本${it.avgCost} ` +
              `盈亏${(it.holdRate * 100).toFixed(2)}% 仓位${(it.positionRate * 100).toFixed(1)}% 持有${it.holdDays}日 → ${it.advice}`,
          );
        }
      } else {
        lines.push('全部持仓纪律健康，无破线项。');
      }
      return preview(lines.join('\n'));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'stock_quotes',
        description:
          '内部实时行情（东方财富 push2→网易自动兜底，无需鉴权、零额度、不受妙想/问财限流）。批量取 A 股 6 位代码的：现价/涨跌幅/昨收/成交额/振幅/换手/量比/涨停价/跌停价/当日主力净流入（东财口径）。' +
          '【量价与资金面的首选数据源】：以上这些免费即可获取的指标一律走本工具，不要用 mx_finance_data（妙想有日限量）。仅 DDX/DDY 等本工具没有的 L2 独有指标才改用 stock_l2_indicators。',
        parameters: {
          type: 'object',
          properties: {
            codes: {
              type: 'array',
              items: { type: 'string' },
              description: 'A 股 6 位代码数组，如 ["002472","002527"]',
            },
          },
          required: ['codes'],
        },
      },
    },
    run: async (args) => {
      const codes = Array.isArray(args.codes)
        ? args.codes.map((c) => String(c).trim()).filter((c) => /^\d{6}$/.test(c))
        : [];
      if (codes.length === 0) return preview('未提供合法的 6 位股票代码');
      const quotes = await getQuotes(codes);
      const byCode = new Map(quotes.map((q) => [q.code, q]));
      // 涨跌停价 + 当日主力净流入 getQuotes 不含，逐只补取（东财 push2，免 MX；持仓只数少，失败不阻断整体）
      const [limits, flows] = await Promise.all([
        Promise.all(codes.map((c) => getQuoteWithLimits(c).catch(() => null))),
        Promise.all(codes.map((c) => getStockFundFlow(c, 1).catch(() => []))),
      ]);
      const limitByCode = new Map(
        limits.filter((l): l is NonNullable<typeof l> => l != null).map((l) => [l.code, l]),
      );
      // 主力净流入取最新一日（fflow daykline 升序，末行为当日），元→亿
      const inflowByCode = new Map(
        codes.map((c, i) => {
          const days = flows[i];
          const last = days.length ? days[days.length - 1] : null;
          return [c, last ? last.main / 1e8 : null] as const;
        }),
      );
      const lines = codes.map((code) => {
        const q = byCode.get(code);
        const lim = limitByCode.get(code);
        if (!q && !lim) return `- ${code} 查无行情`;
        const name = q?.name || lim?.name || '';
        const price = q?.price ?? lim?.price ?? 0;
        const parts = [`- ${name}(${code}) 现价${price}`];
        if (q) {
          parts.push(`涨跌幅${q.pct >= 0 ? '+' : ''}${q.pct}%`);
          parts.push(`昨收${q.prevClose}`);
          parts.push(`成交额${q.amount.toFixed(1)}亿`);
          if (q.amplitude != null) parts.push(`振幅${q.amplitude}%`);
          if (q.turnoverRate != null) parts.push(`换手${q.turnoverRate}%`);
          if (q.volumeRatio != null) parts.push(`量比${q.volumeRatio}`);
        }
        if (lim) parts.push(`涨停${lim.limitUp}`, `跌停${lim.limitDown}`);
        const inflow = inflowByCode.get(code);
        if (inflow != null) parts.push(`主力净流入${inflow >= 0 ? '+' : ''}${inflow.toFixed(2)}亿(东财口径)`);
        return parts.join(' ');
      });
      return preview(lines.join('\n'));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'stock_l2_indicators',
        description:
          'L2 独有指标（DDX 大单动向 / DDY 涨跌动因，基于 Level-2 逐单数据，免费行情接口没有）。批量取 A 股 6 位代码的 DDX/DDY。' +
          '仅当需要 DDX/DDY 这类免费源（stock_quotes）拿不到的 L2 指标时调用；现价/涨跌/量比/换手/振幅/涨跌停/主力净流入请一律走 stock_quotes（免费、无限流）。' +
          '取数：问财（同花顺 L2）优先，限流/不可用时自动回退妙想（东财 L2）；两源 DDX 口径略有差异，阈值按所用源校准。',
        parameters: {
          type: 'object',
          properties: {
            codes: {
              type: 'array',
              items: { type: 'string' },
              description: 'A 股 6 位代码数组，如 ["600519","300750"]',
            },
          },
          required: ['codes'],
        },
      },
    },
    run: async (args, ctx) => {
      const codes = Array.isArray(args.codes)
        ? args.codes.map((c) => String(c).trim()).filter((c) => /^\d{6}$/.test(c))
        : [];
      if (codes.length === 0) return preview('未提供合法的 6 位股票代码');
      // 问财（同花顺 L2）优先
      try {
        const rows = await queryStockL2(codes, ctx.signal);
        if (rows.length && rows.some((r) => r.ddx != null)) {
          const byCode = new Map(rows.map((r) => [r.code, r]));
          const lines = codes.map((code) => {
            const r = byCode.get(code);
            if (!r) return `- ${code} 查无 L2 数据`;
            const parts = [`- ${r.name}(${code})`];
            if (r.ddx != null) parts.push(`DDX ${r.ddx}`);
            if (r.ddy != null) parts.push(`DDY ${r.ddy}`);
            return parts.join(' ');
          });
          return preview(`L2 指标（问财·同花顺口径）：\n${lines.join('\n')}`);
        }
      } catch (e) {
        console.warn('[stock_l2_indicators] 问财失败，回退妙想:', e instanceof Error ? e.message : e);
      }
      // 回退妙想（东财 L2）
      try {
        const names = codes.join('、');
        const text = await miaoxiang.financeData(`${names} 的 DDX 大单动向、DDY 涨跌动因`, ctx.signal);
        return preview(`L2 指标（妙想·东财口径，问财不可用时回退）：\n${text}`);
      } catch (e) {
        return preview(
          `DDX/DDY 取数失败：问财与妙想均不可用（${e instanceof Error ? e.message : String(e)}）。` +
            '可改用 stock_quotes 的量价/主力净流入做卖点研判。',
        );
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'sync_ths_watchlist',
        description:
          '与同花顺自选股同步：拉取同花顺命名自选分组（不含动态/公式分组）与「我的自选」，以同花顺为准调和本地关注列表。返回新增/移除/分组调整数量汇总。用于自选股定时同步任务。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => {
      const r = await syncFavorites();
      const lines = [
        `同步完成：命名分组 ${r.groups} 个`,
        `新增 ${r.added.length} 只${r.added.length ? '：' + r.added.join(',') : ''}`,
        `移除 ${r.removed.length} 只${r.removed.length ? '：' + r.removed.join(',') : ''}`,
        `分组调整 ${r.regrouped} 只`,
        `跳过（查无行情）${r.skipped.length} 只${r.skipped.length ? '：' + r.skipped.join(',') : ''}`,
      ];
      return preview(lines.join('\n'));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'mx_trade',
        description:
          '妙想模拟盘下单。side=buy 买入 / sell 卖出。useMarketPrice=true 市价单（忽略 price）；限价单需提供 price（元，平台自动按板块放大为整数）。' +
          '下单前务必先用 mx_finance_data 校验 6 位代码、现价与涨跌停价，再用 mx_simulator(balance) 确认可用资金/持仓，确保 quantity 为 100 整数倍且不超买超卖。' +
          '务必填写 reason（本次操作原因，便于复盘）与 thesis（该标的当前持有逻辑，如「金属钨价格涨价」）；' +
          '绑定妙想镜像战法时会落库并在同步后回填到成交流水/持仓，不会被同步清空。',
        parameters: {
          type: 'object',
          properties: {
            side: { type: 'string', enum: ['buy', 'sell'] },
            stockCode: { type: 'string', description: '6 位股票代码' },
            quantity: { type: 'number', description: '股数，100 的整数倍' },
            useMarketPrice: { type: 'boolean' },
            price: { type: 'number', description: '限价（元），市价单可省略' },
            reason: { type: 'string', description: '本次操作原因，便于复盘' },
            thesis: {
              type: 'string',
              description: '该标的当前持有逻辑（如「金属钨价格涨价」），跨同步留存于持仓',
            },
          },
          required: ['side', 'stockCode', 'quantity', 'useMarketPrice'],
        },
      },
    },
    run: async (args, ctx) => {
      const side = asString(args.side, 'buy') as 'buy' | 'sell';
      const stockCode = asString(args.stockCode);
      const reason = args.reason ? asString(args.reason) : null;
      const thesis = args.thesis ? asString(args.thesis) : null;
      // 安全守卫：妙想外部模拟盘下单视为自动来源（agent 发起），须开启「自动外部模拟」开关，
      // 且受 kill switch / 交易日 / 时段约束。被拒时返回原因文本供模型据实回复，不抛出。
      try {
        assertTradeAllowed({
          operation: side === 'buy' ? 'external_sim_buy' : 'external_sim_sell',
          source: 'agent',
          forceTrade: ctx.forceTrade ?? false,
        });
      } catch (e) {
        return `下单被安全守卫拒绝：${e instanceof Error ? e.message : String(e)}`;
      }
      // 确定性风控护栏：数量取整 100 倍 / 限价越涨跌停即成修正 / 买入单票超 30% 下调。
      // 涨跌停价走东财免费源（不耗妙想额度），总资产用本地战法快照；取不到则对应校验自动跳过。
      const useMarketPrice = Boolean(args.useMarketPrice);
      const rawPrice = typeof args.price === 'number' ? args.price : undefined;
      let limitUp: number | undefined;
      let limitDown: number | undefined;
      if (!useMarketPrice && rawPrice != null) {
        const q = await getQuoteWithLimits(stockCode).catch(() => null);
        if (q) {
          limitUp = q.limitUp;
          limitDown = q.limitDown;
        }
      }
      let totalAsset: number | undefined;
      let currentPositionValue: number | undefined;
      if (side === 'buy' && ctx.strategyId) {
        const s = getStrategy(ctx.strategyId);
        if (s && s.kind === 'miaoxiang') {
          // 同一次快照里同时取总资产与该标的现有持仓市值：单票 30% 上限必须按
          // 「已持市值 + 本单金额」判定，否则分多次小额买入可累积超配。
          // 取不到时两者都省略（护栏自动退化为只看本单），绝不能填 0 冒充「无持仓」。
          const snap = await getStrategySnapshot(ctx.strategyId).catch(() => null);
          if (snap) {
            totalAsset = snap.totalAsset;
            currentPositionValue = snap.positions.find((p) => p.code === stockCode)?.marketValue;
          }
        }
      }
      const guard = guardMxTradeParams({
        side,
        qty: Number(args.quantity) || 0,
        price: rawPrice,
        useMarketPrice,
        limitUp,
        limitDown,
        totalAsset,
        currentPositionValue,
      });
      if (!guard.ok) {
        return `下单被风控护栏拒绝：${guard.rejectReason}`;
      }
      // 拒单熔断：同一标的同方向在本次运行内已被妙想拒单达上限，直接短路，
      // 避免模型反复微调限价死磕把步数耗尽（历史上会导致整个任务以「超过最大步数」告败）。
      if (isTradeRejectCapped(ctx.runId, side, stockCode)) {
        return (
          `下单已熔断：${stockCode} ${side === 'buy' ? '买入' : '卖出'}在本次运行内已被妙想连续拒单 ${MAX_TRADE_REJECTS} 次，` +
          '不再重试。请停止改价重下（限价/市价都不要再试），把该票标注为「废单，未成交」并写明最后一次拒单原因，继续完成其余标的与报告。'
        );
      }
      const guardNote = guard.notes.length ? `\n（护栏修正：${guard.notes.join('；')}）` : '';
      const body = await miaoxiang.trade({
        type: side,
        stockCode,
        quantity: guard.qty,
        useMarketPrice,
        price: guard.price,
      });
      const result = preview(body) + guardNote;
      // 业务拒单（如 T+1 当日买入不可卖）：原样返回拒单响应体供模型据实回复，
      // 不记录操作原因、不回同步（本次没有成交，避免登记幽灵成交/误报「已同步」）。
      if (isTradeRejected(body)) {
        const n = noteTradeReject(ctx.runId, side, stockCode);
        const left = MAX_TRADE_REJECTS - n;
        return (
          result +
          (left > 0
            ? `\n（该票本次运行已被拒单 ${n} 次，最多再试 ${left} 次；请核对可卖数量/价格后一次改对，勿逐分微调）`
            : '\n（该票本次运行已被拒单达上限，后续下单将被熔断。请标注「废单，未成交」并继续完成报告）')
        );
      }
      // code=200 只代表委托已受理：挂单未成交(status=2)、废单(status=9) 都会返回 200，
      // 提醒模型别把受理当成交（历史上因价格量纲错导致的废单被当成「已清仓」写进报告）。
      const accepted =
        result + '\n（code=200 仅表示委托已受理，是否成交请以 mx_simulator(orders/positions) 为准，勿直接断言已成交）';
      // 双写：若当前运行绑定的是妙想镜像战法，落库操作原因/持有逻辑，再成交后回拉同步本地账户
      if (ctx.strategyId) {
        const s = getStrategy(ctx.strategyId);
        if (s && s.kind === 'miaoxiang') {
          // 操作原因兜底：按今日成交日落库，同步重插成交时回填（避免被覆盖清空）
          setTradeReason(ctx.strategyId, stockCode, side, shanghaiDate(), reason);
          if (thesis != null) setPositionThesis(ctx.strategyId, stockCode, thesis);
          try {
            await syncMiaoxiangStrategy(ctx.strategyId);
            return `${accepted}\n（已同步妙想模拟盘到本地战法账户${reason ? `，操作原因：${reason}` : ''}${thesis ? `，持有逻辑：${thesis}` : ''}）`;
          } catch (e) {
            return `${accepted}\n（妙想模拟盘回同步失败：${e instanceof Error ? e.message : e}）`;
          }
        }
      }
      return accepted;
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'mx_cancel',
        description: '妙想模拟盘撤单。all=true 一键全撤；否则提供 orderId 与 stockCode 撤单。',
        parameters: {
          type: 'object',
          properties: {
            all: { type: 'boolean' },
            orderId: { type: 'string' },
            stockCode: { type: 'string' },
          },
        },
      },
    },
    run: async (args) =>
      preview(
        await miaoxiang.cancel({
          all: Boolean(args.all),
          orderId: args.orderId ? asString(args.orderId) : undefined,
          stockCode: args.stockCode ? asString(args.stockCode) : undefined,
        }),
      ),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'trendradar_hotspots',
        description:
          '全网热点情报（TrendRadar：今日头条/百度/微博/知乎/财联社/36氪等多平台热榜 + RSS）。' +
          'action=trending 取高频热点话题；action=news 取最新热榜新闻；action=search 按关键词搜新闻（需 query）；' +
          'action=summary 由本系统 LLM 基于当日热榜/新闻/RSS 现场研判出热点摘要。复盘/选股时用它补充消息面、捕捉题材风口。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['trending', 'news', 'search', 'summary'] },
            query: { type: 'string', description: 'action=search 时的搜索关键词' },
            limit: {
              type: 'number',
              description: '返回条数，默认 trending=15 / news=40 / search=30',
            },
          },
          required: ['action'],
        },
      },
    },
    run: async (args) => {
      const action = asString(args.action, 'trending');
      const limit = Number(args.limit) || 0;
      if (action === 'news') {
        const list = await trendradar.latestNews(limit || 40);
        return preview(
          list.map((n) => `[${n.platformName}] ${n.title}`).join('\n') || '暂无新闻数据',
        );
      }
      if (action === 'search') {
        const q = asString(args.query);
        if (!q) return '请提供 query 搜索关键词';
        const list = await trendradar.searchNews(q, limit || 30);
        return preview(
          list.map((n) => `[${n.platformName || n.platform}] ${n.title}`).join('\n') ||
            `未搜到与「${q}」相关的新闻`,
        );
      }
      if (action === 'summary') {
        const r = await trendradar.summaryReport('daily');
        return preview(r.content || '暂无摘要报告');
      }
      const topics = await trendradar.trending(limit || 15);
      return preview(
        topics
          .map(
            (t) =>
              `${t.keyword}（热度${t.frequency}/命中${t.matchedNews}${
                t.trend && t.trend !== 'stable' ? '/' + t.trend : ''
              }）`,
          )
          .join('\n') || '暂无热点话题',
      );
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'research_reports',
        description:
          '券商研报查询（东方财富研报中心：个股/行业/策略/宏观/券商晨报，含机构评级、评级变动、目标价、EPS·PE 预测）。' +
          'action=list 取研报清单（type 必填，stock 时可带 code 个股代码，industry 时可带 industry 行业代码，可带 rating 评级、days 近N天）；' +
          'action=content 取单篇研报正文（需 encodeUrl，从 list 结果取）；' +
          'action=discover 取近一日五类研报（个股/行业/策略/宏观/晨报）聚合摘要（板块热度聚类、评级上调清单、各类正文样本，窗口按运行日自动覆盖含当日晨报），摘要末尾含近几次研报机会对比区块与【候选重大公告标题】（含 art_code）；' +
          'action=ann_content 按 art_code 抓取选中公告正文（codes 传 art_code 数组，≤20）。' +
          '复盘/选股时用它补充机构观点与一致预期。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'content', 'discover', 'ann_content'] },
            type: {
              type: 'string',
              enum: ['stock', 'industry', 'strategy', 'macro', 'morning'],
              description: '研报类型，默认 stock',
            },
            code: { type: 'string', description: 'action=list 且 type=stock 时的 6 位个股代码' },
            industry: { type: 'string', description: 'action=list 且 type=industry 时的行业代码' },
            rating: { type: 'string', description: '评级过滤，如 买入' },
            days: { type: 'number', description: '近 N 天；action=discover 不传则按运行日自动取窗' },
            encodeUrl: { type: 'string', description: 'action=content 时的研报详情码' },
            codes: {
              type: 'array',
              items: { type: 'string' },
              description: 'action=ann_content 时的公告 art_code 数组（≤20，从 discover 候选公告标题中取）',
            },
          },
          required: ['action'],
        },
      },
    },
    run: async (args) => {
      const action = asString(args.action, 'list');
      const type = (asString(args.type, 'stock') as ResearchReportType) || 'stock';
      if (action === 'discover') {
        const days = args.days != null ? Number(args.days) : undefined;
        const [agg, ann] = await Promise.all([
          research.aggregateDailyReports(days),
          research.collectAnnouncementCandidates(days),
        ]);
        const digest = research.formatDiscoverDigest(agg);
        const history = research.formatRecentOpportunityHistory();
        const annTitles = research.formatAnnouncementTitles(ann.candidates);
        // 候选集不完整必须如实告知模型：否则它会把「翻页失败少拉了几百条」当成「今日就这些公告」
        const annNote = ann.partial
          ? '⚠️ 公告翻页部分失败，候选集不完整，勿据此断言「无重大公告」。'
          : '';
        const parts = [digest, history, annTitles, annNote].filter(Boolean);
        return preview(parts.join('\n\n'), 20000);
      }
      if (action === 'ann_content') {
        const codes = Array.isArray(args.codes)
          ? (args.codes as unknown[]).map((c) => asString(c)).filter(Boolean)
          : asString(args.codes)
              .split(',')
              .map((c) => c.trim())
              .filter(Boolean);
        if (!codes.length) return '请提供 codes（公告 art_code 数组，从 discover 候选公告标题中取）';
        return preview(await research.fetchAnnouncementContents(codes), 12000);
      }
      if (action === 'content') {
        const encodeUrl = asString(args.encodeUrl);
        if (!encodeUrl) return '请提供 encodeUrl（从 research_reports list 结果中获取）';
        const d = await research.reportContent(type, encodeUrl);
        return preview(d.text || `未能抽取正文，原文见：${d.detailUrl}`, 9000);
      }
      const reports = await research.listReports({
        type,
        code: args.code ? asString(args.code) : undefined,
        industry: args.industry ? asString(args.industry) : undefined,
        rating: args.rating ? asString(args.rating) : undefined,
        days: Number(args.days) || 30,
        pageSize: 30,
      });
      if (!reports.length) return '未查到符合条件的研报';
      return preview(
        reports
          .map((r) => {
            const tp = r.targetPriceHigh ?? r.targetPriceLow;
            const parts = [
              `${r.publishDate} [${r.orgName}]`,
              r.stockName ? `${r.stockName}(${r.stockCode})` : r.industryName,
              r.title,
            ].filter(Boolean);
            const tail = [
              r.rating ? `评级${r.rating}` : '',
              r.ratingChange || '',
              tp != null ? `目标价${tp}` : '',
              r.epsThisYear != null ? `EPS(本年)${r.epsThisYear}` : '',
              `code=${r.encodeUrl}`,
            ].filter(Boolean);
            return `${parts.join(' ')}｜${tail.join(' ')}`;
          })
          .join('\n'),
      );
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'eastmoney_datacenter',
        description:
          '东方财富结构化数据（免鉴权、直连）：A 股资金面与基本面证据。' +
          'action=dragon_tiger 取个股近期龙虎榜上榜明细（上榜日/涨跌幅/净买入/换手/上榜原因，游资资金动向）；' +
          'action=lockup 取限售解禁安排 + 大股东增减持 + 股权质押概况（A 股特有供给冲击/抛压）；' +
          'action=statements 取财报主表（营收/归母净利/毛利/EPS/BPS/每股经营现金流/ROE 及同比，含近几期趋势）。' +
          '复盘/选股/研判时用它补充结构化的资金面与基本面，需传 6 位个股代码 code。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['dragon_tiger', 'lockup', 'statements'] },
            code: { type: 'string', description: '6 位个股代码' },
          },
          required: ['action', 'code'],
        },
      },
    },
    run: async (args) => {
      const code = asString(args.code).trim();
      if (!/^\d{6}$/.test(code)) return '请提供 6 位个股代码 code';
      const action = asString(args.action, 'dragon_tiger');
      if (action === 'lockup') return preview(await getLockupAndHolders(code), 6000);
      if (action === 'statements') return preview(await getFinancialStatements(code), 6000);
      return preview(await getDragonTiger(code, 8), 6000);
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'decision_debate',
        description:
          '多智能体辩论决策引擎：对单只标的跑「五大分析师并行研判→多空辩论→风控博弈→组合经理裁决」完整流水线，' +
          '产出 买入/加仓/持有/减仓/卖出 的最终操作建议（含置信度、目标价、止损价、建议仓位、核心逻辑与关键风险）。' +
          '需要对某只股票做深度操作研判、给出明确「该如何操作」结论时调用；内部已自动取齐行情/研报/大盘/消息/持仓，无需先行取数。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '6 位股票代码' },
            name: { type: 'string', description: '标的名称（可选，缺省自动解析）' },
            context: { type: 'string', description: '调用场景说明（可选，如「真实持仓卖点检查」），影响决策侧重' },
          },
          required: ['code'],
        },
      },
    },
    run: async (args, ctx) => {
      const code = asString(args.code);
      if (!/^\d{6}$/.test(code)) return '请提供合法的 6 位股票代码';
      const r = await runDecision(
        {
          code,
          name: args.name ? asString(args.name) : undefined,
          context: args.context ? asString(args.context) : undefined,
        },
        { signal: ctx.signal, purpose: 'decision' },
      );
      return preview(r.narrative, 10000);
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'notify_telegram',
        description:
          '把结果推送到 Telegram。禁止使用 Markdown 表格，用竖排清单/卡片格式。尾盘选股类必须包含现价。',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    },
    run: async (args) => {
      const r = await sendTelegram(asString(args.text));
      return r.message;
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'market_snapshot',
        description:
          '一次性读取 A 股大盘快照（东方财富，无需鉴权）：A 股主要指数点位/涨跌幅、外围关键指数（美股道指/纳指/标普、亚太恒生/日经/韩国、美元指数/离岸人民币/富时A50）、期货价格（国内有色/黑色/贵金属/能化/新能源主力连续 + 外盘商品，用于商品涨价对相关产业链标的的传导判断）、两市成交额、市场情绪温度（涨跌停/炸板率/最高连板）、涨停板梯队、板块主力资金净流入/净流出 TOP、领涨/领跌板块，以及宏观·资金面底稿（股指期货基差 IF/IH/IC/IM、SHIBOR 资金面、最近降准、两融融资余额趋势、南向资金、沪深300估值分位，均为环境背景与护栏，非择时信号），以及美股映射底稿（隔夜美股行业/主题 ETF 排名 → A股概念/ETF 桥接，盘前情绪与方向背景，需结合真实A股板块强弱印证，非择时信号）。盘前定调、盘中看大盘、生成今日计划判断大环境趋势时调用。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => {
      const safe = async <T>(p: Promise<T>, fb: T): Promise<T> => {
        try {
          return await p;
        } catch {
          return fb;
        }
      };
      const [
        globalIndices,
        futures,
        indices,
        turnover,
        emotion,
        ladder,
        inflow,
        outflow,
        gainSec,
        loseSec,
      ] = await Promise.all([
        safe(getGlobalIndices(), []),
        safe(getFutures(), []),
        safe(getIndices(), []),
        safe(getTurnoverTotal(), null),
        safe(getEmotion(), null),
        safe(getLadder(), []),
        safe(getSectorMoneyFlow('inflow', 8), []),
        safe(getSectorMoneyFlow('outflow', 8), []),
        safe(getSectorByChange('gainers', 8), []),
        safe(getSectorByChange('losers', 8), []),
      ]);
      const lines: string[] = [];
      if (indices.length)
        lines.push(
          '指数：' +
            indices.map((i) => `${i.name} ${i.point}(${i.pct >= 0 ? '+' : ''}${i.pct}%)`).join('  '),
        );
      if (globalIndices.length)
        lines.push(
          '外围：' +
            globalIndices
              .map((i) => `${i.name} ${i.point}(${i.pct >= 0 ? '+' : ''}${i.pct}%)`)
              .join('  '),
        );
      if (futures.length)
        lines.push(
          '期货：' +
            futures
              .map((f) => `${f.name} ${f.price}(${f.pct >= 0 ? '+' : ''}${f.pct}%)`)
              .join('  '),
        );
      if (turnover)
        lines.push(
          `两市成交额：${turnover.total.toFixed(0)} 亿` +
            (turnover.chgPct != null ? `（较昨 ${turnover.chgPct >= 0 ? '+' : ''}${turnover.chgPct.toFixed(1)}%）` : ''),
        );
      if (emotion)
        lines.push(
          `情绪：涨停 ${emotion.limitUp} / 跌停 ${emotion.limitDown} / 炸板 ${emotion.brokenBoard}（炸板率 ${emotion.brokenRate.toFixed(1)}%）最高 ${emotion.maxStreak} 连板`,
        );
      if (ladder.length)
        lines.push(
          '涨停梯队：' + ladder.map((t) => `${t.streak}板×${t.count}`).join(' '),
        );
      if (inflow.length)
        lines.push(
          '板块主力净流入TOP：' +
            inflow.map((s) => `${s.name}(+${s.netInflow.toFixed(1)}亿,${s.pct}%)`).join('  '),
        );
      if (outflow.length)
        lines.push(
          '板块主力净流出TOP：' +
            outflow.map((s) => `${s.name}(${s.netInflow.toFixed(1)}亿,${s.pct}%)`).join('  '),
        );
      if (gainSec.length)
        lines.push('领涨板块：' + gainSec.map((s) => `${s.name}(${s.pct}%)`).join('  '));
      if (loseSec.length)
        lines.push('领跌板块：' + loseSec.map((s) => `${s.name}(${s.pct}%)`).join('  '));
      // 宏观·资金面底稿（基差/SHIBOR/降准/两融/南向/估值分位）：best-effort，失败则不追加
      try {
        const macro = await buildMacroOverview();
        const macroText = formatMacroForAgent(macro);
        if (macroText) lines.push('', macroText);
      } catch {
        /* 宏观取数失败：快照退回不含宏观底稿 */
      }
      // 美股映射底稿（隔夜美股龙头/行业 → A股概念·ETF·个股）：best-effort，失败则不追加
      try {
        const usMap = await buildUsMapping();
        if (usMap) {
          const usText = formatUsMappingForAgent(usMap);
          if (usText) lines.push('', usText);
        }
      } catch {
        /* 美股映射取数失败：快照退回不含映射底稿 */
      }
      return preview(lines.join('\n') || '暂无大盘数据');
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'market_sentiment',
        description:
          '读取 A 股市场情绪周期（S1 短线择时总开关）：确定性合成的 0-100 情绪指数 + 水位档位（冰点/低迷/平稳/活跃/高潮）+ 周期阶段（冰点/恢复/高潮/退潮/震荡）+ 较上一交易日方向 + 白话仓位倾向，附构成拆解（赚钱效应广度/活跃度/涨停强度/连板高度/炸板率/跌停恐慌）。判断「敢不敢做、做多大仓」、短线择时、生成今日计划与复盘定调时调用。数据源乐咕乐股活跃度 + 东财涨停池，纯规则、不含主观预测。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => {
      const ov = await buildSentimentOverview();
      return formatSentiment(ov);
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'dragon_ladder',
        description:
          '读取 A 股当日连板梯队与龙头辨识（S6 龙头战法）：按连板天数分组的涨停梯队 + 每只个股的「龙头分」（连板高度+封板时间+封单额+换手率规则化合成）+ 总龙头/中军/弹性角色分层。判断「谁是这波题材的总龙头/能不能跟、梯队是否健康（高度+数量）」、做短线龙头/动能套利、生成今日计划与复盘定调时调用。数据源东财涨停池，纯规则、不含主观预测。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => {
      const ov = await buildDragonOverview();
      return preview(formatDragonForAgent(ov));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'stock_capital',
        description:
          '个股龙虎榜资金面深挖（S7 资金面）：近 N 次上榜「净额趋势」（净买入/换手/上榜原因，东财）+ 最近一次「席位拆分」（买方/卖方前 5 席位 + 游资/机构/北向席位辨识，akshare）。回答「谁在买谁在卖、是游资接力还是机构出货、资金是否持续流入」时调用，做游资跟随/龙头研判/卖点检查的关键资金证据。需传 6 位个股代码 code。',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string', description: '6 位个股代码' } },
          required: ['code'],
        },
      },
    },
    run: async (args) => {
      const code = asString(args.code).trim();
      if (!/^\d{6}$/.test(code)) return '请提供 6 位个股代码 code';
      return preview(formatCapitalForAgent(await getStockCapital(code)));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'stock_indicators',
        description:
          '个股技术指标库（S9）：基于东财日线用 trading-signals 计算 MACD(12,26,9)/KDJ(9,3,3)/RSI(6,12,24)/BOLL(20,2) 并给规则化读数（金叉/死叉、超买/超卖、布林带位置）。判断技术买卖点、指标共振/背离、超买超卖时调用。纯确定性算法，不含主观预测。需传 6 位个股代码 code。',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string', description: '6 位个股代码' } },
          required: ['code'],
        },
      },
    },
    run: async (args) => {
      const code = asString(args.code).trim();
      if (!/^\d{6}$/.test(code)) return '请提供 6 位个股代码 code';
      return preview(formatIndicatorsForAgent(await getStockIndicators(code)));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'price_levels',
        description:
          '点位测算库（S10）：从 K 线用确定性算法给「专业点位」——主导波段（摆动高低点）、斐波那契回撤(23.6/38.2/50/61.8/78.6%)与扩展(127.2/161.8%)目标位、ATR(14) 波动率、经典枢轴点(PP/R1-3/S1-3)、多周期均线结构(MA5-250 排列 + 最近支撑/压力均线)。判断关键支撑/压力、买卖点区间、止损/目标位、多空排列时调用（个股研判、板块/大盘走势预测均适用）。纯确定性算法，不含主观预测。支持个股(6位 code)/行业概念板块(BKxxxx code)/大盘指数(显式 secid，如 1.000001 上证)；可选 period（day 看短期、week 看中长期，缺省 day）。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '6 位个股代码，或 BKxxxx 板块代码（大盘指数留空、改传 secid）' },
            secid: { type: 'string', description: '大盘指数 secid（市场前缀.代码，如上证 1.000001、创业板 0.399006）；传了 secid 可不传 code' },
            period: { type: 'string', description: 'K 线周期：day(默认，看短期) / week(看中长期) / month', enum: ['day', 'week', 'month'] },
          },
        },
      },
    },
    run: async (args) => {
      const code = asString(args.code).trim();
      const secid = asString(args.secid).trim() || undefined;
      const period = (asString(args.period).trim() || 'day') as KlinePeriod;
      if (!secid && !/^(?:\d{6}|BK\d+)$/i.test(code)) {
        return '请提供 6 位个股代码 / BKxxxx 板块代码 code，或大盘指数 secid';
      }
      return preview(formatLevelsForAgent(await getPriceLevels(code, period, secid)));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'stock_chips',
        description:
          '个股筹码分布（S8，东财）：获利比例（套牢盘轻重）、平均成本、70%/90% 成本区间与集中度（锁筹/派发），及近 N 日趋势。判断「上方套牢压力、主力成本、筹码是否集中（吸筹）还是发散（派发）、突破前是否充分换手」时调用。需传 6 位个股代码 code。',
        parameters: {
          type: 'object',
          properties: { code: { type: 'string', description: '6 位个股代码' } },
          required: ['code'],
        },
      },
    },
    run: async (args) => {
      const code = asString(args.code).trim();
      if (!/^\d{6}$/.test(code)) return '请提供 6 位个股代码 code';
      return preview(formatChipForAgent(await getChipDistribution(code)));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'get_attribution',
        description:
          '读取真实账户【当日持仓归因】（确定性只读，收盘后落库）：账户当日盈亏额/对账户贡献，当日最大赢家/最大输家，以及逐票「当日盈亏贡献」（当日盈亏率×仓位权重，按绝对值倒序）。回答「今天账户是谁在贡献/谁在拖累、哪只票拉低了组合」、做收盘复盘归因时调用。无参数，默认取最近一个交易日。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => preview(formatAttributionForAgent(getAttribution())),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'get_plan_context',
        description:
          '一次性读取五源【最新一次持久化的 AI 分析】，作为生成今日计划的基准：①情报研判（研报机会 + 全网热点 合并）②大盘与板块研判（大盘复盘 + 板块主线 + 期货外盘 合并）③一键复盘（综合方向/外围/主线/次日策略）④ETF 综合研判（操作信号 + 中线赛道轮动 合并）⑤上一计划收盘复盘（含次日预案草稿，闭环反哺）。另附⑥【板块新高宽度·最新】确定性底稿（板块内创新高个股数横向排名 + 确认主线 + 居首天数，规则只读非 AI 估算）＝主线的确定性硬证据。各源缺失或非当日产出会显式标注时效。盘前生成今日计划时优先调用它取基准，不要再现场重跑情报 / 大盘板块 / ETF 研判。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => preview(await buildPlanContext(), 12000),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'get_latest_review_stance',
        description:
          '读取上一次深度复盘（一键复盘）的核心结论，作为生成今日计划的大环境趋势基准与候选池来源。返回：综合方向(偏多/中性/偏空)+定调+关键驱动、外围市场对 A 股影响、明日策略(重点关注/应对预案/仓位建议)、当前主线题材、妙想强势板块/个股、值得关注的自选股、风险清单。无历史复盘时返回提示。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => {
      const prev = listReviews(3).find((r) => r.outputText);
      if (!prev?.outputText) return '暂无历史复盘可参考（首次或尚未生成深度复盘）。';
      let obj: Partial<MarketReviewResult> | null = null;
      try {
        const s = prev.outputText;
        const start = s.indexOf('{');
        const end = s.lastIndexOf('}');
        if (start !== -1 && end > start) {
          obj = JSON.parse(s.slice(start, end + 1)) as Partial<MarketReviewResult>;
        }
      } catch {
        obj = null;
      }
      if (!obj) return `上一复盘（${prev.createdAt}）解析失败，无法提取综合判断。`;
      const lines: string[] = [`上一复盘（${prev.createdAt}）核心结论：`];
      const cs = obj.comprehensiveStance;
      if (cs) {
        lines.push(`方向：${cs.bias} —— ${cs.summary ?? ''}`);
        if (cs.drivers?.length) lines.push('驱动：' + cs.drivers.join('；'));
      } else {
        lines.push('（上一复盘未产出结构化综合判断）');
      }
      if (obj.overseasMarkets?.length) {
        lines.push(
          '外围：' +
            obj.overseasMarkets
              .map((o) => `${o.name}(${o.region}) ${o.trend}→${o.impact}`)
              .join('  '),
        );
      }
      const tp = obj.tomorrowPlan;
      if (tp) {
        if (tp.focus?.length) lines.push('明日重点：' + tp.focus.join('；'));
        if (tp.contingency?.length) lines.push('应对预案：' + tp.contingency.join('；'));
        if (tp.positionAdvice) lines.push(`仓位建议：${tp.positionAdvice}`);
      }
      if (obj.mainThemes?.length) {
        lines.push(
          '主线题材：' +
            obj.mainThemes.map((t) => `${t.name}(${t.strength})`).join('、'),
        );
      }
      if (obj.strongSectors?.length) {
        lines.push(
          '强势板块候选：' +
            obj.strongSectors.map((s) => s.name + (s.leader ? `(领涨${s.leader})` : '')).join('、'),
        );
      }
      if (obj.strongStocks?.length) {
        lines.push(
          '强势个股候选：' +
            obj.strongStocks.map((s) => `${s.name}(${s.code})`).join('、'),
        );
      }
      if (obj.watchlistReview?.length) {
        lines.push(
          '值得关注自选：' +
            obj.watchlistReview.map((w) => `${w.name}(${w.code})·${w.strength}`).join('、'),
        );
      }
      if (obj.risks?.length) {
        lines.push('风险清单：' + obj.risks.map((r) => r.title).join('；'));
      }
      return preview(lines.join('\n'));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'etf_signals',
        description:
          'ETF 跟踪池确定性买卖信号（本系统基于东方财富行情/历史 K 线本地计算）：每只 ETF 的估值位置分位、年线偏离、折溢价(IOPV)、双动量轮动打分与排名、波动率、网格水位，以及综合操作建议(买入/加仓/持有/减仓/规避)与结构化触发价(买/卖/损/盈)。' +
          'action=signals 取全池信号（默认）；action=pool 仅列跟踪池标的。生成今日计划、ETF 盘前规划/盘中卖点检查时调用，作为 ETF 决策的量化底座；折溢价缺失项可用 mx_finance_data 补。',
        parameters: {
          type: 'object',
          properties: { action: { type: 'string', enum: ['signals', 'pool'] } },
        },
      },
    },
    run: async (args) => {
      const action = asString(args.action, 'signals');
      if (action === 'pool') {
        const pool = etfRepo.listPool();
        if (!pool.length) return 'ETF 跟踪池为空，请先在 ETF 页添加标的。';
        return preview(
          pool.map((p) => `${p.name}(${p.code})${p.tags ? ` [${p.tags}]` : ''}`).join('\n'),
        );
      }
      return preview(etf.formatForAgent(await etf.signals()), 12000);
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'etf_rotation_strength',
        description:
          'ETF 行业轮动确定性榜（本系统基于东方财富行情/历史 K 线本地计算）：对「跟踪池 + 主题赛道代表 ETF」算' +
          '相对沪深300强弱(RS)、20/60/120 日动量、周线均线趋势、主力净流入与综合轮动强度，并按确定性规则给出' +
          '5 态（上升/回踩/加速/过热/破位）。做「ETF行业轮动研判」「今日计划的中线赛道基准」时调用，' +
          '据此判断该进攻(上升/加速且RS强)、该等回踩(回踩态)、该回避(过热/破位)的赛道。涨幅靠后≠该卖、过热≠还能涨。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => preview(rotation.formatForAgent(await rotation.buildRotationOverview()), 12000),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'save_today_plan',
        description:
          '保存今日【作战计划】（盘前生成任务调用，一天一份，重复调用覆盖当日计划）。把研报/热点/板块/选股/持仓/大盘综合成结构化计划落库，供盘中盯盘程序化对照与前端作战室展示。务必给 marketStance.timingLevel 择时档位（防守档新开仓 buy 会被后端自动降级为 watch）；每只标的务必给 confidence 置信度(0-100) 与 source 来源（screen_stocks 选出的标 screener）；触发价务必基于已校验的真实价位；尽量给每只标的右侧确认条件 confirmConditions 与逻辑失效条件 invalidConditions。看好 ETF(direction=buy/hold) 必给今日操作建议：持有类必给 positionHint 持仓比例，建仓类必给 buyTrigger 建议点位，缺则降级 watch。ETF 为本计划主体：建仓候选取自 etf_signals 跟踪池；real_positions 中的每一只持仓 ETF 都必须出现并给 hold/add/reduce/sell 操作 + positionHint + stopLoss/takeProfit，不得遗漏。',
        parameters: {
          type: 'object',
          properties: {
            marketStance: {
              type: 'object',
              description: '大盘研判',
              properties: {
                bias: { type: 'string', enum: ['bull', 'bear', 'neutral'] },
                timingLevel: {
                  type: 'string',
                  enum: ['attack', 'balanced', 'defense'],
                  description:
                    '今日择时档位（前提闸门）：attack 进攻可正常 buy / balanced 均衡精选 / defense 防守禁新开多。防守档新开仓 buy 会被后端自动降级为 watch。',
                },
                positionPct: { type: 'number', description: '建议仓位 %（0-100，须与择时档位一致）' },
                support: { type: 'string', description: '关键支撑位' },
                resistance: { type: 'string', description: '关键压力位' },
                summary: { type: 'string', description: '一句话定调（含择时档位与理由）' },
              },
            },
            focusSectors: {
              type: 'array',
              description: '今日重点板块',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  strength: { type: 'string', description: '强度阶段：主线/启动/分歧/退潮' },
                  reason: { type: 'string' },
                },
                required: ['name'],
              },
            },
            externalContext: { type: 'string', description: '隔夜外围与政策要点' },
            keyRisks: {
              type: 'array',
              items: { type: 'string' },
              description:
                '今日风险清单（3-5 条短句，依次覆盖：大盘失守位/缩量风险、主线退潮或分歧信号、个股共性风险、隔夜外盘隐患；每条可盘中对照）',
            },
            intradayGuide: {
              type: 'object',
              description: '盘中分时作战指引（四段各一句话，结合今日档位给具体动作，无可说的段可省略）',
              properties: {
                auction: { type: 'string', description: '集合竞价 9:15-9:25 看高开/低开与外盘映射如何应对' },
                morning: { type: 'string', description: '早盘 9:30-11:30 看主线分歧与承接' },
                midday: { type: 'string', description: '午盘 13:00-14:30 看持续性与量能' },
                tail: { type: 'string', description: '尾盘 14:30-15:00 看资金回流/获利了结' },
              },
            },
            narrative: { type: 'string', description: '完整作战图（Markdown，供人阅读与推送）' },
            items: {
              type: 'array',
              description: '计划标的列表',
              items: {
                type: 'object',
                properties: {
                  code: { type: 'string', description: '6 位代码' },
                  name: { type: 'string' },
                  assetType: {
                    type: 'string',
                    enum: ['stock', 'etf'],
                    description: '资产类型：个股 stock / ETF etf。不传则后端按代码前缀自动判定（1/5 开头为 ETF）',
                  },
                  direction: {
                    type: 'string',
                    enum: ['buy', 'hold', 'reduce', 'sell', 'watch'],
                  },
                  thesis: { type: 'string', description: '操作逻辑' },
                  source: {
                    type: 'string',
                    enum: ['research', 'hotspot', 'sector', 'screener', 'position', 'watchlist', 'other'],
                    description:
                      '线索来源（体现串联）：来自 screen_stocks 选股引擎的个股标 screener；研报 research / 热点 hotspot / 板块 sector / 持仓 position / 自选 watchlist。',
                  },
                  confidence: {
                    type: 'number',
                    description:
                      '综合置信度 0-100：据短线四要素/右侧确认强度/辩论结论打分。仅高置信度才宜 buy，中等宜 watch+确认条件。',
                  },
                  positionHint: { type: 'string', description: '建议仓位，如 20%' },
                  confirmConditions: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      '右侧确认条件（个股放量突破平台/创阶段新高确认、ETF 回踩不破均线后再放量转强等），盘中据此判断是否真正介入',
                  },
                  invalidConditions: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      '逻辑失效条件（满足则当天取消/降级，如大盘跌破支撑且缩量、板块跌出资金流入榜、个股跌破昨高或平台下沿），供盘中纠偏与收盘复盘对照',
                  },
                  priority: { type: 'number', description: '优先级（越大越靠前）' },
                  buyTrigger: TRIGGER_SCHEMA,
                  sellTrigger: TRIGGER_SCHEMA,
                  stopLoss: TRIGGER_SCHEMA,
                  takeProfit: TRIGGER_SCHEMA,
                },
                required: ['code', 'name', 'direction'],
              },
            },
          },
        },
      },
    },
    run: async (args, ctx) => {
      const rawItems = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : [];
      const items = rawItems
        .filter((it) => asString(it.code))
        .map((it) => ({
          code: asString(it.code),
          name: asString(it.name, asString(it.code)),
          assetType:
            it.assetType === 'etf' || it.assetType === 'stock'
              ? (it.assetType as 'stock' | 'etf')
              : undefined,
          direction: asString(it.direction, 'watch') as 'buy' | 'hold' | 'reduce' | 'sell' | 'watch',
          thesis: asString(it.thesis),
          source: asString(it.source, 'other') as
            | 'research'
            | 'hotspot'
            | 'sector'
            | 'screener'
            | 'position'
            | 'watchlist'
            | 'other',
          confidence:
            typeof it.confidence === 'number'
              ? Math.min(Math.max(Math.round(it.confidence), 0), 100)
              : null,
          positionHint: asString(it.positionHint),
          confirmConditions: asStringArray(it.confirmConditions),
          invalidConditions: asStringArray(it.invalidConditions),
          priority: typeof it.priority === 'number' ? it.priority : 0,
          buyTrigger: asTrigger(it.buyTrigger),
          sellTrigger: asTrigger(it.sellTrigger),
          stopLoss: asTrigger(it.stopLoss),
          takeProfit: asTrigger(it.takeProfit),
        }));
      const rawGuide =
        args.intradayGuide && typeof args.intradayGuide === 'object'
          ? (args.intradayGuide as Record<string, unknown>)
          : null;
      const guide = rawGuide
        ? (() => {
            const g: Record<string, string> = {};
            for (const k of ['auction', 'morning', 'midday', 'tail'] as const) {
              const v = asString(rawGuide[k]);
              if (v) g[k] = v;
            }
            return Object.keys(g).length ? g : null;
          })()
        : null;
      const detail = plan.savePlan(
        {
          marketStance: asMarketStance(args.marketStance),
          focusSectors: asFocusSectors(args.focusSectors),
          externalContext: asString(args.externalContext),
          narrative: asString(args.narrative),
          keyRisks: asStringArray(args.keyRisks),
          intradayGuide: guide,
          items,
        },
        ctx.runId,
      );
      return `今日计划已保存（${detail.plan.planDate}）：${detail.items.length} 只标的，状态 ${detail.plan.status}。`;
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'get_today_plan',
        description:
          '读取今日【作战计划】（含大盘研判、重点板块、各标的方向/结构化触发价/盘中状态与备注）。盘中卖点检查、盯盘、收盘复盘前先调用它对照计划执行。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => {
      const detail = plan.getTodayDetail();
      if (!detail) return '今日尚无作战计划（盘前生成任务未运行或未生成）。';
      return preview(plan.formatPlanForAgent(detail), 10000);
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'update_plan_item',
        description:
          '盘中对照后回写今日计划某标的的状态与备注（写入计划事件，闭环留痕）。status：pending 待触发 / triggered 已触发 / done 已完成 / invalid 已失效。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '6 位代码' },
            status: {
              type: 'string',
              enum: ['pending', 'triggered', 'done', 'invalid'],
            },
            note: { type: 'string', description: '盘中对照备注/结果点评' },
          },
          required: ['code'],
        },
      },
    },
    run: async (args, ctx) => {
      const code = asString(args.code);
      if (!code) return '请提供 code';
      const status = args.status ? (asString(args.status) as PlanItemStatus) : undefined;
      const note = args.note != null ? asString(args.note) : null;
      const item = plan.updateItem(code, status, note, ctx.runId);
      if (!item) return `今日计划中未找到标的 ${code}（或今日无计划）`;
      return `已更新计划标的 ${item.name}(${item.code})：状态 ${item.status}${note ? `，备注：${note}` : ''}`;
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'close_today_plan',
        description:
          '收盘复盘归档今日计划：回填复盘总结（reviewSummary）并把计划置为 closed。收盘复盘任务在逐项 update_plan_item 后最后调用一次。',
        parameters: {
          type: 'object',
          properties: {
            reviewSummary: {
              type: 'string',
              description: '复盘总结 Markdown（大盘小结/命中率得失/逐只结果/打法改进/次日预案）',
            },
          },
          required: ['reviewSummary'],
        },
      },
    },
    run: async (args, ctx) => {
      const summary = asString(args.reviewSummary);
      if (!summary) return '请提供 reviewSummary';
      const ok = plan.closeToday(summary, ctx.runId);
      return ok ? '今日计划已收盘归档（status=closed），复盘总结已回填。' : '今日无计划可归档。';
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'record_catalysts',
        description:
          '把识别出的「消息催化主线」结构化入库（情报研判调用，一次传数组 catalysts）。按 theme 去重 upsert：系统自动累计跨日出现次数 seenCount 与首现日期 firstSeenDate，并合并标的。fermented=false 表示起爆前未发酵（埋伏候选），true 表示已发酵/高位（追高风险）。供今日计划识别「反复出现但未发酵」的潜伏主线。',
        parameters: {
          type: 'object',
          properties: {
            catalysts: {
              type: 'array',
              description: '催化记录数组',
              items: {
                type: 'object',
                properties: {
                  theme: { type: 'string', description: '题材/板块名（去重键，必填）' },
                  catalystType: { type: 'string', description: '催化类型：政策/订单/事件/业绩/资金等' },
                  direction: { type: 'string', description: '受益方向描述' },
                  codes: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '相关标的代码或名称',
                  },
                  catalystWindow: { type: 'string', description: '预计兑现/发酵时间窗' },
                  fermented: { type: 'boolean', description: '是否已发酵/高位（起爆前未发酵传 false）' },
                  realizedPct: { type: 'number', description: '已兑现涨幅 %（可选）' },
                  note: { type: 'string', description: '催化要点/备注' },
                },
                required: ['theme'],
              },
            },
          },
          required: ['catalysts'],
        },
      },
    },
    run: async (args) => {
      const raw = Array.isArray(args.catalysts) ? (args.catalysts as Record<string, unknown>[]) : [];
      const inputs: NewsCatalystInput[] = raw
        .map((c) => ({
          theme: asString(c.theme),
          catalystType: c.catalystType != null ? asString(c.catalystType) : undefined,
          direction: c.direction != null ? asString(c.direction) : undefined,
          codes: asStringArray(c.codes),
          catalystWindow: c.catalystWindow != null ? asString(c.catalystWindow) : undefined,
          fermented: typeof c.fermented === 'boolean' ? c.fermented : undefined,
          realizedPct: typeof c.realizedPct === 'number' ? c.realizedPct : undefined,
          note: c.note != null ? asString(c.note) : undefined,
        }))
        .filter((c) => c.theme.trim().length > 0);
      if (inputs.length === 0) return '未提供有效催化记录（每条至少需要 theme）';
      const saved = inputs.map((i) => research.upsertCatalyst(i));
      return preview(
        `已入库 ${saved.length} 条催化：` +
          saved
            .map((c) => `${c.theme}(出现${c.seenCount}次/首现${c.firstSeenDate}/${c.fermented ? '已发酵' : '未发酵'})`)
            .join('、'),
      );
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'list_catalysts',
        description:
          '读取近期结构化「消息催化主线」（今日计划调用，作为起爆前选股的候选来源）。默认返回近 7 天、按最近出现倒序。unfermentedOnly=true 仅返回未发酵（起爆前埋伏）；记录含首现日期/累计出现次数，反复出现但未发酵者为重点潜伏主线。',
        parameters: {
          type: 'object',
          properties: {
            unfermentedOnly: { type: 'boolean', description: '仅未发酵（起爆前埋伏候选），缺省 false 返回全部' },
            withinDays: { type: 'number', description: '近 N 天内有更新的，缺省 7' },
            limit: { type: 'number', description: '返回条数，1-100，缺省 30' },
          },
        },
      },
    },
    run: async (args) => {
      const list = research.listCatalysts({
        unfermentedOnly: args.unfermentedOnly === true,
        withinDays: args.withinDays != null ? Number(args.withinDays) : undefined,
        limit: args.limit != null ? Number(args.limit) : undefined,
      });
      if (list.length === 0) return '近期暂无结构化催化记录（情报研判尚未入库或已超期）。';
      return preview(
        JSON.stringify(
          list.map((c) => ({
            theme: c.theme,
            catalystType: c.catalystType,
            direction: c.direction,
            codes: c.codes,
            catalystWindow: c.catalystWindow,
            firstSeenDate: c.firstSeenDate,
            lastSeenDate: c.lastSeenDate,
            seenCount: c.seenCount,
            fermented: c.fermented,
            note: c.note,
          })),
          null,
          2,
        ),
      );
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'screen_stocks',
        description:
          '本系统原生多因子选股引擎：全市场快照→规则硬筛(剔科创/北交/ST、量价估值阈值)→多因子打分(估值/流动性/市值/动量/活跃度/题材热度)→LLM横向排序→组合去集中，产出 TopN 候选(含因子分、选股逻辑、风险标签)。pre_breakout_catalyst 策略会对收窄后的候选池逐只补「趋势(多头排列/临近20日新高/量能放大)」与「资金流(主力净流入持续性)」因子。与 mx_screener(妙想自然语言选股) 互补：此工具确定性可解释、内置短线题材策略。',
        parameters: {
          type: 'object',
          properties: {
            strategyId: {
              type: 'string',
              description:
                '策略 id：theme_momentum 题材动量 / volume_breakout 放量突破 / pre_breakout_catalyst 起爆前·趋势资金(逐只补趋势与主力资金持续性，适合起爆前埋伏/右侧确认) / balanced_alpha 均衡阿尔法 / dual_low 双低价值。缺省用默认策略。',
            },
            context: {
              type: 'string',
              description: '今日题材上下文/关键词（如「机器人 算力」），命中候选行业/名称加题材分。',
            },
            topN: { type: 'number', description: '输出数量，3-30，缺省 10。' },
          },
        },
      },
    },
    run: async (args) => {
      const detail = await screener.runScreen({
        strategyId: args.strategyId ? asString(args.strategyId) : undefined,
        context: args.context ? asString(args.context) : undefined,
        topN: args.topN != null ? Number(args.topN) : undefined,
        trigger: 'chat',
        taskName: 'Agent 选股',
      });
      return preview(
        JSON.stringify(
          {
            strategy: detail.strategyName,
            marketCount: detail.marketCount,
            filteredCount: detail.filteredCount,
            marketView: detail.marketView,
            selectionLogic: detail.selectionLogic,
            portfolioRisk: detail.portfolioRisk,
            picks: detail.picks.map((p) => ({
              rank: p.rank,
              code: p.code,
              name: p.name,
              price: p.price,
              pct: p.pct,
              industry: p.industry,
              screenScore: p.screenScore,
              thesis: p.thesis,
              riskTags: p.riskTags,
              confidence: p.confidence,
            })),
          },
          null,
          2,
        ),
      );
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'akshare_call',
        description:
          '调用 AKShare 任意公开数据接口（经 aktools HTTP 服务透传），覆盖 A股/港股/美股 行情、财务、宏观、板块、资金流、龙虎榜、资讯等全品类。' +
          'func 传 akshare 函数名，params 传该函数的键值参数。常用示例：' +
          'stock_zh_a_hist（个股历史K线，params: symbol/period(daily|weekly|monthly)/start_date/end_date(YYYYMMDD)/adjust(qfq|hfq)）、' +
          'stock_individual_info_em（个股基本信息，symbol=代码）、' +
          'stock_board_industry_name_em（行业板块列表）、' +
          'macro_china_cpi（CPI 宏观）、tool_trade_date_hist_sina（交易日历）。' +
          '函数名与完整参数见 AKShare 文档；不确定时优先用更专用的妙想/行情工具。',
        parameters: {
          type: 'object',
          properties: {
            func: { type: 'string', description: 'akshare 函数名，如 stock_zh_a_hist' },
            params: {
              type: 'object',
              description: '该函数的键值参数对象（值为字符串或数字），无参数可省略',
              additionalProperties: { type: ['string', 'number'] },
            },
          },
          required: ['func'],
        },
      },
    },
    run: async (args, ctx) => {
      const func = asString(args.func).trim();
      if (!func) return 'akshare_call 需提供 func（akshare 函数名）';
      const params: Record<string, string | number> = {};
      if (args.params && typeof args.params === 'object') {
        for (const [k, v] of Object.entries(args.params as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number') params[k] = v;
        }
      }
      try {
        const data = await callAkshare(func, params, ctx.signal);
        return preview(data);
      } catch (e) {
        return `AKShare 调用失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'astock_call',
        description:
          '调用 a-stock-data 专属 sidecar 的 A股数据端点（mootdx 通达信直连，不封 IP；东财端点内置限流防封）。' +
          'endpoint 传端点名，params 传键值参数。常用端点：' +
          'mootdx_kline(symbol, category 频率码:0五分/1十五分/2三十分/3六十分/4日/5周/6月, offset)、mootdx_quote(symbols 逗号分隔含五档)、tencent_quote(codes,PE/PB/市值)、baidu_kline_with_ma(code,带MA)、' +
          'ths_eps_forecast(code 机构一致预期EPS)、eastmoney_reports(code 个股研报)、eastmoney_industry_reports(industry_code)、' +
          'ths_hot_reason(date 题材归因)、hsgt_realtime(北向实时)、eastmoney_concept_blocks(code 板块归属)、eastmoney_fund_flow_minute(code 资金流)、' +
          'dragon_tiger_board(code,trade_date 龙虎榜)、daily_dragon_tiger(全市场龙虎榜)、lockup_expiry(code,trade_date 解禁)、industry_comparison(行业排名)、' +
          'margin_trading(code 两融)、block_trade(code 大宗)、holder_num_change(code 股东户数)、dividend_history(code 分红)、stock_fund_flow_120d(code)、' +
          'eastmoney_stock_news(code 新闻)、eastmoney_global_news(全球资讯)、eastmoney_stock_info(code 基本面)、sina_financial_report(code,report_type:lrb/fzb/llb)、' +
          'cninfo_announcements(code 巨潮公告)、full_valuation(code 完整估值)。完整目录可调 endpoint=manifest 或见数据源页说明。',
        parameters: {
          type: 'object',
          properties: {
            endpoint: { type: 'string', description: 'a-stock-data 端点名，如 mootdx_kline / ths_eps_forecast / cninfo_announcements' },
            params: {
              type: 'object',
              description: '该端点的键值参数对象（值为字符串或数字），无参数可省略',
              additionalProperties: { type: ['string', 'number'] },
            },
          },
          required: ['endpoint'],
        },
      },
    },
    run: async (args, ctx) => {
      const endpoint = asString(args.endpoint).trim();
      if (!endpoint) return 'astock_call 需提供 endpoint（a-stock-data 端点名）';
      const params: Record<string, string | number> = {};
      if (args.params && typeof args.params === 'object') {
        for (const [k, v] of Object.entries(args.params as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number') params[k] = v;
        }
      }
      try {
        const data = await callAstock(endpoint, params, ctx.signal);
        return preview(data);
      } catch (e) {
        return `a-stock-data 调用失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'iwencai_stock_pick',
        description:
          '同花顺问财个股智能选股（自然语言）：用一句话筛选 A 股，如「连续3天主力净流入且站上20日线的半导体股」「ROE大于15%且市盈率小于20的科技股」。' +
          '返回符合条件的个股结构化字段（代码/名称/现价/涨跌幅/相关指标）。' +
          'ETF 锁定赛道后「赛道内下钻选龙头」、做条件选股/题材选股时调用。需账号开通问财个股 skill（数据源页「同花顺问财个股选股」启用并配置）。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '自然语言选股条件，如「主力净流入且站上20日线的半导体股」' },
            limit: { type: 'number', description: '返回条数，默认 20，最大 50' },
          },
          required: ['query'],
        },
      },
    },
    run: async (args, ctx) => {
      const query = asString(args.query).trim();
      if (!query) return 'iwencai_stock_pick 需提供 query（自然语言选股条件）';
      const n = Number(args.limit);
      const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : 20;
      try {
        const json = await iwencaiQueryStock(query, { limit: String(limit), signal: ctx.signal });
        if (!json || !('datas' in json)) {
          const m =
            (json && typeof json.message === 'string' && json.message) ||
            (json && typeof json.msg === 'string' && json.msg) ||
            '问财网关返回异常（无 datas，疑似额度/鉴权/个股 skill 未开通）';
          return `问财个股选股失败：${m}`;
        }
        return preview(json.datas);
      } catch (e) {
        return `问财个股选股失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'market_board_strength',
        description:
          '板块中线强弱 + 市场主线聚合（确定性取数，东财行业/概念涨幅榜 + 主力净流入 + 日K 均线/动量）。' +
          '返回两部分：①行业/概念按【中线强度】（均线排列/动量口径，非当日涨幅）排序的强弱榜；' +
          '②按真实板块归并的市场主线（多源叠加强度、含资金/领涨/状态）。' +
          '做「板块主线研判」「今日计划的板块/中线基准」时调用，据此判断主线方向、值得中线跟踪的行业、应剔除的退潮板块。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async () => {
      // 先刷新一次主线聚合（确保板块主源为当日最新），失败不阻断
      await themes.refreshThemes().catch(() => {});
      const [industries, themeList] = await Promise.all([
        radar.computeIndustryRadar().catch(() => []),
        Promise.resolve(themes.listThemes(false)),
      ]);
      const trendText: Record<string, string> = {
        multi_long: '多头排列',
        up: '趋势向上',
        range: '震荡',
        down: '走弱',
      };
      const indLines = industries.slice(0, 18).map((it, i) => {
        const kind = it.boardKind === 'concept' ? '概念' : '行业';
        const pct = it.pct != null ? `${it.pct >= 0 ? '+' : ''}${it.pct.toFixed(2)}%` : '—';
        const mom = it.metrics.momentum != null ? `动量${it.metrics.momentum >= 0 ? '+' : ''}${it.metrics.momentum.toFixed(1)}` : '';
        return `${i + 1}. ${it.name}[${kind}] 强度${it.strengthScore}·${trendText[it.trend] ?? it.trend}·当日${pct}${mom ? '·' + mom : ''}${it.leadStock ? '·领涨' + it.leadStock : ''}`;
      });
      const trendArrow: Record<string, string> = { rising: '↑走强', flat: '→走平', falling: '↓走弱' };
      const themeLines = themeList.slice(0, 12).map((t, i) => {
        const ev = t.evidence[0]?.text ?? '';
        return (
          `${i + 1}. ${t.theme} 强度${Math.round(t.strength)}${trendArrow[t.strengthTrend] ?? ''}·` +
          `持续${t.durationDays}天·${t.status}·${t.sources.length}源${ev ? '｜' + ev : ''}`
        );
      });
      const text =
        '【板块中线强弱（行业+概念，按中线强度排序，非当日涨幅）】\n' +
        (indLines.join('\n') || '暂无板块数据') +
        '\n\n【市场主线聚合（真实板块为主源，复盘/热点为证据 overlay）】\n' +
        (themeLines.join('\n') || '暂无主线数据');
      return preview(text, 12000);
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'list_kline_marks',
        description:
          '列出某标的 K 线图上已有的标注（价位线/点位/区间/趋势线）。只列有效标注，已撤销的历史标注不返回。' +
          '打新标注前先调它，避免同一结论重复画线；结论变了就先 remove_kline_mark 撤旧再打新。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '标的代码，如 600519 / 159740' },
          },
          required: ['code'],
        },
      },
    },
    run: async (args) => {
      // 不传 includeHistorical：repo 默认只返回 status='active'，撤销过的标注不该再出现在查重清单里
      const list = symbolMarks.listMarks(asString(args.code).trim());
      if (list.length === 0) return '该标的暂无标注。';
      const lines = list.map((m) => {
        const pts = m.points
          .map((p) => [p.time, p.price != null ? p.price.toFixed(2) : null].filter(Boolean).join(' @ '))
          .join(' → ');
        return `- [${m.id}] ${MARK_KIND_LABEL[m.kind] ?? m.kind}「${m.label}」${pts}${m.note ? `｜${m.note}` : ''}（${m.createdAt.slice(0, 10)}）`;
      });
      return preview(`该标的现有 ${list.length} 条标注：\n${lines.join('\n')}`);
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'add_kline_mark',
        description:
          '在标的 K 线图上打一个长期留存的标注，把研判结论固化到图上供后续跟踪复核。' +
          '四种形态：price_line 水平价位线（支撑/压力/目标价/止损位，1 个点、只填 price）；' +
          'point 单 K 线点位标记（某日买卖点/关键事件，1 个点、填 time+price）；' +
          'range 时间区间（主升浪/横盘区，2 个点、各填 time+price，构成矩形对角）；' +
          'trend_line 趋势线（2 个点、各填 time+price 连成线段）。' +
          'label 写图上短标签（如「压力 32.5」「主升浪起点」），note 写完整理由。' +
          '打点前先 list_kline_marks 查重；同名标注会覆盖（先撤旧再新增），因此更新结论直接沿用同一 label 即可。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '标的代码，如 600519 / 159740' },
            kind: {
              type: 'string',
              enum: ['price_line', 'point', 'range', 'trend_line'],
              description: '标注形态',
            },
            label: { type: 'string', description: '图上显示的短标签，控制在 12 字内' },
            note: { type: 'string', description: '判断理由与失效条件，可选但强烈建议填' },
            points: {
              type: 'array',
              description: 'price_line/point 一个点，range/trend_line 两个点',
              items: {
                type: 'object',
                properties: {
                  time: {
                    type: 'string',
                    description: '日期 YYYY-MM-DD（分钟级用 YYYY-MM-DD HH:mm）；price_line 不需要',
                  },
                  price: { type: 'number', description: '价格' },
                },
              },
            },
          },
          required: ['code', 'kind', 'label', 'points'],
        },
      },
    },
    run: async (args, ctx) => {
      const code = asString(args.code).trim();
      const label = asString(args.label).trim();
      try {
        // 同名视为结论更新：先撤旧，避免图上同义线越画越多
        const replaced = symbolMarks.removeMarkByLabel(code, label);
        const mark = symbolMarks.addMark({
          code,
          kind: asString(args.kind) as SymbolMarkKind,
          label,
          note: args.note ? asString(args.note) : null,
          points: Array.isArray(args.points) ? (args.points as SymbolMarkPoint[]) : [],
          runId: ctx.runId,
        });
        return (
          `已在 ${code} 的 K 线上添加${MARK_KIND_LABEL[mark.kind]}标注「${label}」（id=${mark.id}）` +
          `${replaced > 0 ? `，并撤销了 ${replaced} 条同名旧标注` : ''}。用户在标的详情弹窗的 K 线图上即可看到。`
        );
      } catch (e) {
        return `打点失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'get_symbol_technical_context',
        description:
          '取某标的的确定性技术上下文（个股/ETF 通用）：多周期读数、道氏摆动点与趋势、缠论候选结构、量价、' +
          '统一市场阶段、相对强弱、板块广度、执行质量与事件风险、持仓与风险预算、大盘/板块阶段。' +
          '阶段、趋势、结构、风险、仓位、主动作全部由后端算定，你不能修改，只能解释。' +
          '返回 contextId，后续必须用同一个 contextId 调 list_symbol_plan_candidates 取候选、' +
          '再调 save_symbol_trade_plan 提交。不返回原始 K 线，不要要求原始 K 线。' +
          '这是做「标的技术计划 / K线阶段 / 触发失效」类任务的第一步。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '标的代码，如 600519 / 159516' },
            name: { type: 'string', description: '标的名称，可选' },
            secid: { type: 'string', description: '指数需传 secid，可选' },
          },
          required: ['code'],
        },
      },
    },
    run: async (args) => {
      try {
        const snap = await symbolPlanOrch.prepareContext({
          code: asString(args.code).trim(),
          name: args.name ? asString(args.name) : undefined,
          secid: args.secid ? asString(args.secid) : undefined,
        });
        return preview(formatTechnicalContext(snap), 6000);
      } catch (e) {
        return `取技术上下文失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'list_symbol_plan_candidates',
        description:
          '取后端已算好的候选价位目录或候选条件目录。必须先调 get_symbol_technical_context 拿 contextId。' +
          '计划里的每个价位和每个条件都只能从这里按 candidateId 挑选，禁止自己写价格数字或发明条件。' +
          'catalog=levels 取候选价位（含角色、评分、来源、距现价 ATR 倍数）；catalog=conditions 取候选条件。',
        parameters: {
          type: 'object',
          properties: {
            contextId: { type: 'string', description: 'get_symbol_technical_context 返回的 contextId' },
            catalog: { type: 'string', enum: ['levels', 'conditions'], description: '取哪个目录' },
          },
          required: ['contextId', 'catalog'],
        },
      },
    },
    run: async (args) => {
      const snap = symbolPlanOrch.getCachedContext(asString(args.contextId).trim());
      if (!snap) return '上下文已过期或不存在，请重新调用 get_symbol_technical_context。';
      const which = asString(args.catalog);
      return preview(formatCandidates(snap.catalog, which === 'conditions' ? 'conditions' : 'levels'), 6000);
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'save_symbol_trade_plan',
        description:
          '提交标的交易计划。你只提交摘要、相比上一版的变化，以及从候选目录里挑出的价位ID与条件ID组合；' +
          '阶段、趋势、结构、风险、止盈止损、仓位、主动作由后端从证据编译，不接受你填写。' +
          '每个情景必须同时给触发条件与失效条件，否则会被拒。' +
          '校验失败会返回结构化错误与可用候选ID，按提示只修正问题项后可重试一次。',
        parameters: {
          type: 'object',
          properties: {
            contextId: { type: 'string' },
            candidateModelVersion: { type: 'string', description: '来自 contextId 对应上下文' },
            catalogHash: { type: 'string', description: '来自候选目录，防跨快照混用' },
            summary: { type: 'string', description: '一句话说清当前阶段与该做什么' },
            changes: {
              type: 'array',
              items: { type: 'string' },
              description: '相比上一版本变化的 1~3 条新证据；首次生成填「首次生成」',
            },
            levelSelections: {
              type: 'array',
              description: '从候选价位里挑，每条指定承担的角色',
              items: {
                type: 'object',
                properties: {
                  candidateLevelId: { type: 'string' },
                  role: {
                    type: 'string',
                    enum: ['support', 'resistance', 'entry_trigger', 'add_trigger', 'invalidation', 'stop', 'target'],
                  },
                  label: { type: 'string', description: '图上短标签，可选' },
                },
                required: ['candidateLevelId', 'role'],
              },
            },
            scenarioSelections: {
              type: 'array',
              description: '主路径必填；备选与风险路径可选',
              items: {
                type: 'object',
                properties: {
                  rank: { type: 'string', enum: ['primary', 'alternative', 'risk'] },
                  name: { type: 'string' },
                  conditionCandidateIds: { type: 'array', items: { type: 'string' } },
                  invalidConditionCandidateIds: { type: 'array', items: { type: 'string' } },
                  targetCandidateLevelIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      '目标价位 id，按优先级排列，**首项即第一目标**（事后核对兑现只看首项）。' +
                      '每个 id 都必须同时出现在 levelSelections 里，否则计划里根本没有这个价位，会被打回。',
                  },
                  subjectiveProbabilityPct: {
                    type: 'number',
                    description:
                      '你对该情景兑现的主观概率 0~100。只用于展示并留待事后校准，不参与仓位/止损/告警任何计算。' +
                      '没把握就省略，不要为了填满字段而给 50。',
                  },
                  probabilityBasis: {
                    type: 'string',
                    description: '给出该概率的依据，一句话。给不出依据就连概率一起省略',
                  },
                },
                required: ['rank', 'name', 'conditionCandidateIds', 'invalidConditionCandidateIds'],
              },
            },
          },
          // candidateModelVersion 必填：validateProposal 把它不匹配判为 catalog_mismatch，
          // 若 schema 允许省略，模型合法省略也会被拒，两次后白白降级成观察计划
          required: [
            'contextId',
            'candidateModelVersion',
            'catalogHash',
            'summary',
            'levelSelections',
            'scenarioSelections',
          ],
        },
      },
    },
    run: async (args, ctx) => {
      const proposal = args as unknown as SymbolTradePlanProposal;
      try {
        const plan = symbolPlanOrch.submitProposal(proposal, { runId: ctx.runId });
        proposalRetries.delete(proposal.contextId);
        return (
          `已保存计划 v${plan.version}（${plan.code} ${plan.name}）：阶段 ${plan.marketPhase}，` +
          `账户动作 ${plan.primaryAction}，${plan.levels.length} 条关键位已同步到 K 线图，` +
          `${plan.scenarios.length} 个情景。建议仓位上限 ${plan.risk.suggestedPositionPct ?? '—'}%，` +
          `结构止损 ${plan.risk.structuralStop ?? '—'}，有效期至 ${plan.expiresAt ?? '未设定'}。`
        );
      } catch (e) {
        if (e instanceof symbolPlanOrch.ProposalRejected) {
          // 同一份上下文连续两次被拒：别再让模型空转重试，落一份观察计划把结论固定下来，
          // 用户至少能看到「为什么没给出可执行计划」，而不是一个什么都没有的标的
          // ponytail: 非原文、按接口语义重建——原实现用的是自带 +1 的 bumpProposalRetry，
          // 本文件恢复出的是只负责写入+TTL 清扫的 setProposalRetries，故读增写拆成两步，语义等价
          const tries = (proposalRetries.get(proposal.contextId)?.tries ?? 0) + 1;
          setProposalRetries(proposal.contextId, tries);
          if (tries >= 2) {
            proposalRetries.delete(proposal.contextId);
            const reason = e.issues.map((i) => i.message).join('；');
            const draft = symbolPlanOrch.fallbackDraft(proposal.contextId, reason, {
              runId: ctx.runId,
            });
            if (draft) {
              return (
                `提案两次未通过校验，已降级为观察计划 v${draft.version}（不给出可执行点位）。` +
                `原因：${preview(reason, 1500)}`
              );
            }
          }
          return preview(symbolPlanOrch.formatIssuesForRetry(e.issues), 6000);
        }
        return `保存计划失败：${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'remove_kline_mark',
        description:
          '删除一条 K 线标注（结论已失效、或打错了）。id 从 list_kline_marks 获取。' +
          '只在结论确实作废时用，历史标注是用户复核判断质量的依据，不要为了清爽随意删。' +
          '交易计划同步出来的计划标注不可删，只随新版本计划自动失效；要改结论请提交新版本计划。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: '标注 id' } },
          required: ['id'],
        },
      },
    },
    run: async (args) => {
      const id = asString(args.id).trim();
      const r = symbolMarks.removeMark(id);
      if (r === 'ok') return `已删除标注 ${id}。`;
      if (r === 'plan_protected') {
        return `标注 ${id} 属于交易计划（含版本号），不可删除：计划标注只随新版本计划自动失效，以保留版本可追溯。若结论已变，请提交新版本计划。`;
      }
      return `标注 ${id} 不存在。`;
    },
  },
];

/**
 * 战法模拟工具：仅在任务绑定战法（ctx.strategyId 存在）时挂载。
 * sim_trade 买卖只落本系统的战法虚拟账户，强制涨跌停/100股/T+1/资金持仓校验，绝不触发真实下单。
 */
export const simTools: ToolDef[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'sim_positions',
        description:
          '查询【当前绑定战法】的模拟账户：可用现金、总资产、收益率与各持仓（含现价、成本、浮盈、可卖股数）。卖点研判、加减仓决策前调用。',
        parameters: { type: 'object', properties: {} },
      },
    },
    run: async (_args, ctx) => {
      if (!ctx.strategyId) return '当前运行未绑定战法，无法查询战法账户';
      const s = await getStrategySnapshot(ctx.strategyId);
      const lines = [
        `战法【${s.strategy.name}】 初始资金${s.strategy.initialCapital.toFixed(0)} 现金${s.strategy.cash.toFixed(2)}`,
        `总资产${s.totalAsset.toFixed(2)} 持仓市值${s.totalMarketValue.toFixed(2)} 总收益${s.totalProfit.toFixed(2)}(${(s.totalProfitRate * 100).toFixed(2)}%)`,
        `持仓 ${s.positions.length} 只：`,
        ...s.positions.map(
          (p) =>
            `- ${p.name}(${p.code}) 现价${p.price} 成本${p.avgCost.toFixed(3)} ${p.qty}股 可卖${p.sellableQty} ` +
            `市值${p.marketValue.toFixed(0)} 浮盈${p.holdProfit.toFixed(0)}(${(p.holdRate * 100).toFixed(2)}%) 仓位${(p.positionRate * 100).toFixed(1)}%`,
        ),
      ];
      return preview(lines.join('\n'));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'sim_trade',
        description:
          '在【当前绑定战法】的模拟账户下单（只记录在本系统，不触发任何真实/妙想下单）。side=buy 买入 / sell 卖出。' +
          '缺省按实时现价成交，提供 price 则为限价（须在涨跌停区间内）。' +
          '平台会强制校验：涨停不可买/跌停不可卖、数量为 100 整数倍、T+1（当日买入不可当日卖）、资金/可卖持仓充足；不满足会返回失败原因。',
        parameters: {
          type: 'object',
          properties: {
            side: { type: 'string', enum: ['buy', 'sell'] },
            stockCode: { type: 'string', description: '6 位股票代码' },
            quantity: { type: 'number', description: '股数，100 的整数倍' },
            price: { type: 'number', description: '限价（元），市价可省略' },
            reason: { type: 'string', description: '本次操作原因，建议填写便于复盘' },
            thesis: {
              type: 'string',
              description: '该标的当前持有逻辑（如「金属钨价格涨价」），写入持仓便于持续跟踪',
            },
          },
          required: ['side', 'stockCode', 'quantity'],
        },
      },
    },
    run: async (args, ctx) => {
      if (!ctx.strategyId) return '当前运行未绑定战法，无法执行模拟下单';
      const side = asString(args.side, 'buy') as 'buy' | 'sell';
      const code = asString(args.stockCode);
      const qty = Number(args.quantity) || 0;
      try {
        const r = await executeSimTrade({
          strategyId: ctx.strategyId,
          side,
          code,
          qty,
          price: typeof args.price === 'number' ? args.price : undefined,
          reason: args.reason ? asString(args.reason) : null,
          thesis: args.thesis ? asString(args.thesis) : null,
          runId: ctx.runId,
          source: 'agent',
          force: ctx.forceTrade ?? false,
        });
        const t = r.trade;
        return (
          `模拟${t.side === 'buy' ? '买入' : '卖出'}成功：${t.name}(${t.code}) ${t.qty}股 @${t.price} ` +
          `金额${t.amount.toFixed(2)}` +
          (t.realizedProfit != null ? ` 已实现盈亏${t.realizedProfit.toFixed(2)}` : '') +
          ` 剩余现金${r.cash.toFixed(2)}`
        );
      } catch (e) {
        // 安全总闸拒绝：不静默，经盯盘总线广播一条「自动交易被拒」事件让用户看得见为何没自动成交，
        // 同时把明确原因回灌给模型。其它业务错误（资金不足/涨跌停等）按原样抛回，由模型据此调整。
        if (e instanceof SafetyError) {
          const strategy = getStrategy(ctx.strategyId);
          try {
            broadcastWatch({
              type: 'trade',
              trade: {
                at: nowIso(),
                kind: 'rejected',
                source: 'agent',
                code,
                name: strategy?.name ?? code,
                qty: qty || null,
                price: null,
                amount: null,
                realizedProfit: null,
                strategyId: ctx.strategyId,
                strategyName: strategy?.name ?? null,
                reason: e.message,
              },
            });
          } catch {
            /* 广播失败不影响回灌 */
          }
          return `自动交易被安全总闸拒绝：${e.message}。如需启用，请到驾驶舱安全台开启「自动本地模拟」开关。`;
        }
        throw e;
      }
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'save_picks',
        description:
          '把【最终选出的标的】记录到「选股历史」（可在选股模块查看，支持 T+N 收益回看），不触发任何买卖。' +
          '用于尾盘动能套利等「只记录不交易」的选股任务：传入最终标的清单（每只含代码/名称/现价），按顺序作为排名落库。' +
          'mainline 可填今日主线关键词便于复盘。',
        parameters: {
          type: 'object',
          properties: {
            picks: {
              type: 'array',
              description: '最终选出的标的列表（按强弱顺序，即记录排名）',
              items: {
                type: 'object',
                properties: {
                  code: { type: 'string', description: 'A 股 6 位代码' },
                  name: { type: 'string', description: '股票名称' },
                  price: { type: 'number', description: '当前现价（T+N 复盘基准，必填且 >0）' },
                  pct: { type: 'number', description: '当日涨跌幅 %（可选）' },
                  industry: { type: 'string', description: '所属行业/概念（可选）' },
                  thesis: { type: 'string', description: '选取理由一句话（主线/动能/量价，可选）' },
                },
                required: ['code', 'name', 'price'],
              },
            },
            mainline: { type: 'string', description: '今日主线关键词（可选，落库为 context）' },
          },
          required: ['picks'],
        },
      },
    },
    run: async (args, ctx) => {
      const raw = Array.isArray(args.picks) ? (args.picks as Record<string, unknown>[]) : [];
      const picks = raw
        .map((p) => ({
          code: asString(p.code).trim(),
          name: asString(p.name).trim(),
          price: Number(p.price) || 0,
          pct: p.pct != null ? Number(p.pct) || 0 : 0,
          industry: p.industry ? asString(p.industry) : '',
          thesis: p.thesis ? asString(p.thesis) : undefined,
        }))
        .filter((p) => /^\d{6}$/.test(p.code) && p.price > 0);
      if (picks.length === 0) return '未提供合法标的（每只需含 6 位代码与正现价），未记录';
      const detail = screener.saveAgentPicks({
        picks,
        context: args.mainline ? asString(args.mainline) : null,
        runId: ctx.runId,
        trigger: 'cron',
      });
      const lines = detail.picks.map((p) => `${p.rank}. ${p.name}(${p.code}) ${p.price}`);
      return preview(`已记录 ${detail.picks.length} 只到选股历史（${detail.strategyName}）：\n${lines.join('\n')}`);
    },
  },
];

/**
 * 战法 Skill 自迭代工具：仅在战法绑定且启用 Skill（ctx.skillEnabled）时挂载。
 * propose_skill_update 只记录【待用户确认】的修订提案，绝不直接改动现行打法。
 */
export const skillTools: ToolDef[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'propose_skill_update',
        description:
          '提交对【当前绑定战法】打法的修订提案（仅在复盘类运行中、基于持仓表现与近期成交发现可改进时使用）。' +
          'dimension 指定维度：pick 选股规则 / buy 买入规则 / sell 卖出规则。' +
          'content 为该维度修订后的完整规则文本（不是 diff，须自包含可直接替换现行规则）。' +
          'reason 说明本次调整的依据。注意：提案不会立刻生效，需用户在战法页确认后才采用，本次运行仍按现行打法执行。',
        parameters: {
          type: 'object',
          properties: {
            dimension: { type: 'string', enum: ['pick', 'buy', 'sell'] },
            content: { type: 'string', description: '修订后的完整规则文本' },
            reason: { type: 'string', description: '调整依据' },
          },
          required: ['dimension', 'content', 'reason'],
        },
      },
    },
    run: async (args, ctx) => {
      if (!ctx.strategyId) return '当前运行未绑定战法，无法提交 Skill 修订提案';
      const dimension = asString(args.dimension) as SkillDimension;
      try {
        const p = proposeSkillUpdate({
          strategyId: ctx.strategyId,
          dimension,
          content: asString(args.content),
          reason: args.reason ? asString(args.reason) : null,
          sourceRunId: ctx.runId,
        });
        // best-effort 通知用户去审批（Telegram 未配置时静默失败）
        try {
          const s = getStrategy(ctx.strategyId);
          await sendTelegram(
            `【${s?.name ?? '战法'}】提交了 ${dimensionLabel(dimension)} 修订提案，待你在战法页确认。\n理由：${p.reason ?? '（未填写）'}`,
          );
        } catch {
          /* 通知失败不影响提案落库 */
        }
        return `已提交 ${dimensionLabel(dimension)} 修订提案（待用户确认后生效，本次运行仍按现行打法执行）。`;
      } catch (e) {
        return `提交修订提案失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];

/**
 * 本地思考工具：零副作用、零网络，仅原样回显，作为 sequential-thinking 的轻量平替。
 * 仅在 thinking 模式下挂载（见 getToolDefinitions），用于复杂决策前的结构化拆解与反思。
 */
export const thinkTool: ToolDef = {
  definition: {
    type: 'function',
    function: {
      name: 'think',
      description:
        '思考草稿纸：在做复杂决策（选股、仓位、卖点判断）前，用它拆解问题、列出假设与待验证项、或在拿到数据后做一步反思校验。' +
        '不获取任何外部数据、不产生副作用。想清楚后停止调用，转而用数据工具求证或直接给结论。',
      parameters: {
        type: 'object',
        properties: {
          thought: { type: 'string', description: '当前这一步的思考内容' },
          nextStepNeeded: { type: 'boolean', description: '是否还需要继续思考，可选' },
        },
        required: ['thought'],
      },
    },
  },
  run: async (args) => asString(args.thought),
};

const allTools = [...tools, ...simTools, ...skillTools, thinkTool];

export const toolMap = new Map(allTools.map((t) => [t.definition.function.name, t]));

/** 基础工具定义（不含 think / sim） */
export const toolDefinitions = tools.map((t) => t.definition);

// ===== 工具页元数据：分组 + 挂载条件 + 启停/描述覆盖 =====

/** 工具名 → 分组（工具页分区展示）；未列出回落「其他」 */
const TOOL_GROUP: Record<string, string> = {
  mx_finance_data: '妙想',
  mx_assistant_ask: '妙想',
  mx_screener: '妙想',
  mx_search: '妙想',
  mx_self_select: '妙想',
  mx_simulator: '妙想',
  mx_trade: '妙想',
  mx_cancel: '妙想',
  stock_quotes: '行情持仓',
  stock_l2_indicators: '行情持仓',
  real_positions: '行情持仓',
  get_position_discipline: '行情持仓',
  get_attribution: '行情持仓',
  market_snapshot: '行情持仓',
  market_sentiment: '行情持仓',
  dragon_ladder: '行情持仓',
  stock_capital: '行情持仓',
  stock_indicators: '行情持仓',
  price_levels: '行情持仓',
  stock_chips: '行情持仓',
  market_board_strength: '行情持仓',
  sync_ths_watchlist: '行情持仓',
  eastmoney_datacenter: '行情持仓',
  akshare_call: 'AKShare',
  astock_call: 'A股数据',
  screen_stocks: '选股',
  iwencai_stock_pick: '选股',
  decision_debate: '决策',
  research_reports: '研报热点',
  trendradar_hotspots: '研报热点',
  record_catalysts: '研报热点',
  list_catalysts: '研报热点',
  save_today_plan: '计划复盘',
  get_today_plan: '计划复盘',
  update_plan_item: '计划复盘',
  close_today_plan: '计划复盘',
  get_plan_context: '计划复盘',
  get_latest_review_stance: '计划复盘',
  etf_signals: 'ETF',
  etf_rotation_strength: 'ETF',
  sim_positions: '战法',
  sim_trade: '战法',
  save_picks: '选股',
  propose_skill_update: '战法',
  notify_telegram: '通知',
  think: '推理',
  list_kline_marks: '标的跟踪',
  add_kline_mark: '标的跟踪',
  remove_kline_mark: '标的跟踪',
  get_symbol_technical_context: '标的计划',
  list_symbol_plan_candidates: '标的计划',
  save_symbol_trade_plan: '标的计划',
};

/** 工具名 → 挂载条件，供工具页展示与启停归类 */
const TOOL_AVAILABILITY = new Map<string, ToolAvailability>([
  ...tools.map((t) => [t.definition.function.name, 'always'] as const),
  ...simTools.map((t) => [t.definition.function.name, 'strategy'] as const),
  ...skillTools.map((t) => [t.definition.function.name, 'strategy_skill'] as const),
  [thinkTool.definition.function.name, 'thinking'] as const,
]);

/** 工具页清单：合并代码内置定义与用户覆盖（启停 / 描述）。 */
export function listToolInfo(): ToolInfo[] {
  const overrides = getOverrides();
  const coreNames = getCoreToolNames();
  return allTools.map((t) => {
    const fn = t.definition.function;
    const ov = overrides[fn.name] ?? {};
    const base = fn.description ?? '';
    return {
      name: fn.name,
      group: TOOL_GROUP[fn.name] ?? '其他',
      availability: TOOL_AVAILABILITY.get(fn.name) ?? 'always',
      baseDescription: base,
      description: ov.description?.trim() || base,
      parameters: (fn.parameters ?? {}) as Record<string, unknown>,
      enabled: ov.enabled !== false,
      overridden: !!ov.description?.trim(),
      core: coreNames.has(fn.name),
    };
  });
}

/** 应用用户覆盖：过滤禁用工具、覆盖描述文案 */
function applyOverrides(
  defs: OpenAI.Chat.Completions.ChatCompletionTool[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const overrides = getOverrides();
  const out: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
  for (const def of defs) {
    const ov = overrides[def.function.name];
    if (ov?.enabled === false) continue; // 禁用：不下发给 LLM
    const desc = ov?.description?.trim();
    out.push(desc ? { ...def, function: { ...def.function, description: desc } } : def);
  }
  return out;
}

/**
 * 按运行上下文返回工具定义：
 * - thinking 开启时额外挂载 think 工具；
 * - 绑定战法（strategyId）时额外挂载 sim_trade / sim_positions 工具；
 * - 战法启用 Skill（skillEnabled）时额外挂载 propose_skill_update 工具。
 * 最终统一应用工具页的启停/描述覆盖。
 */
export function getToolDefinitions(
  thinking: boolean,
  strategyId?: string | null,
  skillEnabled?: boolean,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const defs = [...toolDefinitions];
  if (strategyId) defs.push(...simTools.map((t) => t.definition));
  if (strategyId && skillEnabled) defs.push(...skillTools.map((t) => t.definition));
  if (thinking) defs.push(thinkTool.definition);
  return applyOverrides(defs);
}

// ===== 渐进式披露（search_tools 元工具）=====
// 初始只向模型暴露核心工具 + search_tools，其余工具经检索后由 loop 一步式注入完整 schema，
// 降低工具定义常驻 token 与选择歧义。匹配为零依赖的关键词/分组打分（仿 Anthropic regex 检索）。

/** 渐进式披露的元工具名（循环原生处理，不进 toolMap） */
export const SEARCH_TOOLS_NAME = 'search_tools';

/** 常驻核心工具默认集：渐进式披露下初始即可见（最高频读工具）。用户可在工具页按工具覆盖。 */
export const DEFAULT_CORE_TOOL_NAMES = new Set<string>(['mx_finance_data', 'real_positions']);

/** 生效的核心工具名集合：用户覆盖（toolConfig.core）优先，未覆盖回落默认集。 */
export function getCoreToolNames(): Set<string> {
  const overrides = getOverrides();
  const out = new Set<string>();
  for (const t of allTools) {
    const name = t.definition.function.name;
    const isCore = overrides[name]?.core ?? DEFAULT_CORE_TOOL_NAMES.has(name);
    if (isCore) out.add(name);
  }
  return out;
}

/** search_tools 一次返回的最大命中数 */
const SEARCH_DEFAULT_LIMIT = 8;

/** search_tools 元工具定义（始终可见） */
export function buildSearchToolDef(): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: SEARCH_TOOLS_NAME,
      description:
        '工具检索器（渐进式披露）：当前你只看到少数核心工具，其余工具需先检索加载后才能调用。' +
        '用自然语言/关键词描述你需要的能力，命中的工具会被加载进后续可调用工具列表。' +
        '示例：查行情写「行情/资金/估值」，下单写「妙想模拟盘 下单 买卖」，选股写「选股 筛选」，' +
        '研报写「券商研报 评级」，热点写「全网热点 新闻」，大盘写「大盘 指数 情绪」，' +
        'ETF 写「ETF 信号」，计划写「今日计划 复盘」，自选写「自选股」，决策写「多空辩论 操作建议」，' +
        '往 K 线图上画支撑压力/买卖点写「标注 打点」，' +
        '生成某标的的技术交易计划（阶段/触发/失效/止盈止损）写「标的计划 K线阶段 触发失效」。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '所需能力的自然语言/关键词描述' },
          limit: { type: 'number', description: `返回命中数上限，默认 ${SEARCH_DEFAULT_LIMIT}` },
        },
        required: ['query'],
      },
    },
  };
}

/** 把查询切成小写词元（中文按整串 + 空格/标点切分，兼顾中英混合） */
function tokenizeQuery(query: string): string[] {
  const lower = query.toLowerCase();
  const parts = lower.split(/[\s,，、;；/|]+/).filter(Boolean);
  // 整串也作为一个词元，覆盖直接写工具名（如 mx_trade）的情况
  return Array.from(new Set([lower, ...parts])).filter((t) => t.length >= 2);
}

/**
 * 在给定工具池内按关键词/分组打分检索（零依赖）。
 * 命中维度：工具名（命中权重高）、描述、分组标签。返回降序前 limit 个完整定义 + 可读清单。
 */
export function matchToolDefs(
  query: string,
  pool: OpenAI.Chat.Completions.ChatCompletionTool[],
  limit = SEARCH_DEFAULT_LIMIT,
): { defs: OpenAI.Chat.Completions.ChatCompletionTool[]; text: string } {
  const terms = tokenizeQuery(query);
  if (terms.length === 0) {
    return { defs: [], text: '检索词过短，请用更具体的关键词（如「研报」「下单」「ETF 信号」）。' };
  }
  const scored = pool
    .map((def) => {
      const name = def.function.name.toLowerCase();
      const desc = (def.function.description ?? '').toLowerCase();
      const group = (TOOL_GROUP[def.function.name] ?? '').toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (name.includes(t)) score += 5;
        if (group && (group.includes(t) || t.includes(group))) score += 3;
        if (desc.includes(t)) score += 1;
      }
      return { def, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));

  if (scored.length === 0) {
    const groups = Array.from(new Set(Object.values(TOOL_GROUP))).join('、');
    return {
      defs: [],
      text: `未检索到匹配工具。可用工具分组：${groups}。请换用这些方向的关键词重试。`,
    };
  }
  const defs = scored.map((s) => s.def);
  const text =
    `已加载 ${defs.length} 个工具，现在可直接调用：\n` +
    defs
      .map((d) => `- ${d.function.name} — ${(d.function.description ?? '').slice(0, 80)}`)
      .join('\n');
  return { defs, text };
}
