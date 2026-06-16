import type { FastifyInstance, FastifyReply } from 'fastify';
import { runTask } from '../runner';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { fetchEtfQuote } from './data';
import * as repo from './repo';
import * as svc from './service';
import { getModules, setModules } from './modules';
import { cached } from '../lib/ttlCache';

// 挂载 ETF 模块：注册 /api/etf/*。server.ts 仅需 registerEtfModule(app) 一行接入，删除即整模块下线。
// 自包含范式（仿 research/plan）：确定性指标层 + LLM 综合，跟踪池独立维护，信号经 agent 工具 etf_signals
// 喂给今日计划生成 ETF 计划项。4 个模块定时迁自原「旺财」ETF 相关任务，仅研判不下单。

const ETF_MODEL = { thinking: false, maxSteps: 18 } as const;

// ===== 模块定时 prompt（迁自 cronTasks.ts 旺财 ETF 系列，统一以 etf_signals 为量化底座） =====

const TRADE_DAY_GUARD =
  '交易日校验（默认放行）：仅周一至周五触发，默认按 A 股交易日执行；接口报错/超时/空结果一律按交易日继续，不据此判休市。\n\n';

const PROMPT_PREMARKET =
  'A 股开盘前约 30 分钟，给出今日 ETF 开盘后操作蓝图。本任务仅出建议、不下单（用户自行在同花顺手动挂单）。\n\n' +
  TRADE_DAY_GUARD +
  '第1步 ETF 量化底座：用 etf_signals(action=signals) 取跟踪池每只 ETF 的估值位置分位/年线偏离/折溢价(IOPV)/动量排名/波动率/网格水位与操作建议+结构化触发价，作为今日 ETF 决策基线。折溢价标注缺失的标的，用 mx_finance_data 补 IOPV/折溢价。\n' +
  '第2步 真实持仓 ETF：用 real_positions 读最近交易日真实持仓，识别已持有 ETF（代码 15/5 开头或名称含 ETF/LOF），标注成本/盈亏；开头注明「持仓数据时间」。\n' +
  '第3步 隔夜消息扫描：用 mx_search 与 trendradar_hotspots(action=summary 或 trending) 查美股费半/纳指收盘、港股恒生科技盘前、央行/政策要点；每条标注时间，非昨晚-今早窗口标「T-N 旧闻」。重点关注与池内 ETF 对应板块（半导体/恒生科技/电池/宽基等）的方向。\n' +
  '第4步 开盘前决策：把 etf_signals 的量化建议与隔夜消息方向叠加——买入区且折溢价<1% 且隔夜利好→开盘≤+0.5% 加仓/建仓；高估分位或隔夜利空→减仓或不动等 09:50 确认；折溢价偏高显式提示追高风险。\n' +
  '第5步 挂单价建议：优先采用 etf_signals 的 buyTrigger/sellTrigger；ETF 无涨跌停，买入参考价≈触发价或现价×1.005。\n' +
  '输出：开头「数据时间 · ETF 开盘前规划」+「核心隔夜信号」一行；候选+持仓状态总览与今日操作蓝图清单（标的/动作/预挂单价/依据）；重大警示≤3 条；结论 3 行内。结尾注明「09:50 ETF 早盘扫描将基于实际开盘验证/修正」。推送禁止表格，用竖排清单。';

const PROMPT_OPENING =
  '开盘 20 分钟后做全市场 ETF 早盘机会扫描，给出今日 ETF 买点建议。本任务仅出建议、不下单。\n\n' +
  TRADE_DAY_GUARD +
  '第1步 量化底座：用 etf_signals(action=signals) 取跟踪池全量信号。\n' +
  '第2步 持仓识别：用 real_positions 识别已持有 ETF，优先考虑加仓既有 ETF，避免重复推荐已重仓的同一只。\n' +
  '第3步 实时核验：对 etf_signals 中标为「买入/加仓」的候选用 mx_finance_data 查现价/折溢价/主力净流入/近5日份额变化做二次确认；折溢价显著偏高需显式提示追高风险。\n' +
  '第4步 板块新闻：对买入候选所属板块用 mx_search/trendradar_hotspots 查当日新闻/政策，每条标注日期，非今日标「T-N 旧闻」。\n' +
  '第5步 研判：综合量化信号 + 实时核验 + 板块新闻，对每只候选给动作（加仓/新建仓/回避/观望）并附依据（含分位/动量排名/触发价）。已重仓同板块不重复建仓。\n' +
  '第6步 挂单价：采用 etf_signals 的 buyTrigger，或现价×1.005。\n' +
  '输出：开头「数据时间 · ETF 早盘机会扫描」；候选 ETF 总览与推荐操作清单（标的/动作/建议挂单价/依据）；重大警示≤3 条；结论 3 行内。若无明确买点，直接输出「✅ 今日全市场 ETF 无明确买点，维持现有持仓观察」。推送禁止表格，用竖排清单。';

