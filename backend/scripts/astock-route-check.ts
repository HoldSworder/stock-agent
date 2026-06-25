// 校验 K线 period-aware 路由命中源：分钟线应首选 mootdx(astockdata)，日线应首选前复权源(tencent)。
// 用 Node 22 跑：PATH=...nvm/.../v22.12.0/bin:$PATH pnpm exec tsx scripts/astock-route-check.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'astock-route-')), 'test.sqlite');
process.env.TZ = 'Asia/Shanghai';

const { ensureSchema } = await import('../src/db/migrate');
const { setValue } = await import('../src/settings');
const { getKline, getRoutes } = await import('../src/datasource/scheduler');

ensureSchema();
setValue('astockBaseUrl', process.env.BASE || 'http://192.168.31.144:9119');

async function probe(period: string) {
  const bars = await getKline('159516', period as never, 48);
  const served = getRoutes().find((r) => r.capability === 'kline')?.lastServed;
  const days = new Set(bars.map((b) => b.time.slice(0, 10))).size;
  const last = bars[bars.length - 1];
  const bad = bars.filter((b) => b.close <= 0).length;
  console.log(
    `${period.padEnd(4)} → 命中源=${String(served).padEnd(11)} ${bars.length}根/${days}天 末${last?.time}=${last?.close} 无效0收盘=${bad}`,
  );
}

console.log('\n=== K线 period-aware 路由命中校验 (159516 半导体设备ETF) ===');
await probe('30m');
await probe('day');
console.log('期望：30m→astockdata(mootdx 不封IP，前复权后无 0 收盘)；day→tencent(前复权源)\n');
process.exit(0);
