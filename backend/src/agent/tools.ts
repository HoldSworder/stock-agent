import type OpenAI from 'openai';
import { miaoxiang } from '../miaoxiang/client';
import { sendTelegram } from '../notify/telegram';
import { saveStockPicks, listPicks } from '../repo';
import { fetchRealPositions } from '../realPositions';
import type { StockPickInput } from '@stock-agent/shared';

export interface ToolContext {
  runId: string | null;
}

export interface ToolDef {
  definition: OpenAI.Chat.Completions.ChatCompletionTool;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function preview(value: unknown, max = 4000): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + '\n...[已截断]' : s;
}

export const tools: ToolDef[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'mx_finance_data',
        description:
          '妙想全市场金融数据查询，支持 A股/港股/美股/基金/债券/ETF。用自然语言描述要查的标的与指标（行情、资金流、估值、涨跌停价等），可一次查多只多指标。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '自然语言查询语句' } },
          required: ['query'],
        },
      },
    },
    run: async (args) => preview(await miaoxiang.financeData(asString(args.query))),
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
    run: async (args) => preview(await miaoxiang.screener(asString(args.query))),
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
    run: async (args) => preview(await miaoxiang.search(asString(args.query))),
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
    run: async (args) => {
      const action = asString(args.action, 'get');
      if (action === 'get') return preview(await miaoxiang.selfSelectGet());
      return preview(await miaoxiang.selfSelectManage(asString(args.query)));
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'mx_simulator',
        description:
          '妙想模拟盘查询。action=positions 查持仓；action=balance 查资金；action=orders 查委托。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['positions', 'balance', 'orders'] },
          },
          required: ['action'],
        },
      },
    },
    run: async (args) => {
      const action = asString(args.action, 'positions');
      if (action === 'balance') return preview(await miaoxiang.balance());
      if (action === 'orders') return preview(await miaoxiang.orders());
      return preview(await miaoxiang.positions());
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'real_positions',
        description:
          '查询用户【真实持仓】（来源同花顺投资账本，含现金、现价、成本、持有盈亏、当日盈亏，当日盈亏已校正为当天）。真实持仓卖点检查、复盘真实账户时调用。注意：这是真实账户，只读，不可下单。',
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
        name: 'mx_trade',
        description:
          '妙想模拟盘下单。side=buy 买入 / sell 卖出。useMarketPrice=true 市价单（忽略 price）；限价单需提供 price（元，平台自动按板块放大为整数）。下单前应先确认标的代码与数量。',
        parameters: {
          type: 'object',
          properties: {
            side: { type: 'string', enum: ['buy', 'sell'] },
            stockCode: { type: 'string', description: '6 位股票代码' },
            quantity: { type: 'number', description: '股数，100 的整数倍' },
            useMarketPrice: { type: 'boolean' },
            price: { type: 'number', description: '限价（元），市价单可省略' },
          },
          required: ['side', 'stockCode', 'quantity', 'useMarketPrice'],
        },
      },
    },
    run: async (args) =>
      preview(
        await miaoxiang.trade({
          type: asString(args.side, 'buy') as 'buy' | 'sell',
          stockCode: asString(args.stockCode),
          quantity: Number(args.quantity) || 0,
          useMarketPrice: Boolean(args.useMarketPrice),
          price: typeof args.price === 'number' ? args.price : undefined,
        }),
      ),
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
        name: 'save_stock_picks',
        description:
          '把本次选出的股票结构化留痕，用于后续复盘。务必在给出选股结论后调用，记录代码、名称、现价、理由、信号、标签。',
        parameters: {
          type: 'object',
          properties: {
            picks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  code: { type: 'string' },
                  name: { type: 'string' },
                  price: { type: 'number' },
                  reason: { type: 'string' },
                  signals: { type: 'object' },
                  tags: { type: 'array', items: { type: 'string' } },
                },
                required: ['code', 'name'],
              },
            },
          },
          required: ['picks'],
        },
      },
    },
    run: async (args, ctx) => {
      const picks = (args.picks as StockPickInput[]) ?? [];
      const n = saveStockPicks(ctx.runId, picks);
      return `已留痕 ${n} 只标的`;
    },
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'query_history',
        description: '查询历史选股留痕，用于复盘与对比。可按日期范围筛选（ISO 字符串）。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '起始时间 ISO，可选' },
            to: { type: 'string', description: '结束时间 ISO，可选' },
            limit: { type: 'number' },
          },
        },
      },
    },
    run: async (args) =>
      preview(
        listPicks({
          from: args.from ? asString(args.from) : undefined,
          to: args.to ? asString(args.to) : undefined,
          limit: typeof args.limit === 'number' ? args.limit : 100,
        }),
      ),
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
];

export const toolDefinitions = tools.map((t) => t.definition);
export const toolMap = new Map(tools.map((t) => [t.definition.function.name, t]));
