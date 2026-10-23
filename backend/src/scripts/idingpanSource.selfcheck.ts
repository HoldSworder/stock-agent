// 爱盯盘缺口接入的纯逻辑自检：换主机顺序、腾讯现价解析、ETF 指数挑选。
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/idingpanSource.selfcheck.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'idingpan-')), 't.sqlite');

const { orderHosts, noteHostFailure } = await import('../datasource/httpClient');
const { parseTencentQuotes, tencentQuoteSymbol } = await import('../market/tencent');
const { pickIndexHit } = await import('../market/etfSelector');

const now = 1_700_000_000_000;
const chain = ['push2.eastmoney.com', 'push2delay.eastmoney.com', 'push2delay2.eastmoney.com'];

// 1. 冷却中的主机放到最后；延迟行情刚成功过，也不能压住仍可用的主站
const cooledPrimary = new Map([
  ['push2delay.eastmoney.com', { fails: 0, coolUntil: 0 }],
  ['push2.eastmoney.com', { fails: 2, coolUntil: now + 60_000 }],
]);
assert.deepEqual(orderHosts(chain, now, cooledPrimary), [
  'push2delay.eastmoney.com',
  'push2delay2.eastmoney.com',
  'push2.eastmoney.com',
]);
const freshDelay = new Map([['push2delay.eastmoney.com', { fails: 0, coolUntil: 0 }]]);
assert.deepEqual(orderHosts(chain, now, freshDelay), chain);

// 2. 连续失败两次才进入 10 分钟冷却
const once = noteHostFailure(undefined, now);
assert.equal(once.fails, 1);
assert.equal(once.coolUntil, 0);
const twice = noteHostFailure(once, now);
assert.equal(twice.fails, 2);
assert.equal(twice.coolUntil, now + 10 * 60_000);

// 3. 腾讯符号：沪市基金用 sh，深市基金用 sz，北交所用 bj
assert.equal(tencentQuoteSymbol('510300'), 'sh510300');
assert.equal(tencentQuoteSymbol('159915'), 'sz159915');
assert.equal(tencentQuoteSymbol('920001'), 'bj920001');
assert.equal(tencentQuoteSymbol('113050'), 'sh113050');

// 4. 腾讯现价文本：成交额从「万」换成「亿」，短行和零价丢掉
const vals = Array.from({ length: 53 }, () => '0');
vals[1] = '沪深300ETF华泰柏瑞';
vals[2] = '510300';
vals[3] = '4.097';
vals[4] = '4.107';
vals[5] = '4.080';
vals[32] = '-0.24';
vals[33] = '4.110';
vals[34] = '4.070';
vals[37] = '123456';
vals[38] = '1.2';
const body = `v_sh510300="${vals.join('~')}";v_sz000001="1~短~000001";`;
const quotes = parseTencentQuotes(body);
assert.equal(quotes.length, 1);
assert.equal(quotes[0].code, '510300');
assert.equal(quotes[0].name, '沪深300ETF华泰柏瑞');
assert.equal(quotes[0].price, 4.097);
assert.equal(quotes[0].amount, 12.3456);
assert.equal(quotes[0].turnoverRate, 1.2);
assert.equal(quotes[0].high, 4.11);

// 5. 同名指数优先 000 开头，并且能对上 K 线用的代码
const picked = pickIndexHit('沪深300', [
  { code: '510300', name: '沪深300ETF华泰柏瑞', classify: 'Fund', quoteId: '1.510300' },
  { code: '399300', name: '沪深300', classify: 'Index', quoteId: '0.399300' },
  { code: '000300', name: '沪深300', classify: 'Index', quoteId: '1.000300' },
]);
assert.equal(picked?.indexCode, '000300');
assert.equal(picked?.secid, '1.000300');
assert.equal(pickIndexHit('没有这个指数', []), null);

console.log('idingpan source selfcheck ok');
