// Phase 0 追加实测：第一轮出现两个「结论会改变设计」的点，单独深挖。
// 1) 财报预约披露日是否真含未来日期（决定事件日历进 MVP 还是增强项）
// 2) ETF→跟踪指数代码能否自动解析（成分数据本身已验证可用，只缺这层映射）
// 只读探测。运行：cd backend && pnpm exec tsx src/scripts/symbolPlanCapability.probe2.ts
import { callAkshare } from '../market/akshare';

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
console.log(`今日（上海）：${today}\n`);

/** 打印结果的前若干行，便于人工确认字段名 */
function preview(res: unknown, n = 3): string {
  const data = (res as { data?: unknown })?.data ?? res;
  if (Array.isArray(data)) return JSON.stringify(data.slice(0, n), null, 1).slice(0, 1200);
  return JSON.stringify(data).slice(0, 1200);
}

function rowsOf(res: unknown): Record<string, unknown>[] {
  const data = (res as { data?: unknown })?.data ?? res;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

// ===== 1. 财报预约披露日 =====

console.log('--- 1. 财报预约披露日 ---');
const disclosureCandidates: Array<[string, Record<string, string>]> = [
  ['stock_report_disclosure', { market: 'sse', period: '2026年报' }],
  ['stock_report_disclosure', { market: 'szse', period: '2026半年报' }],
  ['stock_zh_a_disclosure_report_cninfo', { symbol: '600519', market: '沪深京', start_date: '20260101', end_date: '20261231' }],
];
for (const [fn, params] of disclosureCandidates) {
  try {
    const res = await callAkshare(fn, params, undefined, 'akshare', 30_000, 1);
    const rows = rowsOf(res);
    // 找出所有形似日期的字段值，判断是否有未来日期
    const futureHits: string[] = [];
    for (const r of rows.slice(0, 500)) {
      for (const [k, v] of Object.entries(r)) {
        const s = String(v ?? '');
        const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
        if (m) {
          const iso = `${m[1]}-${m[2]}-${m[3]}`;
          if (iso > today) futureHits.push(`${k}=${iso}`);
        }
      }
    }
    console.log(
      `[${fn}] ${JSON.stringify(params)} → ${rows.length} 行，未来日期命中 ${futureHits.length} 个` +
        (futureHits.length ? `（样例 ${futureHits.slice(0, 3).join(', ')}）` : ''),
    );
    if (rows.length > 0) console.log('  字段样例:', preview(res, 1));
  } catch (e) {
    console.log(`[${fn}] 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ===== 2. ETF→跟踪指数代码 =====

console.log('\n--- 2. ETF→跟踪指数代码 ---');
const ETFS = ['159516', '513180', '159740'];
const mappingCandidates: Array<[string, (code: string) => Record<string, string>]> = [
  ['fund_etf_basic_info_em', () => ({})],
  ['fund_individual_basic_info_xq', (c) => ({ symbol: c })],
  ['fund_etf_fund_info_em', (c) => ({ fund: c })],
];
for (const [fn, mk] of mappingCandidates) {
  for (const code of ETFS) {
    try {
      const res = await callAkshare(fn, mk(code), undefined, 'akshare', 30_000, 1);
      const text = JSON.stringify(res);
      const hasIndex = /跟踪指数|标的指数|指数代码|index_code|业绩比较基准/i.test(text);
      console.log(
        `[${fn}] ${code} → ${rowsOf(res).length} 行，含指数线索: ${hasIndex ? '是' : '否'}`,
      );
      if (hasIndex) {
        // 摘出含「指数」的键值，人工确认可解析性
        const rows = rowsOf(res);
        for (const r of rows.slice(0, 40)) {
          for (const [k, v] of Object.entries(r)) {
            if (/指数|基准|index/i.test(k) || /指数/.test(String(v ?? ''))) {
              console.log(`    ${k} = ${String(v).slice(0, 90)}`);
            }
          }
        }
      }
      if (hasIndex) break; // 该函数已验证可行，不必再试其他 code
    } catch (e) {
      console.log(`[${fn}] ${code} 失败：${e instanceof Error ? e.message.slice(0, 70) : String(e)}`);
      break; // 函数本身不可用，换下一个
    }
  }
}

console.log('\n--- 结论待人工判读上面字段名 ---');
