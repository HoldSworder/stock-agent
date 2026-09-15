// 分层记账口径自检（无框架，assert 断言，不联网不碰数据库）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/layerLedger.selfcheck.ts
//
// 钉住一件事：**推送给使用者的仓位数，必须等于模拟层位记账用的数。**
//
// 原先这两个数走的是不同来源：
//   记账：`heldPct = 已建各层的配置比例之和`（engine.ts），applyMutation 只增删层号
//   推送：`sizePct = 模型输出 ?? 本层目标比例`（confidence.ts）
// 模型说买 10% 而第三层配置是 40% 时，推送的是 10%、层位按 40% 记账——
// 两个数永远对不上，而且**下一轮的买点护栏（剩余仓位、总仓上限）是拿记账那个数算的**。
//
// 当时这靠「模型不参与了所以碰巧对上」维持，不是定义。
// 现在把仓位比例收成规则单一来源：模型仍可在文字里说它觉得该轻一点，但数由规则定。
// 理由不只是记账闭合——仓位是个要照着下单的数，属于结论，
// 按 ADR 0001/0002 模型只做翻译与事实核对，不产结论、不改定版参数。

import assert from 'node:assert/strict';
import { __test__buildInstruction } from '../etfwatch/confidence';
import type { EtfWatchConfig, EtfWatchSignal } from '@stock-agent/shared';

/** 三层配置：20 / 30 / 40，总仓上限 90，禁追高与硬止损关掉以免干扰本文件要测的东西 */
const cfg = {
  layer1Pct: 20,
  layer2Pct: 30,
  layer3Pct: 40,
  maxTotalPct: 90,
  chaseGuardPct: 0,
  hardStopPct: 8,
  minConfidence: 0,
} as EtfWatchConfig;

const signal = (layer: 1 | 2 | 3, positionPct: number): EtfWatchSignal =>
  ({
    code: '159740',
    name: '恒生科技',
    type: 'buy_layer',
    layer,
    timeframe: layer === 1 ? '30m' : layer === 2 ? '60m' : 'day',
    positionPct,
    price: 0.6,
    pct: 1.2,
    dif: 0.01,
    dea: 0.005,
  }) as EtfWatchSignal;

// ===== 1. 模型给的仓位数一律不采纳 =====
//
// 这是整个文件的核心。算术：第三层配置 40%，模型说只买 10%。
// 早先推送 10%、记账 40%，差 30 个百分点，而护栏用的是 40。
{
  const withModelSize = __test__buildInstruction(
    signal(3, 40),
    cfg,
    0,
    true,
    { sizePct: 10 } as never, // 模型硬塞一个 10%
    '自检',
  );
  assert.equal(
    withModelSize.sizePct,
    40,
    '仓位必须按规则的本层目标 40%，不得采纳模型给的 10%——否则推送与记账差 30 个百分点',
  );
  assert.equal(withModelSize.totalAfterPct, 40, '总仓预计值也要按规则算');
}

// ===== 2. 推送的数 == 记账的数（逐层核对）=====
//
// 记账侧就是「已建各层配置比例之和」，所以只要每层推送的 sizePct 等于该层配置，
// 两侧就恒等。这里把三层逐个核过去，防止某一层被单独改坏。
{
  const layerCfg: Record<1 | 2 | 3, number> = { 1: 20, 2: 30, 3: 40 };
  for (const layer of [1, 2, 3] as const) {
    const ins = __test__buildInstruction(signal(layer, layerCfg[layer]), cfg, 0, true, {}, '自检');
    assert.equal(
      ins.sizePct,
      layerCfg[layer],
      `第 ${layer} 层推送的仓位必须等于该层配置 ${layerCfg[layer]}%，否则与层位记账对不上`,
    );
  }

  // 已建 L1（记账 20%）后再建 L2：总仓预计 = 20 + 30
  const addOnTop = __test__buildInstruction(signal(2, 30), cfg, 20, true, {}, '自检');
  assert.equal(addOnTop.sizePct, 30, '加仓本次比例仍是本层配置');
  assert.equal(addOnTop.totalAfterPct, 50, '总仓预计 = 已建 20 + 本层 30');
  assert.equal(addOnTop.action, '加仓', '已有仓位时应当是加仓而非建仓');
}

// ===== 3. 不建仓时仓位必须归零，总仓保持不变 =====
//
// 观望却带着一个非零仓位数，会被读成「可以按这个比例买」。
{
  const watch = __test__buildInstruction(signal(3, 40), cfg, 20, false, { sizePct: 40 } as never, '自检');
  assert.equal(watch.action, '观望');
  assert.equal(watch.sizePct, 0, '观望时仓位必须是 0，带着数字会被读成可以买');
  assert.equal(watch.totalAfterPct, 20, '没建仓，总仓应保持为已建的 20%');
}

// ===== 4. 总仓上限护栏仍然生效，且用的是同一个记账口径 =====
//
// 已建 60%，第三层再要 40% → 100% 超过上限 90%。
// 护栏必须按记账那个数拦，而不是按模型可能给的小一点的数放行。
{
  const over = __test__buildInstruction(signal(3, 40), cfg, 60, true, {}, '自检');
  assert.ok(
    over.totalAfterPct != null && over.totalAfterPct <= cfg.maxTotalPct,
    `总仓预计 ${over.totalAfterPct}% 不得超过上限 ${cfg.maxTotalPct}%`,
  );
  assert.ok(
    over.guardrailNote != null,
    '被护栏改过就要留一句说明，否则使用者不知道为什么数变小了',
  );
}

console.log('layerLedger.selfcheck 全部通过');
