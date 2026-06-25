// a-stock-data 接入集成测试：用真实后端模块（client/market/providers）打通线上 NAS sidecar。
// 用临时 SQLite，避免污染开发库；只读取数据、不写业务表。
// 运行：BASE=http://192.168.31.144:9119 npx tsx scripts/astock-itest.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE?.trim() || 'http://192.168.31.144:9119';
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'astock-itest-')), 'test.sqlite');
process.env.TZ = 'Asia/Shanghai';

const { ensureSchema } = await import('../src/db/migrate');
const { setValue } = await import('../src/settings');
const { pingAstock, callAstock, getAstockManifest } = await import('../src/astock/client');
const { getKlineAstock, getQuotesAstock } = await import('../src/astock/market');

ensureSchema();
setValue('astockBaseUrl', BASE);

let pass = 0;
let fail = 0;
const t0 = Date.now();

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const s = Date.now();
  try {
    const detail = await fn();
    pass++;
    console.log(`✅ ${name}  (${Date.now() - s}ms)  ${detail}`);
  } catch (e) {
    fail++;
    console.log(`❌ ${name}  (${Date.now() - s}ms)  ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n=== a-stock-data 接入集成测试 → ${BASE} ===\n`);

await check('pingAstock 健康探测', async () => {
  await pingAstock();
  return 'sidecar 在线 + mootdx 探活通过';
});

await check('getKlineAstock 日线(600519)', async () => {
  const bars = await getKlineAstock('600519', 'day', 60);
  if (bars.length < 5) throw new Error(`bar 数偏少: ${bars.length}`);
  const last = bars[bars.length - 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last.time)) throw new Error(`日线 time 格式异常: ${last.time}`);
  if (!(last.close > 0)) throw new Error('close<=0');
  return `${bars.length} 根, 末根 ${last.time} close=${last.close}`;
});

await check('getKlineAstock 30分钟线(600519) 确为分钟粒度', async () => {
  const bars = await getKlineAstock('600519', '30m', 48);
  if (bars.length < 5) throw new Error(`bar 数偏少: ${bars.length}`);
  const last = bars[bars.length - 1];
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(last.time)) throw new Error(`30m time 未保留时分: ${last.time}`);
  const times = new Set(bars.map((b) => b.time));
  if (times.size !== bars.length) throw new Error(`分钟 time 有重复(被折叠): ${bars.length}→${times.size}`);
  // 关键：必须是真·分钟粒度而非「日线贴 15:00」。48 根 30m 应跨 ~6 个交易日，
  // 即同一交易日内有多根 bar → 唯一日期数应远小于 bar 数（旧 bug：每根一天且都 15:00）。
  const days = new Set(bars.map((b) => b.time.slice(0, 10)));
  if (days.size >= bars.length) throw new Error(`疑似日线伪装分钟(每根一天): ${bars.length}根/${days.size}天`);
  const intradayTimes = new Set(bars.map((b) => b.time.slice(11)));
  if (intradayTimes.size < 2) throw new Error(`日内时刻只有 ${intradayTimes.size} 种(应有 10:00/10:30...)`);
  return `${bars.length} 根 / ${days.size} 天, 日内时刻 ${intradayTimes.size} 种, 末根 ${last.time}`;
});

await check('getKlineAstock ETF 30分钟线(159516 半导体设备)', async () => {
  const bars = await getKlineAstock('159516', '30m', 48);
  if (bars.length < 5) throw new Error(`bar 数偏少: ${bars.length}`);
  const last = bars[bars.length - 1];
  return `${bars.length} 根, 末根 ${last.time} close=${last.close}`;
});

await check('getQuotesAstock 多只(600519,159516)', async () => {
  const qs = await getQuotesAstock(['600519', '159516']);
  if (qs.length === 0) throw new Error('无报价');
  return qs.map((q) => `${q.code}=${q.price}(${q.pct.toFixed(2)}%)`).join(' ');
});

await check('callAstock(eastmoney_reports 600519 个股研报)', async () => {
  const r = (await callAstock('eastmoney_reports', { code: '600519' })) as unknown[];
  if (!Array.isArray(r)) throw new Error('非数组');
  return `${r.length} 条研报`;
});

await check('callAstock(ths_eps_forecast 600519 一致预期)', async () => {
  const r = (await callAstock('ths_eps_forecast', { code: '600519' })) as unknown[];
  return `${Array.isArray(r) ? r.length : 'obj'} 条预期`;
});

await check('callAstock(hsgt_realtime 北向实时)', async () => {
  const r = (await callAstock('hsgt_realtime')) as unknown[];
  if (!Array.isArray(r) || r.length === 0) throw new Error('无数据');
  return `${r.length} 个时点`;
});

await check('callAstock(cninfo_announcements 600519 巨潮公告)', async () => {
  const r = (await callAstock('cninfo_announcements', { code: '600519' })) as unknown[];
  return `${Array.isArray(r) ? r.length : 'obj'} 条公告`;
});

await check('getAstockManifest 端点目录', async () => {
  const m = (await getAstockManifest()) as { endpoints?: unknown[]; total?: number };
  const n = m.total ?? (Array.isArray(m.endpoints) ? m.endpoints.length : 0);
  if (!n) throw new Error('目录为空');
  return `${n} 个端点`;
});

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s ===\n`);
process.exit(fail > 0 ? 1 : 0);
