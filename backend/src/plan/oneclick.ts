import type { OneClickRunState, OneClickStepStatus } from '@stock-agent/shared';
import { nowIso } from '../util';
import { runIntelReview } from '../research';
import { runMarketBoardReview } from '../themes';
import { runEtfAnalyze } from '../etf/service';
import { runScreen } from '../screener/service';
import { runPlanGeneration } from './service';

// 一键计划编排：盘前链路按依赖分阶段刷新上游分析，最终生成今日计划。
// 情报/大盘是最根基的数据，计划生成只读聚合五源最新落库产出，故必须先刷上游再生成。
// 阶段间串行、阶段内并行：ETF 综合研判 与 选股引擎 互不依赖，同阶段并行执行（Promise.allSettled）。
// 期货+外盘已源级合并进「大盘与板块研判」，不再单独成步。
// 尽力而为：单步失败记录后继续；计划生成独占末阶段，无论上游成败都会执行（计划本身能容忍源缺失/过期）。
// 编排状态仅内存单例保存（手动动作，进程重启即中止，可接受），不新增持久化表。

/** 单步执行结果：runId 关联 taskRun / screen_runs；ok=false 视为失败但继续 */
interface StepResult {
  runId: string | null;
  ok: boolean;
  error?: string;
}

interface StepDef {
  key: string;
  label: string;
  run: () => Promise<StepResult>;
}

/**
 * 编排阶段：阶段间串行（上游→下游），阶段内并行。
 * 子步骤仅推 webui 避免 TG 刷屏；计划步为交付物，额外推 telegram 一条。
 * state.steps 仍按这里的扁平顺序展开（intel→market-board→etf→screener→plan），UI 顺序不变。
 */
const STAGES: StepDef[][] = [
  [
    {
      key: 'intel',
      label: '情报研判',
      run: async () => {
        const r = await runIntelReview({ trigger: 'manual', channels: ['webui'] });
        return { runId: r.runId || null, ok: r.status === 'success' };
      },
    },
  ],
  [
    {
      key: 'market-board',
      label: '大盘与板块研判',
      run: async () => {
        const r = await runMarketBoardReview({ trigger: 'manual', channels: ['webui'] });
        return { runId: r.runId || null, ok: r.status === 'success' };
      },
    },
  ],
  [
    {
      key: 'etf',
      label: 'ETF 综合研判',
      run: async () => {
        const r = await runEtfAnalyze({ trigger: 'manual', channels: ['webui'] });
        return { runId: r.runId || null, ok: r.status === 'success' };
      },
    },
    {
      key: 'screener',
      label: '选股引擎',
      run: async () => {
        const detail = await runScreen({ trigger: 'manual', useLlm: true });
        return { runId: detail.id, ok: detail.picks.length > 0 };
      },
    },
  ],
  [
    {
      key: 'plan',
      label: '今日计划生成',
      run: async () => {
        const r = await runPlanGeneration({
          trigger: 'manual',
          channels: ['webui', 'telegram'],
          maxSteps: 20,
          awaitDebate: true,
        });
        return { runId: r.runId || null, ok: r.status === 'success' };
      },
    },
  ],
];

/** 扁平步骤序列（UI 渲染顺序），按阶段展开 */
const FLAT_STEPS: StepDef[] = STAGES.flat();

function freshSteps(): OneClickStepStatus[] {
  return FLAT_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    status: 'pending',
    runId: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  }));
}

// 内存单例状态
const state: OneClickRunState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  steps: freshSteps(),
};

/** 返回当前编排快照（深拷贝，避免外部改动内存态） */
export function getOneClickState(): OneClickRunState {
  return {
    running: state.running,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    steps: state.steps.map((s) => ({ ...s })),
  };
}

/** 执行单步并就地更新其状态（异常吞掉记 error，尽力而为不中断同阶段其他步） */
async function runStep(def: StepDef): Promise<void> {
  const step = state.steps.find((s) => s.key === def.key);
  if (!step) return;
  step.status = 'running';
  step.startedAt = nowIso();
  try {
    const res = await def.run();
    step.runId = res.runId;
    step.status = res.ok ? 'success' : 'error';
    if (!res.ok) step.error = res.error ?? '未成功';
  } catch (e) {
    step.status = 'error';
    step.error = e instanceof Error ? e.message : String(e);
    console.warn(`[oneclick] 步骤「${def.label}」失败:`, step.error);
  } finally {
    step.finishedAt = nowIso();
  }
}

/** 分阶段执行链路（阶段间串行、阶段内并行；后台跑，不被 HTTP 请求 await） */
async function runPipeline(): Promise<void> {
  for (const stage of STAGES) {
    await Promise.allSettled(stage.map((def) => runStep(def)));
  }
  state.running = false;
  state.finishedAt = nowIso();
}

/**
 * 启动一键计划编排：若已在运行则抛错（前端据此提示）；否则重置状态、置 running、
 * 后台启动串行链路（不 await），返回初始快照供前端开始轮询。
 */
export function startOneClickPlan(): OneClickRunState {
  if (state.running) throw new Error('一键计划已在运行中');
  state.running = true;
  state.startedAt = nowIso();
  state.finishedAt = null;
  state.steps = freshSteps();
  void runPipeline().catch((e) => {
    // 兜底：理论上 runPipeline 内部已逐步 try/catch，这里仅防御未预期异常
    state.running = false;
    state.finishedAt = nowIso();
    console.warn('[oneclick] 编排异常终止:', e instanceof Error ? e.message : e);
  });
  return getOneClickState();
}
