// 前向晋级门自检（无框架，assert 断言）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/promotionGate.selfcheck.ts
import assert from 'node:assert/strict';
import {
  effectiveClusterCount,
  evaluatePromotionGate,
  multipleTestingPenaltyPct,
  wilsonLowerBound,
  type GateTrade,
} from '../strategy/promotionGate';

// 1. Wilson 下界远低于点胜率：30 笔 60% 胜率的 95% 下界约 42%，说明 30 笔根本不够定论
const w = wilsonLowerBound(18, 30)!;
assert.ok(w > 0.4 && w < 0.45, `30笔60%胜率的 Wilson 下界应在 42% 附近，实际 ${(w * 100).toFixed(1)}%`);
assert.ok(wilsonLowerBound(180, 300)! > 0.54, '同样 60% 胜率、样本放大 10 倍后下界应显著抬升');
assert.equal(wilsonLowerBound(0, 0), null, '零样本不应给出下界');

// 2. 有效簇数：同日批量交易不重复计数
const sameDay: GateTrade[] = Array.from({ length: 10 }, () => ({
  entryDate: '2026-05-06',
  sector: '半导体',
  netPnl: 100,
}));
assert.equal(effectiveClusterCount(sameDay), 1, '同日同板块的 10 笔应只算 1 个有效簇');

const spread: GateTrade[] = Array.from({ length: 10 }, (_, i) => ({
  entryDate: `2026-05-${String(i + 1).padStart(2, '0')}`,
  sector: '半导体',
  netPnl: 100,
}));
assert.equal(effectiveClusterCount(spread), 10, '分散在 10 天的 10 笔应算 10 个有效簇');

// 3. 多重检验惩罚随变体数上升且封顶
assert.equal(multipleTestingPenaltyPct(1), 0, '单变体不惩罚');
assert.ok(multipleTestingPenaltyPct(30) > 0, '30 个变体应有惩罚');
assert.ok(
  multipleTestingPenaltyPct(1000) <= 15,
  '惩罚需封顶，否则变体一多门槛会高到不可能通过',
);

// 4. 漂亮但样本不足的策略：10 笔全赢也不该通过
const tiny: GateTrade[] = Array.from({ length: 10 }, (_, i) => ({
  entryDate: `2026-05-${String(i + 1).padStart(2, '0')}`,
  sector: null,
  netPnl: 500,
}));
const tinyGate = evaluatePromotionGate(tiny, 0);
assert.equal(tinyGate.passed, false, '10 笔样本不得通过晋级门');
assert.equal(tinyGate.checks.find((c) => c.key === 'trades')!.passed, false);

// 5. 同日批量刷出来的「大样本」：60 笔但都挤在 2 天 → 簇数不足，拦下
const batched: GateTrade[] = Array.from({ length: 60 }, (_, i) => ({
  entryDate: i < 30 ? '2026-05-06' : '2026-05-07',
  sector: '半导体',
  netPnl: 500,
}));
const batchedGate = evaluatePromotionGate(batched, 0);
assert.equal(batchedGate.trades, 60, '笔数达标');
assert.ok(batchedGate.effectiveClusters < 5, '挤在 2 天的批量交易有效簇数应极低');
assert.equal(batchedGate.passed, false, '同日批量交易不得冒充独立样本通过晋级门');

// 6. 真正合格的样本：40 天分散、70% 胜率、费后为正 → 通过
const good: GateTrade[] = Array.from({ length: 40 }, (_, i) => ({
  entryDate: `2026-0${1 + Math.floor(i / 20)}-${String((i % 20) + 1).padStart(2, '0')}`,
  sector: null,
  netPnl: i % 10 < 7 ? 800 : -300,
}));
const goodGate = evaluatePromotionGate(good, 0);
assert.equal(goodGate.passed, true, `分散且高胜率的样本应通过，未过项：${goodGate.checks.filter((c) => !c.passed).map((c) => c.key).join(',')}`);

// 7. 同一份样本，申报是从 50 个变体里挑出来的 → 门槛抬高后不再通过
const searched = evaluatePromotionGate(good, 50);
assert.ok(searched.requiredWinLowerPct > 50, '申报变体后胜率下界要求应高于 50%');
assert.equal(
  searched.passed,
  false,
  '从 50 个变体里挑出的最优解必须扛得住更高门槛，否则就是扫参扫出来的噪声',
);

console.log('✅ 前向晋级门自检通过');
