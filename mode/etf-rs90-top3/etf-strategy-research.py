#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ETF 策略族研究：跳出“金叉+ST+轮换”框架，比较更简洁的组合策略。

目标：
- 最大持仓 3 只；
- 不靠追加复杂限制凑回测；
- 用同一 ETF 池、同一 K 线数据源，与原主线轮动方案公平比较。

运行：
  python3 mode/etf-rs90-top3/etf-strategy-research.py

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
TRADE_LOG = os.environ.get('SA_RESEARCH_TRADE_LOG', '/tmp/trades_rs90_top3.md')
FAMILY_TRADE_LOG = os.environ.get('SA_RESEARCH_FAMILY_TRADE_LOG', '/tmp/trades_rs90_top3_family.md')
os.makedirs(CACHE, exist_ok=True)
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
    ma60 = sma(closes, 60)
    ma120 = sma(closes, 120)
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
            'c': b['c'],
            'nopen': bars[i + 1]['o'] if i + 1 < len(bars) else b['c'],
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


def run_periodic(label, score_key, abs_key='above120', rebalance=20, threshold=0.0, vol_target=False, px='close', reset_kept=True, start=None, end=None, log=False, family_cap=False):
    cash = 1.0; pos = {}; eqmax = 0.0; mdd = 0.0; trades = 0; maxheld = 0; held_sum = 0; underinvested_days = 0
    curve = []; rec = []
    active_days = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    tx = lambda c, d: U[c][1][d]['nopen'] if px == 'nextopen' else U[c][1][d]['c']
    def equity(d):
        return cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])
    for idx, d in enumerate(active_days):
        if idx % rebalance == 0:
            eq = equity(d)
            ranked = []
            for c, (_, by) in U.items():
                if d not in by:
                    continue
                r = by[d]
                if r[score_key] > threshold and (not abs_key or r[abs_key]):
                    ranked.append((r[score_key], c))
            ranked.sort(reverse=True)
            keep = []
            used_families = set()
            for _, c in ranked:
                fam = family(U[c][0])
                if family_cap and fam in used_families:
                    continue
                keep.append(c); used_families.add(fam)
                if len(keep) >= 3:
                    break
            for c in list(pos):
                if c not in keep:
                    p = tx(c, d)
                    cash += pos[c]['a'] * (p / pos[c]['e'])
                    if log:
                        rec.append({
                            'entry': pos[c]['ed'], 'exit': d, 'code': c, 'name': U[c][0],
                            'pnl': (p / pos[c]['e'] - 1) * 100, 'reason': '跌出Top3',
                            'entryScore': pos[c].get('score'), 'entryAbs90': pos[c].get('abs90'),
                            'entryAbove60': pos[c].get('above60'), 'entryAbove120': pos[c].get('above120'),
                        })
                    del pos[c]; trades += 1
            if keep:
                raw_weights = {}
                if vol_target:
                    inv = [(1 / max(0.08, U[c][1][d]['vol20']), c) for c in keep]
                    s = sum(x for x, _ in inv)
                    raw_weights = {c: x / s for x, c in inv}
                else:
                    raw_weights = {c: 1 / len(keep) for c in keep}
                if reset_kept:
                    target = {c: eq * raw_weights[c] for c in keep}
                    # 完整再平衡：组合权重更干净，但换手偏高。
                    cash = eq
                    pos = {}
                    for c in keep:
                        a = min(target[c], cash)
                        cash -= a
                        r = U[c][1][d]
                        pos[c] = {'a': a, 'e': tx(c, d), 'ed': d, 'score': r[score_key], 'abs90': r.get('mom90'), 'above60': r['above60'], 'above120': r['above120']}
                    trades += len(keep)
                else:
                    # 只替换跌出 Top3 的标的；保留仍在 Top3 的趋势腿，不做机械再平衡。
                    missing = [c for c in keep if c not in pos]
                    for c in missing:
                        a = min(eq / 3, cash)
                        if a <= 1e-6:
                            break
                        cash -= a
                        r = U[c][1][d]
                        pos[c] = {'a': a, 'e': tx(c, d), 'ed': d, 'score': r[score_key], 'abs90': r.get('mom90'), 'above60': r['above60'], 'above120': r['above120']}
                        trades += 1
        e = equity(d); curve.append(e); eqmax = max(eqmax, e); mdd = min(mdd, (e / eqmax - 1) * 100); maxheld = max(maxheld, len(pos))
        held_sum += len(pos)
        if len(pos) < 3:
            underinvested_days += 1
    fin = curve[-1]
    ann = (fin ** (1 / (len(active_days) / 244)) - 1) * 100
    if log and active_days:
        last = active_days[-1]
        for c, p in pos.items():
            if last in U[c][1]:
                rec.append({
                    'entry': p['ed'], 'exit': last, 'code': c, 'name': U[c][0],
                    'pnl': (U[c][1][last]['c'] / p['e'] - 1) * 100, 'reason': '持有中',
                    'entryScore': p.get('score'), 'entryAbs90': p.get('abs90'),
                    'entryAbove60': p.get('above60'), 'entryAbove120': p.get('above120'),
                })
    avgheld = held_sum / len(active_days) if active_days else 0
    return {
        'label': label, 'ret': (fin - 1) * 100, 'ann': ann, 'mdd': mdd, 'trades': trades,
        'maxheld': maxheld, 'avgheld': avgheld, 'underinvested_days': underinvested_days, 'records': rec,
    }


