// 「止损未执行」窗口下界自检（无框架，assert 断言）。跑在临时 sqlite 上，不碰真实库。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/disciplineStop.selfcheck.ts
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'discipline-selfcheck-'));
process.env.DATABASE_PATH = join(tmpDir, 'test.sqlite');

const { ensureSchema } = await import('../db/migrate');
const { db, schema } = await import('../db/client');
const { getPendingStopMap, isEtfPosition } = await import('../positions/discipline');

ensureSchema();

/** Asia/Shanghai 的 n 天前日期（与 discipline 内部同口径） */
const dayAgo = (n: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
    new Date(Date.now() - n * 86_400_000),
  );

const addEvent = (code: string, date: string): void => {
  db.insert(schema.disciplineEvents)
    .values({
      id: `${code}-${date}`,
      account: 'real',
      code,
      name: code,
      kind: 'stop_loss',
      severity: 'high',
      detail: '触及止损',
      eventDate: date,
      createdAt: new Date().toISOString(),
    })
    .run();
};

// A 标的：90 天前触发过止损（已卖出），上周才重新建仓（holdDays=5）→ 旧事件不得被翻出来
addEvent('600000', dayAgo(90));
// B 标的：3 天前触发止损且一直持有（holdDays=30）→ 必须报出
addEvent('600001', dayAgo(3));
addEvent('600001', dayAgo(2)); // 同轮多次触发时取最早那次，体现拖了多久
// C 标的：今天刚触发 → 属正常待执行，不算未执行
addEvent('600002', dayAgo(0));

const map = getPendingStopMap([
  { code: '600000', holdDays: 5 },
  { code: '600001', holdDays: 30 },
  { code: '600002', holdDays: 10 },
]);

assert.equal(map.has('600000'), false, '上一轮持仓期的止损事件不得算作本轮未执行');
assert.equal(map.get('600001'), dayAgo(3), '本轮内应取最早一次提示日期');
assert.equal(map.has('600002'), false, '当天刚触发的止损属正常待执行');
assert.equal(map.has('600003'), false, '非持仓标的不应出现');

// 建仓日下界随 holdDays 放宽：同一标的若已持有很久，旧事件就确实属于本轮
const longHold = getPendingStopMap([{ code: '600000', holdDays: 200 }]);
assert.equal(longHold.get('600000'), dayAgo(90), '长期持仓时窗口内的事件应报出');

// ETF 口径只认 15xxxx 与 5xxxxx：放宽成 1xxxxx 会把可转债（沪 110/113、深 123/127）
// 划进 ETF，套上 12% 止损与 40% 单票上限，而可转债日内波动远大于 ETF，等于放松风控
assert.equal(isEtfPosition('512880', '证券ETF'), true, '沪市六位 ETF 必须命中');
assert.equal(isEtfPosition('588000', '科创50'), true, '名称不带 ETF 的沪市基金同样按代码命中');
assert.equal(isEtfPosition('159915', '创业板'), true, '深市 15 开头 ETF 必须命中');
assert.equal(isEtfPosition('113050', '南银转债'), false, '沪市可转债不得按 ETF 放宽风控');
assert.equal(isEtfPosition('123123', '某某转债'), false, '深市可转债不得按 ETF 放宽风控');
assert.equal(isEtfPosition('110059', '浦发转债'), false, '110 开头可转债同样不得命中');

rmSync(tmpDir, { recursive: true, force: true });
console.log('✅ 止损未执行窗口自检通过：建仓日下界 / 本轮最早一次 / 当日不计 / ETF 口径不含可转债');
