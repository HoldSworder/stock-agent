// 首板赚钱效应（883994）总览自检（无框架，assert 断言，全程合成序列不触网）。
// 盯住两件曾经出错的事：数据不足时不得编造 MA10/斜率；数据陈旧时必须显式标降级。
// 运行：cd backend && pnpm exec tsx src/scripts/moneyEffect.selfcheck.ts
import assert from 'node:assert/strict';
import { composeMoneyEffectOverview, isStaleTradeDate } from '../moneyeffect/service';
import { replaySignals } from '../strategy/shadowReplay';
import type { MoneyEffectBar } from '../strategy/moneyEffectSignal';

/** 合成升序日线：从 2026-06-01 起逐个自然日（是否交易日不影响本组断言） */
function series(closes: number[]): MoneyEffectBar[] {
  return closes.map((close, i) => ({
    date: `2026-06-${String(i + 1).padStart(2, '0')}`,
    close,
  }));
}

// ===== 1. 序列不足 10 根一律抛错，绝不拿 3 根的均值冒充 MA10 =====
for (const n of [2, 3, 9]) {
  assert.throws(
    () => composeMoneyEffectOverview(series(Array.from({ length: n }, (_, i) => 100 + i))),
    /数据不足/,
    `${n} 根序列应报错而不是给出 MA10`,
  );
}

// ===== 2. 数据不足时不得把信号推向「升温」 =====
// 修复前 ma5SlopeUp 在不足 6 根时硬编码 true，一路下跌的序列也能判成升温。
// 现在这类序列根本进不了组装环节（上一组已断言抛错），够长时必须如实判退潮。
{
  const falling = composeMoneyEffectOverview(series([120, 118, 116, 114, 112, 110, 108, 106, 104, 102]));
  assert.equal(falling.ma5SlopeUp, false, '一路下跌的 MA5 不应判为向上');
  assert.equal(falling.signal, '退潮', '下跌序列必须判退潮');
}

// ===== 3. 正常序列的口径可手算复现 =====
{
  const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 110];
  const ov = composeMoneyEffectOverview(series(closes));
  assert.equal(ov.tradeDate, '2026-06-10', 'tradeDate 应取最新一根');
  assert.equal(ov.close, 110);
  assert.equal(ov.prevClose, 108);
  assert.equal(ov.ma5, (106 + 107 + 108 + 110 + 105) / 5, 'MA5 = 末 5 根均值');
  assert.equal(ov.ma10, closes.reduce((a, b) => a + b, 0) / 10, 'MA10 = 末 10 根均值');
  assert.equal(ov.aboveMa5, true);
  assert.equal(ov.ma5SlopeUp, true);
  assert.equal(ov.signal, '升温');
}

// ===== 4. stale 必须按交易日历判定，不能恒为 false =====
// ttlCache 的 serve-stale-on-error 会在上游失败时静默回退旧值，
// 只有比对交易日历才能让 formatMoneyEffectForAgent 的「数据降级」分支真的触发。
{
  const stale = composeMoneyEffectOverview(
    series([100, 101, 102, 103, 104, 105, 106, 107, 108, 110]),
    new Date('2026-07-20T08:00:00Z'), // 上海 16:00，距序列末日 2026-06-10 已一个多月
  );
  assert.equal(stale.stale, true, '一个多月前的数据必须标记降级');

  // 周一 15:30（上海）取到上周五的数据 → 今日收盘后仍缺当日，判降级
  assert.equal(
    isStaleTradeDate('2026-07-17', new Date('2026-07-20T07:30:00Z')),
    true,
    '交易日收盘后仍是上一交易日的数据应判降级',
  );
  // 同一个周一但盘中 10:00：当日日线尚未定盘，上周五的数据是正常的
  assert.equal(
    isStaleTradeDate('2026-07-17', new Date('2026-07-20T02:00:00Z')),
    false,
    '盘中不应要求已有当日收盘数据',
  );
  // 周六：最近应有数据的交易日仍是周五
  assert.equal(
    isStaleTradeDate('2026-07-17', new Date('2026-07-18T08:00:00Z')),
    false,
    '周末不应把周五的数据判成降级',
  );
}

// ===== 5. 影子盘重放：883994 取不到时整轮放弃，绝不对历史日期做「默认满仓」兜底 =====
{
  const dates = ['2026-06-08', '2026-06-09', '2026-06-10'];
  assert.equal(
    replaySignals([], dates),
    null,
    '序列不可用必须整轮放弃；默认满仓会把当初正确跳过的历史买单补记进影子盘',
  );

  // 一路下跌 → 各日信号应为 0（空仓不开新仓），而不是被兜底成 1
  const falling = series([120, 118, 116, 114, 112, 110, 108]);
  const plan = replaySignals(falling, dates)!;
  assert.equal(plan.length, dates.length, '每个日期都应给出信号');
  assert.ok(
    plan.every((p) => p.signal === 0),
    '下跌序列的历史日期信号应为 0',
  );
}

console.log('✅ 首板赚钱效应总览自检通过');
