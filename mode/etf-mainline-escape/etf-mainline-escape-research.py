#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ETF 主线逃顶模式研究：主线强度入场 + 日频退出纪律。

目标：
- 最大持仓 3 只；
- 入场只使用主线/相对强度，退出只使用经典趋势破位或高点回撤；
- 用同一 ETF 池、同一 K 线数据源，与既有模式公平比较。

运行：
  python3 mode/etf-mainline-escape/etf-mainline-escape-research.py

环境变量同 mode/etf-rs90-top3/etf-rotation-backtest.py：
  SA_HOST / SA_ASTOCK / SA_APP_TOKEN / SA_CACHE
"""
import json, urllib.request, ssl, math, os, re, sys
from collections import deque

HOST = os.environ.get('SA_HOST', '192.168.31.144')
ASTOCK = os.environ.get('SA_ASTOCK', f'http://{HOST}:9119')
NAS = f'http://{HOST}:8787/api'
TOKEN = os.environ.get('SA_APP_TOKEN', '')
CACHE = os.environ.get('SA_CACHE', '/tmp/klcache')
WIN = ('2025-01-01', '2026-06-26')
OUT_DIR = os.environ.get(
    'SA_MODE_OUT_DIR',
    '/Users/qiuzhuoran/Desktop/自用/code/stock-agent/mode/etf-mainline-escape/backtest-data',
)
TRADE_LOG = os.environ.get('SA_RESEARCH_TRADE_LOG', f'{OUT_DIR}/trades_mainline_escape.md')
SUMMARY_LOG = os.environ.get('SA_RESEARCH_SUMMARY_LOG', f'{OUT_DIR}/summary_mainline_escape.md')
os.makedirs(CACHE, exist_ok=True)
os.makedirs(OUT_DIR, exist_ok=True)
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

POOL_FALLBACK = {
    '159851': '金融科技', '588000': '科创50', '562500': '机器人', '160644': '港美互联网', '159516': '半导体设备',
    '515880': '通信', '588200': '科创芯片', '515220': '煤炭', '159566': '储能电池', '159326': '电网设备',
    '159206': '卫星', '159740': '恒生科技', '159611': '电力', '560980': '光伏龙头', '516020': '化工',
    '513310': '中韩半导体', '513920': '港股通央企红利', '159780': '科创创业50', '161128': '标普信息科技', '159509': '纳指科技',
    '159819': '人工智能', '513090': '香港证券', '159567': '港股创新药', '159805': '传媒', '159695': '通信(嘉实)',
    '159251': '港股通科技', '159632': '纳斯达克', '159995': '芯片', '159699': '恒生消费', '159537': '信创',
    '159915': '创业板', '588050': '科创50(工银)', '518880': '黄金', '501225': '全球芯片', '561910': '电池',
    '515980': '人工智能(华富)', '562950': '消费电子', '159363': '创业板人工智能', '159928': '消费', '561360': '石油',
    '516120': '化工(富国)', '512880': '证券', '159267': '航天', '512980': '传媒(广发)', '512400': '有色金属',
    '159107': '创业板软件', '561380': '电网设备(国泰)', '512710': '军工龙头', '159755': '电池(广发)', '159869': '游戏',
    '159887': '银行', '560850': '信创(汇添富)', '513120': '港股创新药(广发)', '516860': '金融科技(博时)', '510720': '红利国企',
}


def family(name):
    rules = [
        ('半导体设备', ('半导体设备',)),
        ('科创芯片', ('科创芯片',)),
        ('全球芯片', ('全球芯片',)),
        ('中韩半导体', ('中韩半导体',)),
        ('芯片宽泛', ('芯片', '半导体')),
        ('通信', ('通信',)),
        ('人工智能', ('人工智能',)),
        ('电池储能', ('电池', '储能')),
        ('电网电力', ('电网', '电力')),
        ('港股创新药', ('港股创新药',)),
        ('港美互联网', ('港美互联网',)),
        ('恒生科技', ('恒生科技',)),
        ('港股通科技', ('港股通科技',)),
        ('美股科技', ('纳指', '纳斯达克', '标普信息科技')),
        ('传媒游戏', ('传媒', '游戏')),
        ('化工', ('化工',)),
        ('金融', ('证券', '银行', '金融科技')),
        ('军工航天', ('军工', '航天', '卫星')),
        ('消费', ('消费', '消费电子')),
        ('能源资源', ('煤炭', '石油', '有色', '黄金')),
        ('宽基', ('科创50', '创业板', '科创创业50')),
        ('信创软件', ('信创', '软件')),
    ]
    for fam, keys in rules:
        if any(k in name for k in keys):
            return fam
    return name.split('(')[0]


def get(url, token=False):
    headers = {'x-app-token': TOKEN} if token else {}
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=40, context=ctx).read())


def load_pool():
    if not TOKEN:
        return dict(POOL_FALLBACK)
    try:
        rows = get(f'{NAS}/etf/pool', token=True)['data']
        short = lambda n: re.sub(r'(ETF.*|LOF.*)$', '', n)
        return {r['code']: short(r['name']) for r in rows}
    except Exception as e:
        sys.stderr.write(f'拉取跟踪池失败，改用内置清单：{e}\n')
        return dict(POOL_FALLBACK)


def adjust_splits(o):
    factor = [1.0] * len(o)
    for i in range(1, len(o)):
        if o[i - 1]['c'] > 0:
            r = o[i]['c'] / o[i - 1]['c']
            if r < 0.65 or r > 1.5:
                for j in range(i):
                    factor[j] *= r
    for i, f in enumerate(factor):
        if f != 1.0:
            for k in ('o', 'h', 'l', 'c'):
                o[i][k] *= f
            o[i]['v'] = o[i]['v'] / f if f else o[i]['v']
    return o


def fetch(code):
    fp = f'{CACHE}/{code}.json'
    if os.path.exists(fp):
        return json.load(open(fp))
    try:
        d = get(f'{ASTOCK}/api/call/mootdx_kline?symbol={code}&category=4&offset=800')
        o = [{'d': x['datetime'][:10], 'o': x['open'], 'h': x['high'], 'l': x['low'], 'c': x['close'], 'v': x.get('volume') or 0} for x in (d or [])]
        o.sort(key=lambda x: x['d'])
        o = adjust_splits(o)
    except Exception as e:
        sys.stderr.write(f'fetch fail {code}: {e}\n'); o = []
    json.dump(o, open(fp, 'w')); return o


def sma(xs, n):
    out = []; s = 0.0; q = deque()
    for x in xs:
        q.append(x); s += x
        if len(q) > n:
            s -= q.popleft()
        out.append(s / len(q))
    return out


def stdev(xs):
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


POOL = load_pool()
bench = fetch('510300')
bclose = {x['d']: x['c'] for x in bench}
days = [d for d in sorted(bclose) if WIN[0] <= d <= WIN[1]]

sys.stderr.write(f'抓取/缓存 {len(POOL)} 只（缓存目录 {CACHE}）...\n')
U = {}
for code, name in POOL.items():
    bars = [b for b in fetch(code) if b['d'] in bclose]
    if len(bars) < 130:
        continue
    closes = [b['c'] for b in bars]
    highs = [b['h'] for b in bars]
    lows = [b['l'] for b in bars]
    ma20 = sma(closes, 20)
    ma30 = sma(closes, 30)
    ma60 = sma(closes, 60)
    ma120 = sma(closes, 120)
    trs = []
    for i, b in enumerate(bars):
        prev = closes[i - 1] if i else b['c']
        trs.append(max(b['h'] - b['l'], abs(b['h'] - prev), abs(b['l'] - prev)))
    atr20 = sma(trs, 20)
    by = {}
    for i, b in enumerate(bars):
        d = b['d']
        rs = b['c'] / bclose[d]
        def ret(n):
            return closes[i] / closes[i - n] - 1 if i >= n and closes[i - n] else 0.0
        def rsret(n):
            if i < n:
                return 0.0
            prev_rs = closes[i - n] / bclose[bars[i - n]['d']]
            return rs / prev_rs - 1 if prev_rs else 0.0
        rets20 = [closes[j] / closes[j - 1] - 1 for j in range(max(1, i - 19), i + 1) if closes[j - 1]]
        by[d] = {
            'o': b['o'],
            'h': b['h'],
            'l': b['l'],
            'c': b['c'],
            'nopen': bars[i + 1]['o'] if i + 1 < len(bars) else b['c'],
            'ma20': ma20[i],
            'ma30': ma30[i],
            'ma60': ma60[i],
            'ma120': ma120[i],
            'atr20': atr20[i],
            'low10prev': min(lows[max(0, i - 10):i]) if i else b['l'],
            'low20prev': min(lows[max(0, i - 20):i]) if i else b['l'],
            'mom60': ret(60),
            'mom90': ret(90),
            'mom120': ret(120),
            'rs60': rsret(60),
            'rs90': rsret(90),
            'rs120': rsret(120),
            'above60': b['c'] > ma60[i],
            'above120': b['c'] > ma120[i],
            'vol20': stdev(rets20) * math.sqrt(252),
        }
    U[code] = (name, by)


def exit_reason(c, d, p, rule):
    r = U[c][1][d]
    p['peak'] = max(p.get('peak', p['e']), r['h'])
    if rule == 'trail12' and r['c'] <= p['peak'] * 0.88:
        return '高点回撤12%'
    if rule == 'trail15' and r['c'] <= p['peak'] * 0.85:
        return '高点回撤15%'
    if rule == 'trail18' and r['c'] <= p['peak'] * 0.82:
        return '高点回撤18%'
    if rule == 'ma20' and r['c'] < r['ma20']:
        return '跌破MA20'
    if rule == 'ma30' and r['c'] < r['ma30']:
        return '跌破MA30'
    if rule == 'don10' and r['c'] < r['low10prev']:
        return '跌破10日低点'
    if rule == 'don20' and r['c'] < r['low20prev']:
        return '跌破20日低点'
    if rule == 'chandelier3' and r['c'] < p['peak'] - 3.0 * r['atr20']:
        return 'Chandelier 3ATR'
    if rule == 'chandelier4' and r['c'] < p['peak'] - 4.0 * r['atr20']:
        return 'Chandelier 4ATR'
    if rule == 'ma30trail10' and r['c'] < r['ma30'] and r['c'] <= p['peak'] * 0.90:
        return 'MA30且回撤10%'
    if rule == 'ma30trail12' and r['c'] < r['ma30'] and r['c'] <= p['peak'] * 0.88:
        return 'MA30且回撤12%'
    if rule == 'ma20trail10' and r['c'] < r['ma20'] and r['c'] <= p['peak'] * 0.90:
        return 'MA20且回撤10%'
    return None


def ranked_codes(d, score_key, abs_key, threshold, family_cap, held=None, blocked=None):
    held = held or set()
    blocked = blocked or set()
    ranked = []
    for c, (_, by) in U.items():
        if c in held or c in blocked or d not in by:
            continue
        r = by[d]
        if r[score_key] > threshold and (not abs_key or r[abs_key]):
            ranked.append((r[score_key], c))
    ranked.sort(reverse=True)
    out = []
    used = {family(U[c][0]) for c in held} if family_cap else set()
    for _, c in ranked:
        fam = family(U[c][0])
        if family_cap and fam in used:
            continue
        out.append(c)
        used.add(fam)
        if len(out) >= 3:
            break
    return out


def run_escape(label, score_key, exit_rule, rebalance=5, abs_key=None, threshold=0.0,
               family_cap=True, start=None, end=None, log=False, px='close', cost_bps=0.0):
    cash = 1.0
    pos = {}
    eqmax = 0.0
    mdd = 0.0
    trades = 0
    maxheld = 0
    held_sum = 0
    underinvested_days = 0
    curve = []
    rec = []
    active_days = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    cost = cost_bps / 10000.0

    def trade_price(c, d):
        r = U[c][1][d]
        return r['nopen'] if px == 'nextopen' else r['c']

    def equity(d):
        return cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def close_position(c, d, reason):
        nonlocal cash, trades
        r = U[c][1][d]
        p = pos[c]
        sell_px = trade_price(c, d)
        cash += p['a'] * (sell_px / p['e']) * (1 - cost)
        if log:
            rec.append({
                'entry': p['ed'], 'exit': d, 'code': c, 'name': U[c][0],
                'entryScore': p['score'], 'entryMom90': p.get('mom90'),
                'entryAbove60': p.get('above60'), 'entryAbove120': p.get('above120'),
                'exitClose': sell_px, 'entryClose': p['e'],
                'pnl': (sell_px / p['e'] * (1 - cost) * (1 - cost) - 1) * 100,
                'contrib': p['gross'] * (sell_px / p['e'] * (1 - cost) * (1 - cost) - 1),
                'reason': reason,
            })
        del pos[c]
        trades += 1

    for idx, d in enumerate(active_days):
        blocked = set()
        for c in list(pos):
            if d not in U[c][1]:
                continue
            reason = exit_reason(c, d, pos[c], exit_rule)
            if reason:
                close_position(c, d, reason)
                blocked.add(c)
        if idx % rebalance == 0:
            keep = ranked_codes(d, score_key, abs_key, threshold, family_cap, set(pos), blocked)
            for c in keep:
                if len(pos) >= 3:
                    break
                eq = equity(d)
                amount = min(eq / 3, cash)
                if amount <= 1e-6:
                    break
                r = U[c][1][d]
                cash -= amount
                pos[c] = {
                    'a': amount * (1 - cost), 'gross': amount, 'e': trade_price(c, d), 'ed': d, 'peak': r['h'],
                    'score': r[score_key], 'mom90': r.get('mom90'),
                    'above60': r['above60'], 'above120': r['above120'],
                }
                trades += 1
        e = equity(d)
        curve.append(e)
        eqmax = max(eqmax, e)
        mdd = min(mdd, (e / eqmax - 1) * 100)
        maxheld = max(maxheld, len(pos))
        held_sum += len(pos)
        if len(pos) < 3:
            underinvested_days += 1

    fin = curve[-1]
    ann = (fin ** (1 / (len(active_days) / 244)) - 1) * 100
    flat_ret = sum(curve[i] / curve[i - 1] - 1 for i in range(1, len(curve)) if curve[i - 1] > 0) * 100 if len(curve) > 1 else (fin - 1) * 100
    if log and active_days:
        last = active_days[-1]
        for c, p in pos.items():
            if last in U[c][1]:
                r = U[c][1][last]
                rec.append({
                    'entry': p['ed'], 'exit': last, 'code': c, 'name': U[c][0],
                    'entryScore': p['score'], 'entryMom90': p.get('mom90'),
                    'entryAbove60': p.get('above60'), 'entryAbove120': p.get('above120'),
                    'exitClose': r['c'], 'entryClose': p['e'],
                    'pnl': (r['c'] / p['e'] - 1) * 100,
                    'contrib': p['gross'] * (r['c'] / p['e'] * (1 - cost) - 1),
                    'reason': '持有中',
                })
    avgheld = held_sum / len(active_days) if active_days else 0
    return {
        'label': label, 'score': score_key, 'exit': exit_rule, 'abs': abs_key, 'px': px,
        'cost_bps': cost_bps, 'ret': (fin - 1) * 100,
        'flat_ret': flat_ret, 'ann': ann, 'mdd': mdd, 'trades': trades, 'maxheld': maxheld, 'avgheld': avgheld,
        'underinvested_days': underinvested_days, 'records': rec,
    }


def write_records(path, records):
    records = sorted(records, key=lambda r: (r['entry'], r['exit'], r['code']))
    with open(path, 'w') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 主题 | 买入强度 | 买入90日涨幅 | 买入MA60/120 | 收益 | 组合贡献 | 原因 |\n')
        f.write('|---|---|---|---|---|---:|---:|---|---:|---:|---|\n')
        for r in records:
            ma = f'{bool(r["entryAbove60"])}/{bool(r["entryAbove120"])}'
            f.write(
                f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {r["name"]} | {family(r["name"])} | '
                f'{r["entryScore"] * 100:+.1f}% | {r["entryMom90"] * 100:+.1f}% | {ma} | '
                f'{r["pnl"]:+.1f}% | {r["contrib"] * 100:+.1f}% | {r["reason"]} |\n'
            )
    return records


def mdcell(value):
    return str(value).replace('|', '\\|')


def buyhold(code):
    seg = [b for b in fetch(code) if WIN[0] <= b['d'] <= WIN[1]]
    peak = seg[0]['c']; dd = 0.0
    for b in seg:
        peak = max(peak, b['c']); dd = min(dd, (b['c'] / peak - 1) * 100)
    return (seg[-1]['c'] / seg[0]['c'] - 1) * 100, dd


tests = []
for score_key in ('rs60', 'rs90', 'rs120', 'mom90'):
    for exit_rule in ('trail12', 'trail15', 'trail18', 'ma20', 'ma30', 'don10', 'don20', 'chandelier3', 'chandelier4', 'ma30trail10', 'ma30trail12', 'ma20trail10'):
        for abs_key in (None, 'above60', 'above120'):
            tests.append(run_escape(
                f'{score_key}|{exit_rule}|{abs_key or "noabs"}|5d|fam',
                score_key, exit_rule, 5, abs_key, 0.0, True,
            ))

def score_result(r):
    return r['ret'] / max(1, abs(r['mdd'])) - r['trades'] * 0.004 - r['underinvested_days'] * 0.002

tests.sort(key=score_result, reverse=True)
print(f'载入 {len(U)}/{len(POOL)} | 区间 {days[0]}→{days[-1]} | 策略族=主线强度Top3 + 日频逃顶')
print('Top30:')
print(f'{"策略":<40}{"收益":>8}{"年化":>7}{"回撤":>7}{"交易":>6}{"均仓":>6}{"空槽日":>7}')
for r in tests[:30]:
    print(f'{r["label"]:<40}{r["ret"]:>7.0f}%{r["ann"]:>6.0f}%{r["mdd"]:>6.0f}%{r["trades"]:>6}{r["avgheld"]:>6.2f}{r["underinvested_days"]:>7}')

print('宽基:')
for code, name in [('510300', '沪深300'), ('510500', '中证500'), ('159915', '创业板指'), ('588000', '科创50')]:
    r, dd = buyhold(code)
    print(f'  {name:<8}{r:>6.0f}% / 回撤{dd:.0f}%')

best = tests[0]
checks = [
    run_escape('全段-候选', best['score'], best['exit'], 5, best['abs'], 0.0, True, log=True),
    run_escape('2025-候选', best['score'], best['exit'], 5, best['abs'], 0.0, True, '2025-01-01', '2025-12-31'),
    run_escape('2026-候选', best['score'], best['exit'], 5, best['abs'], 0.0, True, '2026-01-01', '2026-06-26'),
    run_escape('稳健复核RS90-ma30', 'rs90', 'ma30', 5, None, 0.0, True),
    run_escape('稳健复核RS90-trail15', 'rs90', 'trail15', 5, None, 0.0, True),
    run_escape('稳健复核RS120-ma30', 'rs120', 'ma30', 5, None, 0.0, True),
]

sensitivity = [
    run_escape('候选-收盘-0bp', best['score'], best['exit'], 5, best['abs'], 0.0, True, px='close', cost_bps=0.0),
    run_escape('候选-次开-0bp', best['score'], best['exit'], 5, best['abs'], 0.0, True, px='nextopen', cost_bps=0.0),
    run_escape('候选-收盘-5bp', best['score'], best['exit'], 5, best['abs'], 0.0, True, px='close', cost_bps=5.0),
    run_escape('候选-次开-5bp', best['score'], best['exit'], 5, best['abs'], 0.0, True, px='nextopen', cost_bps=5.0),
    run_escape('候选-次开-10bp', best['score'], best['exit'], 5, best['abs'], 0.0, True, px='nextopen', cost_bps=10.0),
]

print('候选方案复核:')
for r in checks:
    print(f'  {r["label"]:<18}{r["ret"]:>7.0f}% / 回撤{r["mdd"]:.0f}% / 交易{r["trades"]} / 均仓{r["avgheld"]:.2f} / 空槽日{r["underinvested_days"]} / 最大持仓{r["maxheld"]}')

print('成交/成本敏感性:')
for r in sensitivity:
    print(f'  {r["label"]:<18}{r["ret"]:>7.0f}% / 回撤{r["mdd"]:.0f}% / 交易{r["trades"]} / 均仓{r["avgheld"]:.2f} / 空槽日{r["underinvested_days"]}')

records = write_records(TRADE_LOG, checks[0]['records'])
by_code = {}
for r in records:
    cur = by_code.setdefault(r['code'], {'name': r['name'], 'count': 0, 'contrib': 0.0, 'wins': 0})
    cur['count'] += 1
    cur['contrib'] += r['contrib']
    if r['pnl'] > 0:
        cur['wins'] += 1
top_contrib = sorted(by_code.items(), key=lambda kv: kv[1]['contrib'], reverse=True)

with open(SUMMARY_LOG, 'w') as f:
    f.write('# ETF 主线逃顶模式回测摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}\n')
    f.write(f'- ETF池: {len(U)}/{len(POOL)} 只可用\n')
    f.write('- 最大持仓: 3，只在每 5 个交易日补仓；退出为日频规则，退出后同日不回补同标的。\n')
    f.write('- 规则空间: 4 个主线强度指标 x 12 个经典/确认式退出规则 x 3 个绝对趋势过滤。\n\n')
    f.write('## Top10 参数\n\n')
    f.write('| 策略 | 收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|\n')
    for r in tests[:10]:
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {r["underinvested_days"]} |\n')
    f.write('\n## 候选复核\n\n')
    f.write('| 策略 | 收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---:|\n')
    for r in checks:
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["flat_ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {r["underinvested_days"]} |\n')
    f.write('\n## 成交/成本敏感性\n\n')
    f.write('| 策略 | 成交口径 | 单边成本 | 收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 |\n')
    f.write('|---|---|---:|---:|---:|---:|---:|---:|---:|\n')
    for r in sensitivity:
        f.write(f'| {mdcell(r["label"])} | {r["px"]} | {r["cost_bps"]:.0f}bp | {r["ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {r["underinvested_days"]} |\n')
    f.write('\n## 收益集中度\n\n')
    f.write('| 代码 | 标的 | 交易次数 | 胜率 | 组合贡献 |\n')
    f.write('|---|---|---:|---:|---:|\n')
    for code, v in top_contrib[:12]:
        winrate = v['wins'] / v['count'] * 100 if v['count'] else 0
        f.write(f'| {code} | {v["name"]} | {v["count"]} | {winrate:.0f}% | {v["contrib"] * 100:+.1f}% |\n')

print(f'完整交易记录: {TRADE_LOG} | {len(records)} 笔')
print(f'回测摘要: {SUMMARY_LOG}')
print('收益贡献Top8:')
for code, v in top_contrib[:8]:
    winrate = v['wins'] / v['count'] * 100 if v['count'] else 0
    print(f'  {code} {v["name"]:<12} 贡献{v["contrib"] * 100:+.1f}% / {v["count"]}笔 / 胜率{winrate:.0f}%')
for row in records[:12]:
    print(f'  {row["entry"]} -> {row["exit"]} {row["code"]} {row["name"]} {row["pnl"]:+.1f}% {row["reason"]}')
