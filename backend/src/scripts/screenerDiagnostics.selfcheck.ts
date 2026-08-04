// 选股漏斗诊断自检（无框架，assert 断言）。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/screenerDiagnostics.selfcheck.ts
import assert from 'node:assert/strict';
import { buildFunnelDiagnostics } from '../screener/diagnostics';
import type { SnapshotRow } from '../screener/snapshot';

function row(over: Partial<SnapshotRow> & { code: string; name: string }): SnapshotRow {
  return {
    price: 10,
    pct: 1,
    amount: 5,
    turnoverRate: 3,
    volumeRatio: 1,
    pe: 30,
    pb: 3,
    marketCap: 200,
    industry: '半导体',
    ...over,
  } as SnapshotRow;
}

const rows: SnapshotRow[] = [
  row({ code: '600001', name: '全通过' }),
  row({ code: '600002', name: '成交额差一点', amount: 1.8 }), // 仅卡成交额（门槛 2）
  row({ code: '600003', name: '成交额差很多', amount: 0.2 }),
  row({ code: '600004', name: '两项都卡', amount: 0.5, pe: 200 }),
  row({ code: '688001', name: '科创板' }), // 可交易性直接剔除
  row({ code: '600005', name: 'ST某某' }), // 名称含 ST，剔除
];

const d = buildFunnelDiagnostics(rows, { amountMinYi: 2, peMax: 100 }, 1);

// 1. 可交易性过滤先生效：科创板与 ST 不进后续统计
assert.equal(d.marketCount, 6);
assert.equal(d.tradableCount, 4, '科创板与 ST 应在可交易性阶段被剔除');

// 2. 各条门槛的拦截数与「仅此条拦住」
const amountStat = d.filters.find((f) => f.key === 'amountMinYi')!;
assert.equal(amountStat.rejected, 3, '成交额门槛应拦下 3 只');
assert.equal(amountStat.soleRejected, 2, '其中 2 只只卡成交额（另一只还同时卡 PE）');
const peStat = d.filters.find((f) => f.key === 'peMax')!;
assert.equal(peStat.soleRejected, 0, '卡 PE 的那只同时也卡成交额，放宽 PE 救不回来');

// 3. 敏感性：放宽成交额门槛后候选数应单调不减
const amountSens = d.sensitivity.find((s) => s.key === 'amountMinYi')!;
const counts = amountSens.points.map((p) => p.count);
for (let i = 1; i < counts.length; i += 1) {
  assert.ok(counts[i] >= counts[i - 1], `放宽档位的候选数不应减少：${counts.join(',')}`);
}
assert.equal(
  amountSens.points.find((p) => p.delta === 0)!.count,
  1,
  '当前档位应与实际通过数一致',
);

// 4. 差一点入选：只列「恰好卡一条」的，按差距升序，且不含数据缺失项
assert.deepEqual(
  d.nearMisses.map((n) => n.code),
  ['600002', '600003'],
  '只应列出仅被一条门槛拦住的标的，且按差距升序',
);
assert.equal(d.nearMisses[0].failedKey, 'amountMinYi');
assert.equal(d.nearMisses[0].gapPct, 10, '1.8 距门槛 2 差 10%');

// 5. 负门槛的方向必须正确：pctMin = -3 时「放宽 25%」应得 -3.75（更松），而不是 -2.25（更紧）
{
  const pctRows: SnapshotRow[] = [
    row({ code: '600011', name: '跌2.5%', pct: -2.5 }),
    row({ code: '600012', name: '跌3.5%', pct: -3.5 }),
    row({ code: '600013', name: '跌4.5%', pct: -4.5 }),
  ];
  const dp = buildFunnelDiagnostics(pctRows, { pctMin: -3 }, 1);
  const pts = dp.sensitivity.find((s) => s.key === 'pctMin')!.points;
  const at = (delta: number) => pts.find((p) => p.delta === delta)!.count;
  assert.equal(at(0), 1, '当前档位只有跌 2.5% 的通过');
  assert.equal(at(0.25), 2, '放宽 25% → 门槛 -3.75，应多救回跌 3.5% 的那只');
  assert.equal(at(-0.25), 0, '收紧 25% → 门槛 -2.25，跌 2.5% 的那只也被刷掉');
  for (let i = 1; i < pts.length; i += 1) {
    assert.ok(pts[i].count >= pts[i - 1].count, '负门槛下放宽档位的候选数同样不应减少');
  }
}

// 6. 门槛为 0 时相对缩放恒等于 0，必须显式标注不可扫描，而不是输出六个相同的数
{
  const d0 = buildFunnelDiagnostics([row({ code: '600021', name: '平盘', pct: 0 })], { pctMin: 0 }, 1);
  const s0 = d0.sensitivity.find((s) => s.key === 'pctMin')!;
  assert.equal(s0.points.length, 0, '门槛为 0 不应给出相对扫描结果');
  assert.ok(s0.note?.includes('无法'), '应说明为什么扫不了');
}

// 7. 纪律说明必须随诊断一起返回（这是允许做敏感性分析的前提）
assert.ok(d.note.includes('不会自动放宽'), '诊断必须显式声明不自动放宽生产门槛');

console.log('✅ 选股漏斗诊断自检通过');
