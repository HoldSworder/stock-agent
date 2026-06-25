// 数据源稳定性/速度基准：在 stock-agent 容器内跑（生产网络出口，含 31 子网东财封禁路径）。
// 对比 K线(day/30m) 与 报价 各上游源的延迟与成功率。无第三方依赖，仅用 global fetch。
// 用法（NAS）：docker exec -i stock-agent node < datasource-bench.mjs
const ASTOCK = process.env.ASTOCK || 'http://192.168.31.144:9119';
const N = Number(process.env.N || 4);
const CODES = [
  { code: '600519', secid: '1.600519', tx: 'sh600519', name: '茅台' },
  { code: '159516', secid: '0.159516', tx: 'sz159516', name: '半导体设备ETF' },
];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const EM_H = { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' };
const TX_H = { Referer: 'https://gu.qq.com/' };

async function timed(fn, timeoutMs = 12000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  const t = Date.now();
  try {
    const ok = await fn(ac.signal);
    return { ms: Date.now() - t, ok: ok === true, err: ok === true ? '' : 'empty/invalid' };
  } catch (e) {
    return { ms: Date.now() - t, ok: false, err: (e && e.message) || String(e) };
  } finally {
    clearTimeout(to);
  }
}

async function jget(url, headers, signal) {
  const r = await fetch(url, { headers, signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ---- providers: 返回 true 表示拿到有效数据 ----
const PROVIDERS = {
  kline: {
    'eastmoney(push2his)': async (c, klt, signal) => {
      const j = await jget(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${c.secid}&klt=${klt}&fqt=1&end=20500101&lmt=48&fields1=f1&fields2=f51,f52,f53,f54,f55,f56,f57`, EM_H, signal);
      return Array.isArray(j?.data?.klines) && j.data.klines.length > 0;
    },
    'tencent': async (c, klt, signal) => {
      if (klt === 101) {
        const j = await jget(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${c.tx},day,,,48,qfq`, TX_H, signal);
        const node = j?.data?.[c.tx];
        return Array.isArray(node?.qfqday) || Array.isArray(node?.day);
      }
      const m = klt === 30 ? 'm30' : 'm' + klt;
      const j = await jget(`https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${c.tx},${m},,48`, TX_H, signal);
      return Array.isArray(j?.data?.[c.tx]?.[m]);
    },
    'astock(mootdx)': async (c, klt, signal) => {
      const cat = klt === 101 ? 4 : klt === 30 ? 10 : klt === 60 ? 11 : klt === 15 ? 9 : 8;
      const j = await jget(`${ASTOCK}/api/call/mootdx_kline?symbol=${c.code}&category=${cat}&offset=48`, {}, signal);
      return Array.isArray(j) && j.length > 0;
    },
  },
  quote: {
    'eastmoney(push2)': async (secids, signal) => {
      const j = await jget(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f6,f8,f12,f14,f18&secids=${secids}`, EM_H, signal);
      const d = j?.data?.diff;
      return d != null && (Array.isArray(d) ? d.length > 0 : Object.keys(d).length > 0);
    },
    'eastmoney(push2delay)': async (secids, signal) => {
      const j = await jget(`https://push2delay.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f6,f8,f12,f14,f18&secids=${secids}`, EM_H, signal);
      const d = j?.data?.diff;
      return d != null && (Array.isArray(d) ? d.length > 0 : Object.keys(d).length > 0);
    },
    'astock(mootdx)': async (secids, signal) => {
      const codes = secids.split(',').map((s) => s.split('.')[1]).join(',');
      const j = await jget(`${ASTOCK}/api/call/mootdx_quote?symbols=${codes}`, {}, signal);
      return Array.isArray(j) && j.length > 0;
    },
  },
};

function stat(rs) {
  const oks = rs.filter((r) => r.ok);
  const okMs = oks.map((r) => r.ms);
  const avg = okMs.length ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : 0;
  const min = okMs.length ? Math.min(...okMs) : 0;
  const max = okMs.length ? Math.max(...okMs) : 0;
  const errs = [...new Set(rs.filter((r) => !r.ok).map((r) => r.err))].slice(0, 2).join(' | ');
  return { rate: `${oks.length}/${rs.length}`, avg, min, max, errs };
}

async function runKline(label, klt) {
  console.log(`\n## K线 ${label}`);
  console.log('源'.padEnd(24), '成功率'.padEnd(8), 'avg'.padEnd(7), 'min'.padEnd(7), 'max'.padEnd(7), '错误');
  for (const [name, fn] of Object.entries(PROVIDERS.kline)) {
    const rs = [];
    for (let i = 0; i < N; i++) {
      for (const c of CODES) rs.push(await timed((s) => fn(c, klt, s)));
    }
    const st = stat(rs);
    console.log(name.padEnd(24), st.rate.padEnd(8), String(st.avg + 'ms').padEnd(7), String(st.min + 'ms').padEnd(7), String(st.max + 'ms').padEnd(7), st.errs);
  }
}

async function runQuote() {
  console.log(`\n## 报价 [${CODES.map((c) => c.name).join(',')}]`);
  console.log('源'.padEnd(24), '成功率'.padEnd(8), 'avg'.padEnd(7), 'min'.padEnd(7), 'max'.padEnd(7), '错误');
  const secids = CODES.map((c) => c.secid).join(',');
  for (const [name, fn] of Object.entries(PROVIDERS.quote)) {
    const rs = [];
    for (let i = 0; i < N; i++) rs.push(await timed((s) => fn(secids, s)));
    const st = stat(rs);
    console.log(name.padEnd(24), st.rate.padEnd(8), String(st.avg + 'ms').padEnd(7), String(st.min + 'ms').padEnd(7), String(st.max + 'ms').padEnd(7), st.errs);
  }
}

console.log(`=== 数据源基准 (N=${N}/源/代码, sidecar=${ASTOCK}) @ ${new Date().toISOString()} ===`);
await runKline('日线 (klt=101)', 101);
await runKline('30分钟 (klt=30)', 30);
await runQuote();
console.log('\n=== done ===');
