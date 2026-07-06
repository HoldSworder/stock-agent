#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探索：什么信号能更早/更多地"捕捉主线"。

诊断已证明 rs90 能把每条真主线在其当令窗口排到 #1-#2、覆盖 5/5，但它"晚"（上车时主线已涨~57%）。
本脚本探索两条前沿，并以【主线捕获率】为核心指标（而非只看总收益）：

  baseline  rs90        相对强弱90日变化率（现行，晚但准）
  theme     主题强度轮动  把同主题多只ETF聚合，按"主题中位相对强弱"选主线、持其最强成员
                         （宽度确认：多只一起转强=真主线，比单只动量更早更稳）
  rsturn    RS拐头早入场  RS线(close/bench)上穿自身MA20 → 相对强弱刚转上升即介入（早抓鱼头）
  rsaccel   RS加速度     近20日相对强弱变化 > 前20日 → 主线启动期的加速

核心指标【捕获率】：对每条点名主线，统计其当令窗口内"我们持有该主题的交易日占比"，
以及"持有期间吃到的该主题涨幅 / 该主题窗口总涨幅"。直接回答"到底抓没抓住主线"。

运行：python3 mode/etf-mainline-persistence/etf-mainline-capture-explore.py
"""
import json, urllib.request, ssl, os, re, sys
from collections import deque

HOST = os.environ.get('SA_HOST', '192.168.31.144')
ASTOCK = os.environ.get('SA_ASTOCK', f'http://{HOST}:9119')
NAS = f'http://{HOST}:8787/api'
TOKEN = os.environ.get('SA_APP_TOKEN', '')
CACHE = os.environ.get('SA_CACHE', '/tmp/klcache')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backtest-data')
os.makedirs(CACHE, exist_ok=True); os.makedirs(OUT, exist_ok=True)
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
WIN = ('2025-01-01', '2026-06-26')

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
# 点名真主线 → (家族, 当令窗口)
NAMED = {
    '港股创新药': ('2025-01-02', '2025-06-30'),
    '通信': ('2025-07-01', '2025-12-31'),
    '中韩半导体': ('2026-01-02', '2026-06-26'),
    '半导体设备': ('2026-01-02', '2026-06-26'),
}


def family(name):
    rules = [('半导体设备', ('半导体设备',)), ('科创芯片', ('科创芯片',)), ('全球芯片', ('全球芯片',)),
             ('中韩半导体', ('中韩半导体',)), ('芯片宽泛', ('芯片', '半导体')), ('通信', ('通信',)),
             ('人工智能', ('人工智能',)), ('电池储能', ('电池', '储能')), ('电网电力', ('电网', '电力')),
             ('港股创新药', ('港股创新药', '创新药')), ('港美互联网', ('港美互联网',)), ('恒生科技', ('恒生科技',)),
             ('港股通科技', ('港股通科技',)), ('美股科技', ('纳指', '纳斯达克', '标普信息科技')),
             ('传媒游戏', ('传媒', '游戏')), ('化工', ('化工',)), ('金融', ('证券', '银行', '金融科技')),
             ('军工航天', ('军工', '航天', '卫星')), ('消费', ('消费', '消费电子')),
             ('能源资源', ('煤炭', '石油', '有色', '黄金')), ('宽基', ('科创50', '创业板', '科创创业50')),
             ('信创软件', ('信创', '软件'))]
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
    except Exception:
        return dict(POOL_FALLBACK)


def adjust_splits(o):
    f = [1.0] * len(o)
    for i in range(1, len(o)):
        if o[i - 1]['c'] > 0:
            r = o[i]['c'] / o[i - 1]['c']
            if r < 0.65 or r > 1.5:
                for j in range(i):
                    f[j] *= r
    for i, fac in enumerate(f):
        if fac != 1.0:
            for k in ('o', 'h', 'l', 'c'):
                o[i][k] *= fac
    return o


def fetch(code):
    fp = f'{CACHE}/{code}.json'
    if os.path.exists(fp):
        return json.load(open(fp))
    try:
        d = get(f'{ASTOCK}/api/call/mootdx_kline?symbol={code}&category=4&offset=800')
        o = [{'d': x['datetime'][:10], 'o': x['open'], 'h': x['high'], 'l': x['low'], 'c': x['close'], 'v': x.get('volume') or 0} for x in (d or [])]
        o.sort(key=lambda x: x['d']); o = adjust_splits(o)
    except Exception:
        o = []
    json.dump(o, open(fp, 'w')); return o


def sma(xs, n):
    out = []; s = 0.0; q = deque()
    for x in xs:
        q.append(x); s += x
        if len(q) > n:
            s -= q.popleft()
        out.append(s / len(q))
    return out


POOL = load_pool()
bench = fetch('510300'); bclose = {x['d']: x['c'] for x in bench}
ALLDAYS = sorted(bclose)
sys.stderr.write(f'构建 {len(POOL)} 只指标...\n')

U = {}
for code, name in POOL.items():
    bars = [b for b in fetch(code) if b['d'] in bclose]
    if len(bars) < 150:
        continue
    closes = [b['c'] for b in bars]
    ma60 = sma(closes, 60)
    rs_series = [b['c'] / bclose[b['d']] for b in bars]
    rs_ma = {w: sma(rs_series, w) for w in (10, 15, 20, 25, 30)}
    by = {}
    for i, b in enumerate(bars):
        d = b['d']; rs = rs_series[i]
        def rsret(n):
            if i < n:
                return None
            prev = rs_series[i - n]
            return rs / prev - 1 if prev else None
        rs20 = rsret(20); rs40 = rsret(40); rs60 = rsret(60)
        # RS加速度：近20日相对强弱变化 - 前一段（用 rs20 与 rs40 的差近似二阶）
        accel = (rs20 - (rs40 - rs20)) if (rs20 is not None and rs40 is not None) else None
        by[d] = {'c': b['c'], 'h': b['h'], 'rs': rs, 'rs_ma20': rs_ma[20][i],
                 'rs20': rs20, 'rs40': rs40, 'rs60': rs60, 'rs90': rsret(90),
                 'rsturn': (rs > rs_ma[20][i]) if rs_ma[20][i] else False,
                 'turn': {w: (rs > rs_ma[w][i]) if rs_ma[w][i] else False for w in (10, 15, 20, 25, 30)},
                 'accel': accel, 'ma60': ma60[i], 'above60': b['c'] > ma60[i]}
    U[code] = (name, by)

DAYS = [d for d in ALLDAYS if WIN[0] <= d <= WIN[1]]
FAMILIES = {}
for c in U:
    FAMILIES.setdefault(family(U[c][0]), []).append(c)


def theme_strength(fam, d):
    vals = [U[c][1][d]['rs60'] for c in FAMILIES[fam] if d in U[c][1] and U[c][1][d]['rs60'] is not None]
    if not vals:
        return None
    vals.sort()
    return vals[len(vals) // 2]  # 主题中位相对强弱（宽度稳健，单只异常不左右）


def best_member(fam, d):
    cand = [(U[c][1][d]['rs90'], c) for c in FAMILIES[fam]
            if d in U[c][1] and U[c][1][d]['above60'] and U[c][1][d]['rs90'] is not None]
    cand.sort(reverse=True)
    return cand[0][1] if cand else None


def run(selector, N=2, weights=None, rebalance=5, start=None, end=None, cost_bps=5.0, log=False, turn_win=20):
    days = [d for d in DAYS if (start or WIN[0]) <= d <= (end or WIN[1])]
    cost = cost_bps / 10000.0
    weights = weights or tuple([1.0 / N] * N)
    cash = 1.0; pos = {}; eqmax = 0; mdd = 0; trades = 0; rec = []
    held_fam_days = {}  # (fam) -> set of days held
    eq = lambda d: cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def pick(d):
        """返回最多N个(code)，同主题去重。"""
        if selector == 'theme':
            ts = [(theme_strength(f, d), f) for f in FAMILIES if theme_strength(f, d) is not None and theme_strength(f, d) > 0]
            ts.sort(reverse=True)
            out = []
            for _, f in ts:
                m = best_member(f, d)
                if m:
                    out.append(m)
                if len(out) >= N:
                    break
            return out
        # 个股口径
        def score(c):
            r = U[c][1][d]
            if not r['above60']:
                return None
            if selector == 'rs90':
                return r['rs90'] if (r['rs90'] is not None and r['rs90'] > 0) else None
            if selector == 'rsturn':
                # 仅在 RS 上穿 MA(turn_win)（刚转强）的标的里，按 rs60 选最强
                if not r['turn'].get(turn_win) or r['rs60'] is None or r['rs60'] <= 0:
                    return None
                return r['rs60']
            if selector == 'rsaccel':
                if r['accel'] is None or r['accel'] <= 0 or r['rs60'] is None or r['rs60'] <= 0:
                    return None
                return r['accel']
            return None
        arr = [(score(c), c) for c in U if d in U[c][1] and score(c) is not None and score(c) > 0]
        arr.sort(reverse=True)
        out = []; used = set()
        for _, c in arr:
            f = family(U[c][0])
            if f in used:
                continue
            out.append(c); used.add(f)
            if len(out) >= N:
                break
        return out

    def close(c, d, reason):
        nonlocal cash, trades
        p = pos[c]; px = U[c][1][d]['c']; cash += p['a'] * (px / p['e']) * (1 - cost)
        if log:
            rec.append({'entry': p['ed'], 'exit': d, 'code': c, 'name': U[c][0],
                        'pnl': (px / p['e'] - 1) * 100, 'contrib': p['gross'] * (px / p['e'] - 1), 'reason': reason})
        del pos[c]; trades += 1

    def openpos(c, d, amt):
        nonlocal cash, trades
        if amt <= 1e-6 or d not in U[c][1]:
            return
        cash -= amt; pos[c] = {'a': amt * (1 - cost), 'gross': amt, 'e': U[c][1][d]['c'], 'ed': d}; trades += 1

    for idx, d in enumerate(days):
        if idx % rebalance == 0:
            keep = pick(d)
            for c in list(pos):
                if c not in keep:
                    close(c, d, '跌出榜')
            E = eq(d)
            for i, c in enumerate(keep):
                if c in pos:
                    continue
                openpos(c, d, min(E * weights[i], cash))
        for c in pos:
            held_fam_days.setdefault(family(U[c][0]), set()).add(d)
        e = eq(d); eqmax = max(eqmax, e); mdd = min(mdd, (e / eqmax - 1) * 100)
    last = days[-1]
    for c, p in list(pos.items()):
        if log and last in U[c][1]:
            rec.append({'entry': p['ed'], 'exit': last, 'code': c, 'name': U[c][0],
                        'pnl': (U[c][1][last]['c'] / p['e'] - 1) * 100,
                        'contrib': p['gross'] * (U[c][1][last]['c'] / p['e'] - 1), 'reason': '持有中'})
    fin = eq(last); n = len(days)
    return {'sel': selector, 'ret': (fin - 1) * 100, 'mdd': mdd, 'trades': trades,
            'ann': (fin ** (244 / n) - 1) * 100, 'rec': rec, 'held_fam_days': held_fam_days}


def capture_pct(selector, N, weights=None):
    """对每条点名主线：当令窗口内持有该主题的交易日占比。"""
    res = run(selector, N, weights)
    out = {}
    for nm, (s, e) in NAMED.items():
        fam = family(nm)
        wdays = [d for d in DAYS if s <= d <= e]
        held = res['held_fam_days'].get(fam, set())
        hit = sum(1 for d in wdays if d in held)
        out[nm] = hit / len(wdays) * 100 if wdays else 0
    return out, res


SEGS = [('2025H1', '2025-01-02', '2025-06-30'), ('2025H2', '2025-07-01', '2025-12-31'),
        ('2026H1', '2026-01-02', '2026-06-26')]
print(f'载入 {len(U)}/{len(POOL)} | 主题数 {len(FAMILIES)} | 探索"捕捉主线"的信号\n')
print('=== 总收益 + 分段（N2均权, 含5bp）===')
print(f'{"信号":<10}{"全段":>8}{"回撤":>7}{"交易":>6}  | 2025H1/H2 2026H1')
SELS = ['rs90', 'theme', 'rsturn', 'rsaccel']
res_all = {}
for sel in SELS:
    r = run(sel, 2)
    subs = [run(sel, 2, start=s, end=e)['ret'] for _, s, e in SEGS]
    res_all[sel] = (r, subs)
    print(f'{sel:<10}{r["ret"]:>7.0f}%{r["mdd"]:>6.0f}%{r["trades"]:>6}  | ' + ' '.join(f'{x:>4.0f}%' for x in subs))

print('\n=== 主线捕获率（当令窗口内持有该主题的交易日占比, N2）===')
print(f'{"信号":<10}' + ''.join(f'{nm:>12}' for nm in NAMED))
cap_all = {}
for sel in SELS:
    cap, _ = capture_pct(sel, 2)
    cap_all[sel] = cap
    print(f'{sel:<10}' + ''.join(f'{cap[nm]:>11.0f}%' for nm in NAMED))

print('\n=== 早入场验证：rsturn / rsaccel 上车时主线已涨幅（vs rs90 中位~57%）===')
def entry_rise(selector):
    res = run(selector, 2, log=True)
    rises = []
    for r in res['rec']:
        c = r['code']; ed = r['entry']
        by = U[c][1]; ds = [d for d in DAYS if d <= ed and d in by]
        if len(ds) < 60:
            continue
        win = [by[d]['c'] for d in ds[-60:]]
        rises.append((by[ed]['c'] / min(win) - 1) * 100)
    rises.sort()
    return rises[len(rises) // 2] if rises else 0
for sel in SELS:
    print(f'  {sel:<10} 上车时相对60日低点已涨(中位) {entry_rise(sel):.0f}%')

print('\n=== rsturn 稳健性体检：RS-MA窗口邻域 × N × 成本 ===')
print(f'{"RS-MA窗口":<10}' + ''.join(f'{w:>8}' for w in (10, 15, 20, 25, 30)))
turn_full = {w: run('rsturn', 2, turn_win=w)['ret'] for w in (10, 15, 20, 25, 30)}
print(f'{"N2全段":<9}' + ''.join(f'{turn_full[w]:>7.0f}%' for w in (10, 15, 20, 25, 30)))
turn_n3 = {w: run('rsturn', 3, turn_win=w)['ret'] for w in (10, 15, 20, 25, 30)}
print(f'{"N3全段":<9}' + ''.join(f'{turn_n3[w]:>7.0f}%' for w in (10, 15, 20, 25, 30)))
turn_10bp = {w: run('rsturn', 2, turn_win=w, cost_bps=10.0)['ret'] for w in (10, 15, 20, 25, 30)}
print(f'{"N2 10bp":<8}' + ''.join(f'{turn_10bp[w]:>7.0f}%' for w in (10, 15, 20, 25, 30)))
vals = list(turn_full.values()); spread = max(vals) - min(vals)
print(f'N2邻域极差={spread:.0f}pp（>150pp=脆/尖峰；<100pp=较稳）；rs90 N2基线=188%')

with open(f'{OUT}/summary_capture_explore.md', 'w') as f:
    f.write('# 探索：什么信号能更早/更多捕捉主线\n\n')
    f.write(f'区间 {DAYS[0]}→{DAYS[-1]}｜55只池｜{len(FAMILIES)}个主题｜N2均权含5bp。\n\n')
    f.write('## 总收益 + 分段\n\n| 信号 | 全段 | 回撤 | 交易 | 2025H1 | 2025H2 | 2026H1 |\n|---|---:|---:|---:|---:|---:|---:|\n')
    for sel in SELS:
        r, subs = res_all[sel]
        f.write(f'| {sel} | {r["ret"]:.0f}% | {r["mdd"]:.0f}% | {r["trades"]} | ' + ' | '.join(f'{x:.0f}%' for x in subs) + ' |\n')
    f.write('\n## 主线捕获率（当令窗口内持有该主题交易日占比）\n\n| 信号 | ' + ' | '.join(NAMED) + ' |\n|' + '---|' * (len(NAMED) + 1) + '\n')
    for sel in SELS:
        f.write(f'| {sel} | ' + ' | '.join(f'{cap_all[sel][nm]:.0f}%' for nm in NAMED) + ' |\n')
    f.write('\n## 上车早晚（上车时相对60日低点已涨幅, 中位; rs90≈基线晚）\n\n| 信号 | 上车已涨中位 |\n|---|---:|\n')
    for sel in SELS:
        f.write(f'| {sel} | {entry_rise(sel):.0f}% |\n')
    f.write('\n## rsturn 稳健性体检：RS-MA窗口邻域 × N × 成本\n\n')
    f.write('| 口径 | MA10 | MA15 | MA20 | MA25 | MA30 |\n|---|---:|---:|---:|---:|---:|\n')
    f.write('| N2 全段 | ' + ' | '.join(f'{turn_full[w]:.0f}%' for w in (10, 15, 20, 25, 30)) + ' |\n')
    f.write('| N3 全段 | ' + ' | '.join(f'{turn_n3[w]:.0f}%' for w in (10, 15, 20, 25, 30)) + ' |\n')
    f.write('| N2 10bp | ' + ' | '.join(f'{turn_10bp[w]:.0f}%' for w in (10, 15, 20, 25, 30)) + ' |\n')
    f.write(f'\nN2邻域极差 {spread:.0f}pp（rs90 N2 基线=188%）。窗口越平滑越稳健，剧烈跳动则为运气尖峰。\n\n')
    f.write('说明：信号选择=`theme`按主题中位相对强弱(宽度稳健)、`rsturn`=RS线上穿MA早入场、`rsaccel`=RS加速度。'
            '捕获率越高=越能持住真主线；上车已涨越小=越早抓到鱼头。结合收益与稳健性综合判断。\n')

print(f'\n交付：{OUT}/summary_capture_explore.md')
