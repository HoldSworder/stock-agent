// 持仓快照差分反推成交的自检（无框架，assert 断言；纯计算，不碰 DB/网络）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/positionLedger.selfcheck.ts
//
// 这套反推有明确的天花板，而天花板本身必须被钉住：它在四种情形下给不出唯一答案，
// 此时必须标「说不清」。如果哪天有人把这些分支改成猜一个具体数字，
// 反推出来的账就会冒充精确账——而用错的账去评判策略，比没有账更糟。
import assert from 'node:assert/strict';
import { diffSnapshots, type SnapshotRow } from '../positions/ledger';

const D1 = '2026-09-10';
const D2 = '2026-09-11';

const row = (
  date: string,
  code: string,
  qty: number,
  avgCost: number,
  price = avgCost,
): SnapshotRow => ({ tradeDate: date, code, name: `名称${code}`, qty, avgCost, price });

/** 取某标的的反推结果，断言只产出一条 */
function only(rs: ReturnType<typeof diffSnapshots>, code: string) {
  const hit = rs.filter((r) => r.code === code);
  assert.equal(hit.length, 1, `${code} 应产出恰好一条反推结果，实际 ${hit.length} 条`);
  return hit[0];
}

// ===== 能说清的情形 =====

// 1. 新建仓：之前没有这只
{
  const rs = diffSnapshots([], [row(D2, '159915', 1000, 2.0)]);
  const r = only(rs, '159915');
  assert.equal(r.kind, 'buy');
  assert.equal(r.qty, 1000);
}

// 2. 全部卖出，且券商清仓台账确认。清仓记录是券商给的事实，比差分可靠，
//    有它才敢把「消失」判成卖出
{
  const rs = diffSnapshots([row(D1, '159915', 1000, 2.0)], [], new Set(['159915']));
  const r = only(rs, '159915');
  assert.equal(r.kind, 'sell');
  assert.equal(r.qty, 1000);
}

// 3. 部分减仓：数量减少、成本价不变。这是唯一能确定判为减仓的形态
{
  const rs = diffSnapshots([row(D1, '159915', 1000, 2.0)], [row(D2, '159915', 400, 2.0)]);
  const r = only(rs, '159915');
  assert.equal(r.kind, 'sell');
  assert.equal(r.qty, 600);
}

// 4. 加仓：数量增加且成本价被摊动
{
  const rs = diffSnapshots([row(D1, '159915', 1000, 2.0)], [row(D2, '159915', 2000, 2.3)]);
  const r = only(rs, '159915');
  assert.equal(r.kind, 'buy');
  assert.equal(r.qty, 1000);
}

// 5. 完全没动：不产出任何记录，不能刷出一堆空条目
{
  const rs = diffSnapshots([row(D1, '159915', 1000, 2.0)], [row(D2, '159915', 1000, 2.0, 2.4)]);
  assert.equal(
    rs.filter((r) => r.code === '159915').length,
    0,
    '数量与成本都没变时不得产出记录（价格涨跌不是成交）',
  );
}

// ===== 四种必须判「说不清」的情形 =====

// 6. 标的消失但没有清仓记录：可能是清仓，也可能是当天没同步到这只
{
  const rs = diffSnapshots([row(D1, '159915', 1000, 2.0)], []);
  const r = only(rs, '159915');
  assert.equal(r.kind, 'unknown', '没有清仓记录时不得断言已卖出');
}

// 7. 分红送股：数量凭空增加而成本价没动，不是买入
{
  const rs = diffSnapshots([row(D1, '159915', 1000, 2.0)], [row(D2, '159915', 1100, 2.0)]);
  const r = only(rs, '159915');
  assert.equal(r.kind, 'unknown', '数量增加但成本未变，像送股，不得判为买入');
}

// 8. 数量没变但成本价变了：同日买卖抵消、或分红除权，说不清
{
  const rs = diffSnapshots([row(D1, '159915', 1000, 2.0)], [row(D2, '159915', 1000, 1.8)]);
  const r = only(rs, '159915');
  assert.equal(r.kind, 'unknown', '数量未变而成本变动必须判为说不清');
}

// 9. 减仓同时成本价也变了：期间还有别的动作，卖了多少说不清
{
  const rs = diffSnapshots([row(D1, '159915', 1000, 2.0)], [row(D2, '159915', 400, 1.7)]);
  const r = only(rs, '159915');
  assert.equal(r.kind, 'unknown', '数量减少且成本变动时不得给出精确卖出量');
}

// ===== 边界 =====

// 10. 浮点与券商四舍五入不能被当成成交
{
  const rs = diffSnapshots(
    [row(D1, '159915', 1000, 2.0)],
    [row(D2, '159915', 1000.0000001, 2.0000001)],
  );
  assert.equal(rs.filter((r) => r.code === '159915').length, 0, '微小浮点差不得判为成交');
}

// 11. 多标的同时变动：各自独立判定，互不影响
{
  const rs = diffSnapshots(
    [row(D1, '159915', 1000, 2.0), row(D1, '512880', 500, 1.0)],
    [row(D2, '159915', 400, 2.0), row(D2, '588000', 300, 1.5)],
    new Set(['512880']),
  );
  assert.equal(only(rs, '159915').kind, 'sell');
  assert.equal(only(rs, '512880').kind, 'sell');
  assert.equal(only(rs, '588000').kind, 'buy');
}

console.log(
  '✅ 持仓快照差分自检通过：减仓/加仓/新建仓可判，' +
    '送股、同日抵消、减仓改成本、无清仓记录四种情形一律判说不清',
);
