import type { FastifyInstance } from 'fastify';
import type {
  SwingOverview,
  SwingReading,
  SwingRunStatus,
  SwingTrackCategory,
  SwingTrackGap,
  SwingWatchLevel,
} from '@stock-agent/shared';
import { defineModuleSchedules } from '../scheduling/defineModuleSchedules';
import { readLatestSnapshot, runSwingScan } from './runner';
import { listAdviceEvents, listOpenAdvices, toDto } from './adviceStore';
import { latestResults, runValidation } from './validate';
import { currentRuleVersion, isDirectionPassed, VALIDATION_GATE } from './ruleVersion';
import { db, schema } from '../db/client';
import { and, eq } from 'drizzle-orm';

// 波段试探建议模块。server.ts 仅需 registerSwingModule(app) 一行接入。
//
// 接口只读**最近一份完整快照**，不在请求时现场重算：
// 一轮扫描要几分钟（几百个标的、两个周期），放在请求里会把页面拖死，
// 而且每次打开页面结果都不一样，建议就没法存档了。
//
// 返回时必须同时给出快照日期与今日运行状态。少了这个，
// 页面会把昨天的建议当成今天的——这是最容易发生也最危险的一种误解。

export function registerSwingModule(app: FastifyInstance): void {
  app.get('/api/swing/overview', (_req, reply) => {
    try {
      return { ok: true, data: buildOverview() };
    } catch (e) {
      return reply.code(500).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 手动跑一次检验。要回看每个信号之后 20 个交易日的走势，给足超时
  app.post('/api/swing/validate', async (_req, reply) => {
    try {
      return { ok: true, data: await runValidation() };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 某只标的的建议动作历史：建了几层、什么时候减的、为什么退出
  app.get<{ Params: { code: string } }>('/api/swing/:code/events', (req, reply) => {
    const code = (req.params?.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) {
      return reply.code(400).send({ ok: false, error: '标的代码不对' });
    }
    return { ok: true, data: listAdviceEvents(code) };
  });

  // 手动触发一轮扫描。耗时几分钟，前端应给出等待提示
  app.post('/api/swing/scan', async (_req, reply) => {
    try {
      return { ok: true, data: await runSwingScan('live') };
    } catch (e) {
      return reply.code(502).send({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  defineModuleSchedules({
    app,
    module: 'swing',
    jobs: [
      {
        id: 'swing.snapshot',
        label: '波段观察收盘扫描（15:40）',
        // 排在板块宽度（15:25）与大盘阶段（15:20）之后：要用到当日的市场阶段
        defaultCron: '40 15 * * 1-5',
        // 默认开启：这个机制默认是关的，不显式声明就永远不会自动跑
        defaultEnabled: true,
        run: async () => {
          await runSwingScan('live');
        },
      },
      {
        id: 'swing.validate',
        label: '波段判断检验（每周六）',
        // 每周跑一次就够：样本按周积累，天天跑只是重复算同一批数据。
        // 放周六是因为它要回看每个信号之后 20 个交易日的走势，与当日行情无关
        defaultCron: '30 9 * * 6',
        defaultEnabled: true,
        run: async () => {
          await runValidation();
        },
      },
    ],
  });
}

/** 把快照行还原成读数（导出供 rotationBoard.ts 复用，两处必须是同一份还原逻辑） */
export function toReading(row: typeof schema.swingSnapshots.$inferSelect): SwingReading {
  let extra: {
    rationale?: string[];
    counterEvidence?: string[];
    unavailableReason?: string | null;
    divergenceConfirmed?: boolean | null;
    chaseGuard?: number | null;
    peerCount?: number;
  } = {};
  try {
    extra = JSON.parse(row.rationale) as typeof extra;
  } catch {
    extra = {};
  }
  let watchLevels: SwingWatchLevel[] = [];
  try {
    watchLevels = JSON.parse(row.watchLevels) as SwingWatchLevel[];
  } catch {
    watchLevels = [];
  }
  return {
    code: row.code,
    name: row.name,
    period: row.period as SwingReading['period'],
    assetType: row.assetType as SwingReading['assetType'],
    track: row.track,
    category: row.category as SwingTrackCategory,
    isTrackProxy: row.isTrackProxy,
    peerCount: extra.peerCount ?? 1,
    grade: row.grade as SwingReading['grade'],
    close: row.close,
    divergenceStrength: row.divergenceStrength,
    zone: row.zoneLow != null && row.zoneHigh != null ? { low: row.zoneLow, high: row.zoneHigh } : null,
    initialStop: row.initialStop,
    // 追高线存在快照的 rationale JSON 里（runner.ts 写入），不是独立列。
    // 早先这里漏了这一行映射，于是界面只能显示买入区间、显示不出「涨过多少就别追了」
    chaseGuard: extra.chaseGuard ?? null,
    atr14: row.atr14,
    watchLevels,
    rationale: extra.rationale ?? [],
    counterEvidence: extra.counterEvidence ?? [],
    barTime: row.barTime,
    unavailableReason: extra.unavailableReason ?? null,
  };
}

/** 当前验收进度：还差多少样本、有没有通过 */
function buildValidation(): SwingOverview['validation'] {
  const cur = currentRuleVersion();
  const passed = isDirectionPassed('bottom') && isDirectionPassed('top');
  if (!cur) {
    return {
      passed: false,
      shortfalls: ['规则还没定版，尚未开始积累检验样本'],
      eventCount: 0,
      requiredEventCount: VALIDATION_GATE.minEventsPerDirection,
    };
  }
  const samples = db
    .select()
    .from(schema.swingValidationSamples)
    .where(
      and(
        eq(schema.swingValidationSamples.ruleVersion, cur.version),
        eq(schema.swingValidationSamples.kind, 'real'),
      ),
    )
    .all();
  const eventKeys = new Set(samples.map((s) => s.eventKey));
  const shortfalls: string[] = [];
  if (!passed) {
    shortfalls.push(
      '这套判断还没有证明比随便挑日子更准，所以仓位被限制在试探规模（单个标的最多 10%）',
    );
    // 有验收结果时用它的具体缺项，比笼统说「还没检验」有用得多
    const results = latestResults();
    if (results.length === 0) {
      shortfalls.push(
        `还需要积累到 ${VALIDATION_GATE.minEventsPerDirection} 次独立信号才能开始检验，现在有 ${eventKeys.size} 次`,
      );
    } else {
      for (const r of results) {
        const dirWord = r.direction === 'bottom' ? '底部信号' : '顶部信号';
        let items: string[] = [];
        try {
          items = JSON.parse(r.shortfalls) as string[];
        } catch {
          items = [];
        }
        if (r.verdict === 'passed') continue;
        for (const it of items) shortfalls.push(`${dirWord}：${it}`);
      }
    }
    shortfalls.push(`检验样本从 ${cur.eligibleFromTradeDate} 起算（规则定版之后的数据才算）`);
  }
  return {
    passed,
    shortfalls,
    eventCount: eventKeys.size,
    requiredEventCount: VALIDATION_GATE.minEventsPerDirection,
  };
}

/** 暂无可交易标的的赛道。存在快照时从当轮的缺口信息取，否则为空 */
function buildGaps(): SwingTrackGap[] {
  // 缺口是取数时算出来的，不落库；页面每次打开都重算成本很高（要拉全市场 ETF 清单），
  // 而它变化极慢。这里先返回空数组，由页面按需另调 universe 接口——
  // 与其在这里塞一份可能过期的副本，不如让缺口和赛道清单来自同一次取数
  return [];
}

function buildOverview(): SwingOverview {
  const { run, rows, running } = readLatestSnapshot();
  if (!run) {
    return {
      run: null,
      scanning: running,
      tracks: [],
      mine: [],
      advices: [],
      gaps: [],
      validation: buildValidation(),
    };
  }
  let failures: Array<{ code: string; reason: string }> = [];
  try {
    failures = JSON.parse(run.failures) as typeof failures;
  } catch {
    failures = [];
  }
  const runStatus: SwingRunStatus = {
    runId: run.id,
    tradeDate: run.tradeDate,
    mode: run.mode as SwingRunStatus['mode'],
    status: run.status as SwingRunStatus['status'],
    targetCount: run.targetCount,
    okCount: run.okCount,
    failures,
    dataAsOf: run.dataAsOf,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };

  const readings = rows.map(toReading);
  // 赛道代表与「我的」分开：前者用于横向看谁到位了，后者要出细化提示
  const tracks = readings.filter((r) => r.isTrackProxy);
  const mine = readings.filter((r) => r.category === 'own');

  // 建议持仓要带上真实持仓比例：两者会持续偏离（没照建议下单时），
  // 页面必须把「系统建议」与「你实际持有」分开显示，不能混成一个数
  const realPctByCode = new Map<string, number>();
  for (const row of rows) {
    try {
      const extra = JSON.parse(row.rationale) as { realPct?: number };
      if (typeof extra.realPct === 'number') realPctByCode.set(row.code, extra.realPct);
    } catch {
      /* 忽略解析失败，该标的的真实仓位显示为未知 */
    }
  }
  const advices = listOpenAdvices().map((a) => toDto(a, realPctByCode.get(a.code) ?? null));

  return {
    run: runStatus,
    scanning: running,
    tracks,
    mine,
    advices,
    gaps: buildGaps(),
    validation: buildValidation(),
  };
}