const PROMPT_SELLCHECK =
  '距收盘约 15 分钟，对真实同花顺实盘持仓中的【ETF】做最后一次卖点检查并给出可执行卖出建议。本任务仅出建议、不下单。本任务只处理 ETF，个股由其它任务负责。\n\n' +
  TRADE_DAY_GUARD +
  '第0步 对照今日计划：先用 get_today_plan 读今日计划，对计划内 ETF 标的结合其结构化触发价（卖点/止损/止盈）判断是否已触发；触发或逻辑破坏的用 update_plan_item(code,status,note) 回写。无今日计划则跳过本步。\n' +
  '第1步 读持仓 ETF：用 real_positions 读真实持仓，筛出 ETF（代码 15/5 开头或名称含 ETF/LOF），非 ETF 个股本任务一律忽略。开头注明「数据时间」与「盘中实时盘点（距收盘 15 分钟）」。\n' +
  '第2步 量化卖点：用 etf_signals(action=signals) 取池内信号；对每只持有 ETF 结合 etf_signals 的估值分位/折溢价/动量与触发价，并用 mx_finance_data 查实时折溢价/量价，综合判断是否触发减仓/止盈/止损（继续持有/减仓/清仓/观察）。每条建议必附依据来源。\n' +
  '第3步 卖出挂单价：ETF 不卡跌停，用 etf_signals 的 sellTrigger 或最新价作为建议挂单价。\n' +
  '注意：这是真实账户，本任务只研判与提醒，绝不下单。\n' +
  '输出：开头「数据时间 · ETF 盘中卖点检查」；持有 ETF 卖点清单（标的/动作/建议挂单价/依据）；若无 ETF 持仓或全部健康，明确说明并等待 16:00 日终复盘。推送禁止表格，用竖排清单。';

const PROMPT_DAYEND =
  '收盘后基于真实同花顺实盘持仓中的【ETF】做日终复盘与监控。本任务仅出建议、不下单，只看 ETF 不含个股。\n\n' +
  TRADE_DAY_GUARD +
  '第0步 对照今日计划：先用 get_today_plan 读今日计划，对照 ETF 标的的执行情况（是否按计划买卖、触发价是否命中），纳入复盘。无今日计划则跳过本步。\n' +
  '第1步 读持仓 ETF：用 real_positions 读真实持仓，筛出 ETF；原文复述其持有盈亏/当日盈亏/持有金额/仓位（禁止用「金额×百分比」反推）；开头注明数据时间。\n' +
  '第2步 量化复盘：用 etf_signals(action=signals) 取全池信号；对持有 ETF 用 mx_finance_data 查收盘折溢价/近5日份额变化，结合 etf_signals 的估值分位/动量排名/网格水位判断当前位置与轮动强弱。\n' +
  '第3步 复盘输出：①ETF 组合表现与集中度 ②折溢价/份额异动识别 + 解读 ③操作建议（继续持有/分批减仓/观察/止损，按 etf_signals 分桶，每条附依据）④次日 ETF 关注方向（结合动量排名靠前或低估分位的池内标的）⑤结论 3–5 行，无异常则「无重大异常维持观察」。\n' +
  '推送禁止表格，用竖排清单；金额沿用 real_positions 原文。';

