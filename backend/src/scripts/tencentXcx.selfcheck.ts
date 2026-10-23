import assert from 'node:assert/strict';
import {
  buildTencentXcxUrl,
  toTencentXcxBar,
  toTencentXcxCode,
} from '../market/tencent';

/** 固定时钟下签名、代码转换与成交量换算的离线自检。 */
function selfcheck(): void {
  const url = new URL(
    buildTencentXcxUrl(
      '/cgi/cgi-bin/stockinfoquery/kline/app/get',
      { code: 'sh600519', ktype: 'day', limit: 2 },
      1_700_000_000_123,
    ),
  );
  assert.equal(url.searchParams.get('x-sa-sign'), 'e7596fac7e4f7d30cc7398ca493de4ee');
  assert.equal(url.searchParams.get('x-timestamp'), '1700000000');
  assert.equal(toTencentXcxCode('600519'), 'sh600519');
  assert.equal(toTencentXcxCode('113050'), 'sh113050');
  assert.equal(toTencentXcxCode('920001'), null);
  assert.equal(toTencentXcxCode('', '90.BK0428'), null);
  assert.equal(toTencentXcxCode('0475.BK'), 'pt0475');
  assert.equal(toTencentXcxCode('', '116.01810'), 'hk01810');
  assert.equal(toTencentXcxCode('', '0.920001'), null);
  assert.deepEqual(
    toTencentXcxBar(
      { date: '2026-10-20', open: '10', last: '11', high: '12', low: '9', volume: '12300', amount: '456000' },
      { minute: false, volumeInShares: true },
    ),
    { time: '2026-10-20', open: 10, close: 11, high: 12, low: 9, volume: 123, amount: 456000 },
  );
  assert.deepEqual(
    toTencentXcxBar(
      { date: '202610231500', open: '10', last: '11', high: '12', low: '9', volume: '2061', amount: '274000' },
      { minute: true, volumeInShares: false },
    ),
    { time: '2026-10-23 15:00', open: 10, close: 11, high: 12, low: 9, volume: 2061, amount: 274000 },
  );
}

selfcheck();
console.log('tencent xcx selfcheck ok');
