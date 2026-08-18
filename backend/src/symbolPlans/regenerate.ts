import * as gateway from '../agent/gateway';
import { buildChatPrompt } from '../agent/chatPrompt';
import * as repo from './repo';
import { CANDIDATE_MODEL_VERSION } from './candidateCatalog';

// 收盘后自动重算：把「最新版本已失效/过期」的标的重新生成一份计划。
// 只重算这一类，不碰仍然有效的计划——有效计划每天重算一遍纯属白烧 token，
// 而且会让用户盯了一天的价位与条件在收盘后无缘无故换一批。

/**
 * 单轮最多重算多少只。每只是一次完整的 agent 计划生成（三次工具调用 + 一次落库），
 * 不设上限的话某天集中失效十几只会在收盘后连着跑掉大量 token 且拖很久。
 * 超出的留到下一个交易日——它们已经是失效状态，晚一天重算不会误导操作。
 */
const MAX_PER_RUN = 8;

/** 单只的超时。三次工具调用里技术上下文那步要打多次行情接口，给足余量 */
const TIMEOUT_SEC = 600;

export interface RegenerateSummary {
  /** 本轮识别出的待重算标的数（含被 MAX_PER_RUN 截断的） */
  stale: number;
  /** 真正落库了新版本的 */
  regenerated: number;
  /** 尝试过但没落库的 */
  failed: number;
  /** 被单轮上限截断、留到下一个交易日的 */
  deferred: number;
  /** 因候选模型版本过期而被置为待重算的（本轮名额内的那几只，其余保持生效等下一轮） */
  outdated: number;
  /** 因不可交易（指数/板块）而被退出队列的历史计划 */
  retired: number;
}

/** 计划生成入口。自检注入替身以驱动真实调用链而不真调模型 */
export type PlanCaller = typeof gateway.call;

/**
 * 重算全部失效/过期计划。**串行**执行：并行会同时开多个 agent 循环抢上游限流，
 * 且失败时难以判断是模型问题还是被限流打回。
 *
 * 失败一律保留旧计划并记一条事件说明，绝不留空窗——失效计划至少还写着
 * 「因为什么失效」，删掉或置空会让用户在收盘复盘时对着一片空白。
 */
export async function regenerateStalePlans(
  opts: { call?: PlanCaller } = {},
): Promise<RegenerateSummary> {
  const call = opts.call ?? gateway.call;
  // 把候选口径已过期的生效计划打成 expired，它们才能进入下面的 stale 队列。
  // 只打本轮名额还剩下的那几只：一次性全打会让全部生效计划同时消失，而本轮只重建得了
  // MAX_PER_RUN 只，剩下的要等好几个交易日才轮到，期间界面上是「尚无交易计划」。
  const pending = repo.listStalePlans();
  const outdated = repo.expireOutdatedCandidateModelPlans(
    CANDIDATE_MODEL_VERSION,
    Math.max(0, MAX_PER_RUN - pending.length),
  );
  const all = outdated.length > 0 ? repo.listStalePlans() : pending;

  // 指数/板块类计划生成不出新版本（validateProposal 拒、fallbackDraft 也返回 null），
  // 留在队列里就是每轮认领一次、烧一次 agent 调用、占掉一个名额，还每轮追加一条失败事件。
  // 给它们补一个终态退出队列——历史仍可回看，只是不再参与重算。
  const retired = all.filter((p) => p.assetType === 'index');
  for (const p of retired) {
    repo.updateStatus(p.id, 'superseded');
    repo.appendEvent({
      planId: p.id,
      planVersion: p.version,
      kind: 'superseded',
      note: '指数/板块类标的不支持交易计划（全链路按 code 定位会与个股撞码），已退出收盘重算队列',
    });
  }

  const queue = all.filter((p) => p.assetType !== 'index');
  const batch = queue.slice(0, MAX_PER_RUN);
  const summary: RegenerateSummary = {
    stale: queue.length,
    regenerated: 0,
    failed: 0,
    deferred: queue.length - batch.length,
    outdated: outdated.length,
    retired: retired.length,
  };

  // listStalePlans 已按 code 去重，这里再兜一层：重算过程中新落库的计划可能又失效，
  // 同一 code 在一轮里重复认领会白烧一次 agent 调用并占掉一个名额
  const done = new Set<string>();
  for (const plan of batch) {
    if (done.has(plan.code)) {
      summary.stale -= 1;
      continue;
    }
    done.add(plan.code);
    const prompt = buildChatPrompt({
      refCode: plan.code,
      refName: plan.name,
      content:
        // 状态是 live 但已过有效期的（如风险路径启动后被收紧到当日收盘）同样按「过期」说
        `上一版计划（v${plan.version}）已${plan.status === 'invalid' ? '失效' : '过期'}：${plan.summary}。` +
        '请按当前证据重新生成一份计划，并在 changes 里写清相对上一版有哪些变化。',
      planIntent: true,
    });

    // 必须逐只兜异常：gateway.call 会因超时、上游 5xx、工具抛错而 reject，
    // 不接住的话一只标的失败就掀掉整轮定时任务，后面排队的全部得不到重算，
    // 而且失败那只连一条说明事件都留不下，用户第二天只看到一份没动过的失效计划。
    let reason: string;
    try {
      const r = await call({
        mode: 'agent',
        trigger: 'cron',
        purpose: 'symbol-plan',
        taskName: `标的计划收盘重算 ${plan.code} ${plan.name}`,
        prompt,
        modelConfig: { thinking: false, maxSteps: 12 },
        timeoutSec: TIMEOUT_SEC,
      });
      reason = r.status === 'success' ? '模型未落库' : `调用${r.status}：${r.error ?? ''}`;
    } catch (e) {
      reason = `调用异常：${e instanceof Error ? e.message : String(e)}`;
    }

    // 成败不看 gateway 的 status：模型完全可以「顺利跑完并在对话里口述一份计划」
    // 却没调 save_symbol_trade_plan。唯一算数的判据是库里真的多了一份生效计划。
    // 抛异常的那次也照查一遍——工具已经落库、只是收尾阶段出错的情况算成功。
    const after = repo.getActivePlan(plan.code);
    if (after && after.version > plan.version) {
      summary.regenerated += 1;
      continue;
    }

    summary.failed += 1;
    repo.appendEvent({
      planId: plan.id,
      planVersion: plan.version,
      kind: 'reviewed',
      note:
        `收盘后自动重算未产出新版本（${reason}），` +
        '本版计划原样保留，可在标的会话里手动点「生成计划」重试',
    });
  }

  return summary;
}