export function registerEtfModule(app: FastifyInstance): void {
  const fail = (reply: FastifyReply, e: unknown) =>
    reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });

  // 首启写入默认 ETF 跟踪池（幂等）
  repo.seedEtfPoolIfEmpty();

  // 模块内定时（默认禁用，配置好妙想/真实持仓后到 ETF 页启用）。迁自旺财 ETF 系列。
  const cronJob = (name: string, prompt: string) => async () => {
    await runTask(
      {
        id: null,
        name,
        prompt,
        modelConfig: ETF_MODEL,
        notifyChannels: ['webui', 'telegram'],
        timeoutSec: 900,
        purpose: 'scheduled-task',
      },
      'cron',
    );
  };

  defineModuleSchedules({
    app,
    module: 'etf',
    jobs: [
      {
        id: 'etf.premarket',
        label: 'ETF 开盘前规划（0900）',
        defaultCron: '0 9 * * 1-5',
        run: cronJob('ETF-0900-开盘前规划', PROMPT_PREMARKET),
      },
      {
        id: 'etf.openingScan',
        label: 'ETF 早盘机会扫描（0950）',
        defaultCron: '50 9 * * 1-5',
        run: cronJob('ETF-0950-早盘机会扫描', PROMPT_OPENING),
      },
      {
        id: 'etf.sellCheck',
        label: 'ETF 盘中卖点检查（1445）',
        defaultCron: '45 14 * * 1-5',
        run: cronJob('ETF-1445-盘中卖点检查', PROMPT_SELLCHECK),
      },
      {
        id: 'etf.dayEnd',
        label: 'ETF 持仓日终监控（1600）',
        defaultCron: '0 16 * * 1-5',
        run: cronJob('ETF-1600-持仓日终监控', PROMPT_DAYEND),
      },
      {
        // 合并后的单一 ETF AI 分析（量化信号 + 中线轮动 + 持仓/消息），落 taskRun 供今日计划 ETF 基准源。
        // 收盘后 15:45，承接原 rotation.review 轮动定时（已下线），避免双跑。
        id: 'etf.analyze',
        label: 'ETF 综合研判（收盘后 1545）',
        defaultCron: '45 15 * * 1-5',
        run: async () => {
          await runTask(
            {
              id: null,
              name: svc.ETF_ANALYZE_TASK_NAME,
              prompt: svc.ETF_ANALYZE_PROMPT,
              modelConfig: { thinking: false, maxSteps: 14, maxTokens: 14000 },
              notifyChannels: ['webui', 'telegram'],
              timeoutSec: 600,
              purpose: 'analyze',
            },
            'cron',
          );
        },
      },
    ],
  });

  // 模块状态
  app.get('/api/etf/status', () => ({ ok: true, data: svc.status() }));

  // 跟踪池列表
  app.get('/api/etf/pool', () => ({ ok: true, data: repo.listPool() }));

  // 新增跟踪标的（校验 6 位代码且能取到 ETF 行情）
  app.post<{ Body: { code?: string; tags?: string; note?: string } }>(
    '/api/etf/pool',
    async (req, reply) => {
      const code = (req.body?.code ?? '').trim();
      if (!/^\d{6}$/.test(code)) {
        return reply.code(400).send({ ok: false, error: '请输入 6 位 ETF 代码' });
      }
      try {
        const q = await fetchEtfQuote(code);
        if (!q.name) {
          return reply
            .code(400)
            .send({ ok: false, error: `未查到代码 ${code} 的 ETF 行情，请确认代码` });
        }
        repo.addPool({
          code,
          name: q.name,
          tags: req.body?.tags?.trim() || null,
          note: req.body?.note?.trim() || null,
        });
        return { ok: true, data: repo.listPool() };
      } catch (e) {
        return fail(reply, e);
      }
    },
  );

  // 更新标签 / 备注
  app.put<{ Params: { code: string }; Body: { tags?: string; note?: string } }>(
    '/api/etf/pool/:code',
    (req) => {
      repo.updatePool(req.params.code, {
        tags: req.body?.tags?.trim() ?? undefined,
        note: req.body?.note?.trim() ?? undefined,
      });
      return { ok: true, data: repo.listPool() };
    },
  );

  // 移除跟踪标的
  app.delete<{ Params: { code: string } }>('/api/etf/pool/:code', (req) => {
    repo.removePool(req.params.code);
    return { ok: true, data: repo.listPool() };
  });

  // ETF 市场总览快照（仿大盘页，多榜单 + 概览 + 主题分类）
  app.get('/api/etf/overview', async (_req, reply) => {
    try {
      // 响应级 60s 缓存：多榜单聚合，重进 ETF 页共享同一快照（review/analyze 直连 buildOverview 不受影响）
      return { ok: true, data: await cached('etf:overview', 60_000, svc.buildOverview) };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 市场总览面板显隐配置
  app.get('/api/etf/modules', () => ({ ok: true, data: getModules() }));
  app.put<{ Body: Record<string, boolean> }>('/api/etf/modules', (req) => ({
    ok: true,
    data: setModules(req.body ?? {}),
  }));

  // 一键 ETF 市场 AI 点评：以当前 ETF 盘面为上下文跑 agent
  app.post('/api/etf/review', async (_req, reply) => {
    try {
      const ov = await svc.buildOverview();
      const result = await runTask(
        {
          id: null,
          name: svc.ETF_REVIEW_TASK_NAME,
          prompt: svc.buildEtfReviewPrompt(ov),
          modelConfig: { thinking: false, maxSteps: 10 },
          notifyChannels: ['webui'],
          timeoutSec: 300,
          purpose: 'market-review',
        },
        'manual',
      );
      return {
        ok: result.status === 'success',
        data: { runId: result.runId, status: result.status, text: result.outputText },
        error: result.status === 'success' ? undefined : `点评未成功（${result.status}）`,
      };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 全池确定性买卖信号
  app.get('/api/etf/signals', async (_req, reply) => {
    try {
      return { ok: true, data: await svc.signals() };
    } catch (e) {
      return fail(reply, e);
    }
  });

  // 一键 ETF AI 综合研判（跑 agent，包成 run 纳入全局运行抽屉）
  app.post('/api/etf/analyze', async (_req, reply) => {
    try {
      const result = await svc.runEtfAnalyze({ trigger: 'manual', channels: ['webui'] });
      return {
        ok: result.status === 'success',
        data: { runId: result.runId, status: result.status, text: result.outputText },
        error: result.status === 'success' ? undefined : `研判未成功（${result.status}）`,
      };
    } catch (e) {
      return fail(reply, e);
    }
  });
}