def write_records(path, records):
    records = sorted(records, key=lambda r: (r['entry'], r['exit'], r['code']))
    with open(path, 'w') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 主题 | 买入RS90 | 买入90日涨幅 | 买入MA60/120 | 收益 | 原因 |\n')
        f.write('|---|---|---|---|---|---:|---:|---|---:|---|\n')
        for r in records:
            ma = f'{bool(r["entryAbove60"])}/{bool(r["entryAbove120"])}'
            f.write(
                f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {r["name"]} | {family(r["name"])} | '
                f'{r["entryScore"] * 100:+.1f}% | {r["entryAbs90"] * 100:+.1f}% | {ma} | {r["pnl"]:+.1f}% | {r["reason"]} |\n'
            )
    return records


def buyhold(code):
    seg = [b for b in fetch(code) if WIN[0] <= b['d'] <= WIN[1]]
    peak = seg[0]['c']; dd = 0.0
    for b in seg:
        peak = max(peak, b['c']); dd = min(dd, (b['c'] / peak - 1) * 100)
    return (seg[-1]['c'] / seg[0]['c'] - 1) * 100, dd


tests = []
for key in ('mom60', 'mom90', 'mom120', 'rs60', 'rs90', 'rs120'):
    for abs_key in ('above60', 'above120', None):
        for reb in (5, 10, 20):
            for threshold in (0.0, 0.03):
                tests.append(run_periodic(f'{key}|{abs_key or "noabs"}|{reb}d|thr{threshold}', key, abs_key, reb, threshold))
                tests.append(run_periodic(f'{key}|{abs_key or "noabs"}|{reb}d|thr{threshold}|ivol', key, abs_key, reb, threshold, True))
                tests.append(run_periodic(f'{key}|{abs_key or "noabs"}|{reb}d|thr{threshold}|keep', key, abs_key, reb, threshold, False, reset_kept=False))
                tests.append(run_periodic(f'{key}|{abs_key or "noabs"}|{reb}d|thr{threshold}|keep|fam', key, abs_key, reb, threshold, False, reset_kept=False, family_cap=True))

tests.sort(key=lambda x: (x['ret'] / max(1, abs(x['mdd'])) - x['trades'] * 0.005), reverse=True)
print(f'载入 {len(U)}/{len(POOL)} | 区间 {days[0]}→{days[-1]} | 策略族=定期Top3动量/双动量')
print('Top30:')
print(f'{"策略":<34}{"收益":>8}{"年化":>7}{"回撤":>7}{"交易":>6}{"均仓":>6}{"空槽日":>7}')
for r in tests[:30]:
    print(f'{r["label"]:<34}{r["ret"]:>7.0f}%{r["ann"]:>6.0f}%{r["mdd"]:>6.0f}%{r["trades"]:>6}{r["avgheld"]:>6.2f}{r["underinvested_days"]:>7}')

print('宽基:')
for code, name in [('510300', '沪深300'), ('510500', '中证500'), ('159915', '创业板指'), ('588000', '科创50')]:
    r, dd = buyhold(code)
    print(f'  {name:<8}{r:>6.0f}% / 回撤{dd:.0f}%')

print('候选方案复核: 周频Top3 RS90，只替换跌出Top3，不机械再平衡')
checks = [
    run_periodic('全段-收盘', 'rs90', None, 5, 0.0, False, 'close', False, log=True),
    run_periodic('全段-次开', 'rs90', None, 5, 0.0, False, 'nextopen', False),
    run_periodic('2025-收盘', 'rs90', None, 5, 0.0, False, 'close', False, '2025-01-01', '2025-12-31'),
    run_periodic('2026-收盘', 'rs90', None, 5, 0.0, False, 'close', False, '2026-01-01', '2026-06-26'),
    run_periodic('去重-收盘', 'rs90', None, 5, 0.0, False, 'close', False, log=True, family_cap=True),
    run_periodic('去重-次开', 'rs90', None, 5, 0.0, False, 'nextopen', False, family_cap=True),
    run_periodic('去重2025', 'rs90', None, 5, 0.0, False, 'close', False, '2025-01-01', '2025-12-31', family_cap=True),
    run_periodic('去重2026', 'rs90', None, 5, 0.0, False, 'close', False, '2026-01-01', '2026-06-26', family_cap=True),
]
for r in checks:
    print(f'  {r["label"]:<10}{r["ret"]:>7.0f}% / 回撤{r["mdd"]:.0f}% / 交易{r["trades"]} / 均仓{r["avgheld"]:.2f} / 空槽日{r["underinvested_days"]} / 最大持仓{r["maxheld"]}')
records = write_records(TRADE_LOG, checks[0]['records'])
print(f'完整交易记录: {TRADE_LOG} | {len(records)} 笔')
for row in records[:12]:
    print(f'  {row["entry"]} -> {row["exit"]} {row["code"]} {row["name"]} {row["pnl"]:+.1f}% {row["reason"]}')
family_records = write_records(FAMILY_TRADE_LOG, checks[4]['records'])
print(f'去重版交易记录: {FAMILY_TRADE_LOG} | {len(family_records)} 笔')
for row in family_records[:12]:
    print(f'  {row["entry"]} -> {row["exit"]} {row["code"]} {row["name"]} {family(row["name"])} {row["pnl"]:+.1f}% {row["reason"]}')
