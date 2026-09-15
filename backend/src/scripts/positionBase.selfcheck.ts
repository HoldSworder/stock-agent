// 仓位基数消歧自检（无框架，assert 断言，不联网不碰数据库）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/positionBase.selfcheck.ts
//
// 同一只 ETF 在三个地方各有一个「仓位」百分数，它们回答**三个不同问题**：
//
//   盯盘分层    这只在我的赛道配置里该占多少      基数：未接账户，裸百分比     三层合计 100%
//   标的计划    按单笔最多亏多少反推，最多能持多少  基数：真实账户总资产        主升 40% / 退潮 15%
//   波段试探    在已有仓位之上还能补多少          基数：真实账户总资产        ≤10%，扣掉已持有
//
// 差异本身不是错，**只印一个百分数才是错**——使用者翻页对比会以为系统自相矛盾。
// 盯盘的 100% 与风险预算的 15~40% 是真冲突，尚未裁决（使用者的打法是单仓持有
// 最强主线，所以 100% 是刻意的；分散上限来自机构那套纪律）。裁决之前，
// 每处都必须把基数与档位写在数字旁边。
//
// 这个文件钉的就是「写没写」，不钉数值本身——数值由各自的定版规则决定。

import assert from 'node:assert/strict';
import { __test__formatInstruction } from '../etfwatch/dispatcher';
import { budgetForPhase } from '../positions/riskBudget';
import type { EtfExecInstruction } from '@stock-agent/shared';

// ===== 1. 盯盘推送必须说明那个百分数是「赛道配置」=====
//
// 它是唯一不接账户的那个，最容易被读成「占我账户的 40%，而标的计划说上限 15%，
// 系统疯了吗」。
{
  const ins: EtfExecInstruction = {
    action: '建仓',
    layer: 1,
    entryLow: 0.59,
    entryHigh: 0.61,
    sizePct: 40,
    totalAfterPct: 40,
    stopLoss: 0.55,
    invalidation: '日线收盘跌破 MA20',
    reason: '30分钟金叉',
    guardrailNote: null,
  };
  const text = __test__formatInstruction(ins);

  assert.ok(text.includes('40%'), '该给的数字还是要给');
  assert.ok(
    text.includes('赛道配置'),
    '必须说明这是赛道配置比例——不说的话，使用者会拿它跟标的计划那个「占账户」的上限直接比',
  );
  // 不许出现会被误读成账户占比的说法
  assert.ok(
    !/占账户|账户总资产/.test(text),
    '盯盘不接账户，不得声称这个数是占账户的比例',
  );

  // 观望时不带仓位数（带了会被读成「可以按这个比例买」）
  const watch = __test__formatInstruction({ ...ins, action: '观望', sizePct: 0 });
  assert.ok(!watch.includes('仓位：'), '观望时不该出现仓位那一行');
}

// ===== 2. 风险预算各档的上限差得够大，所以档位必须一起给 =====
//
// 用算术说明为什么档位不能省：同一只 ETF
//   主升档 40%、退潮档 15% —— 差 2.7 倍。
// 只印「上限 15%」而不说是退潮档，使用者会以为系统把他的主线仓位砍了。
{
  const up = budgetForPhase('主升');
  const down = budgetForPhase('退潮');

  assert.ok(
    up.singleMaxEtfPct > down.singleMaxEtfPct * 2,
    `主升档 ${up.singleMaxEtfPct}% 与退潮档 ${down.singleMaxEtfPct}% 差得够大，` +
      '所以界面必须连档位一起显示，否则那个数无法被理解',
  );

  // 阶段取不到时必须回落到偏紧的一档，不许当成主升
  const unknown = budgetForPhase(null);
  assert.ok(
    unknown.singleMaxEtfPct < up.singleMaxEtfPct,
    '行情阶段判不出来时必须按更紧的一档算，不许默认当成主升',
  );
  assert.equal(
    unknown.singleMaxEtfPct,
    budgetForPhase('震荡').singleMaxEtfPct,
    '阶段未知应当回落到震荡档（既有纪律：阶段未知取紧）',
  );
}

// ===== 3. 盯盘与风险预算的冲突确实存在，钉住它的量级 =====
//
// 这一条不是在测代码对不对，是在**防止有人以为这事已经解决了**。
// 若哪天两者被统一，这个断言会失败，届时应当连同 CONTEXT.md 一起改，
// 而不是把断言删掉。
{
  const watchTotalPct = 40 + 40 + 20; // 盯盘三层配置合计（数据库当前值）
  const riskCapUp = budgetForPhase('主升').singleMaxEtfPct;

  assert.ok(
    watchTotalPct > riskCapUp,
    `盯盘允许单只叠到 ${watchTotalPct}%、风险预算主升档只允许 ${riskCapUp}%，` +
      '这个冲突尚未裁决。若两者已统一，请同时更新 CONTEXT.md 的「仓位比例」一节',
  );
}

console.log('positionBase.selfcheck 全部通过');
