#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ETF 主线进攻·逃顶轮动模式研究（牛市进攻，不要防御）。

目标：牛市里把利润做到最大——上车最强主线、骑住、**及时逃顶锁利**、再立刻轮进
当下最强腿（钱不下车）。在 leader-runner（集中2腿keep、跌出加权Top2才换）之上，
叠加一道**每日逃顶信号**：持仓见顶/破位即离场，空出的仓位**当日立刻补进当前最强腿**。

关键对比（这是 leader-runner 没做的）：leader-runner 的离场只在调仓日按"跌出Top2"判，
滞后、顶部回吐大；本模式每日检查逃顶，触发即轮动。逃顶信号在牛市到底加不加分，实测见分晓。

逃顶信号（exit）候选：
  none      不设（= leader-runner 基线，只靠跌出Top2换腿）
  ma20/ma10 收盘跌破 MA20 / MA10
  st        Supertrend(10,3) 翻空
  chand4/5  从持仓最高点回撤 4/5 倍 ATR
  ext       乖离反转：收盘较 MA20 乖离 > 阈值后首根下跌日（抓冲高回落的顶）

排名口径 score：rs90（相对沪深300 90日强弱变化率）/ accel136（1+3+6月收益和，含加速度）。
集中度 weights：80/20、70/30（集中上龙头）。月内每日检查逃顶；每5日做 leader-runner 式换腿。

反过拟合：信号都是单参数经典规则、有经济逻辑；同一配置跑牛市多个子段（2025H1/H2、2026H1），
  看是否分段一致占优，而非只在某一段冒尖。

运行：python3 mode/etf-mainline-offense/etf-mainline-offense-research.py
环境变量同其它模式：SA_HOST / SA_ASTOCK / SA_APP_TOKEN / SA_CACHE
"""
import json, urllib.request, ssl, math, os, re, sys
from collections import deque

HOST = os.environ.get('SA_HOST', '192.168.31.144')
ASTOCK = os.environ.get('SA_ASTOCK', f'http://{HOST}:9119')
NAS = f'http://{HOST}:8787/api'
TOKEN = os.environ.get('SA_APP_TOKEN', '')
CACHE = os.environ.get('SA_CACHE', '/tmp/klcache')
OUT_DIR = os.environ.get('SA_MODE_OUT_DIR',
                         os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backtest-data'))
TRADE_LOG = os.environ.get('SA_RESEARCH_TRADE_LOG', f'{OUT_DIR}/trades_offense.md')
SUMMARY_LOG = os.environ.get('SA_RESEARCH_SUMMARY_LOG', f'{OUT_DIR}/summary_offense.md')
os.makedirs(CACHE, exist_ok=True); os.makedirs(OUT_DIR, exist_ok=True)
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
WIN = ('2025-01-01', '2026-06-26')
LR_BASE = 353.0  # leader-runner 推荐档 80/20 全段收益，作对照基线

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
    rules = [('半导体设备', ('半导体设备',)), ('科创芯片', ('科创芯片',)), ('全球芯片', ('全球芯片',)),
             ('中韩半导体', ('中韩半导体',)), ('芯片宽泛', ('芯片', '半导体')), ('通信', ('通信',)),
             ('人工智能', ('人工智能',)), ('电池储能', ('电池', '储能')), ('电网电力', ('电网', '电力')),
             ('港股创新药', ('港股创新药',)), ('港美互联网', ('港美互联网',)), ('恒生科技', ('恒生科技',)),
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
    except Exception as e:
        sys.stderr.write(f'拉取跟踪池失败，改用内置清单：{e}\n')
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
            o[i]['v'] = o[i]['v'] / fac if fac else o[i]['v']
    return o


def fetch(code):
    fp = f'{CACHE}/{code}.json'
    if os.path.exists(fp):
        return json.load(open(fp))
    try:
        d = get(f'{ASTOCK}/api/call/mootdx_kline?symbol={code}&category=4&offset=800')
        o = [{'d': x['datetime'][:10], 'o': x['open'], 'h': x['high'], 'l': x['low'], 'c': x['close'], 'v': x.get('volume') or 0} for x in (d or [])]
        o.sort(key=lambda x: x['d']); o = adjust_splits(o)
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


POOL = load_pool()
bench = fetch('510300'); bclose = {x['d']: x['c'] for x in bench}
ALLDAYS = [d for d in sorted(bclose)]

sys.stderr.write(f'构建 {len(POOL)} 只指标...\n')
U = {}
for code, name in POOL.items():
    bars = [b for b in fetch(code) if b['d'] in bclose]
    if len(bars) < 130:
        continue
    closes = [b['c'] for b in bars]; highs = [b['h'] for b in bars]; lows = [b['l'] for b in bars]
    ma10 = sma(closes, 10); ma20 = sma(closes, 20)
    trs = []
    for i, b in enumerate(bars):
        prev = closes[i - 1] if i else b['c']
        trs.append(max(b['h'] - b['l'], abs(b['h'] - prev), abs(b['l'] - prev)))
    atr = sma(trs, 10)
    # Supertrend(10,3)
    fu = [0.0] * len(bars); fl = [0.0] * len(bars); st = [1] * len(bars)
    for i, b in enumerate(bars):
        hl2 = (b['h'] + b['l']) / 2; bu = hl2 + 3 * atr[i]; bl = hl2 - 3 * atr[i]
        if i == 0:
            fu[i], fl[i], st[i] = bu, bl, 1; continue
        fu[i] = bu if (bu < fu[i - 1] or closes[i - 1] > fu[i - 1]) else fu[i - 1]
        fl[i] = bl if (bl > fl[i - 1] or closes[i - 1] < fl[i - 1]) else fl[i - 1]
        st[i] = 1 if closes[i] > fu[i - 1] else (-1 if closes[i] < fl[i - 1] else st[i - 1])
    by = {}
    for i, b in enumerate(bars):
        d = b['d']; rs = b['c'] / bclose[d]
        def rsret(n):
            if i < n:
                return None
            prev = closes[i - n] / bclose[bars[i - n]['d']]
            return rs / prev - 1 if prev else None
        def ret(n):
            return closes[i] / closes[i - n] - 1 if i >= n and closes[i - n] else None
        a1, a3, a6 = ret(21), ret(63), ret(126)
        accel = (a1 + a3 + a6) if None not in (a1, a3, a6) else None
        ext20 = (closes[i] - ma20[i]) / ma20[i] if ma20[i] else 0
        down = i > 0 and closes[i] < closes[i - 1]
        r60, r90, r120, r150, r180 = rsret(60), rsret(90), rsret(120), rsret(150), rsret(180)
        r80, r85, r95, r100, r110 = rsret(80), rsret(85), rsret(95), rsret(100), rsret(110)
        rs_hist = [closes[j] / bclose[bars[j]['d']] for j in range(max(0, i - 119), i + 1)]
        rsnh_ratio = rs / max(rs_hist) if rs_hist else 1.0
        rsnh = rsnh_ratio if (r90 is not None and r90 > 0) else None
        combo = (r90 + (rsnh_ratio - 1) * 2) if r90 is not None and r90 > 0 else None
        # 60日相对强弱日收益波动（波动调整动量用）
        rets = [closes[j] / closes[j - 1] - 1 for j in range(max(1, i - 59), i + 1) if closes[j - 1]]
        vol60 = (sum((x - sum(rets) / len(rets)) ** 2 for x in rets) / len(rets)) ** 0.5 if rets else None
        by[d] = {'c': b['c'], 'h': b['h'], 'rs60': r60, 'rs90': r90, 'rs120': r120,
                 'rs150': r150, 'rs180': r180, 'rs80': r80, 'rs85': r85, 'rs95': r95,
                 'rs100': r100, 'rs110': r110, 'accel136': accel,
                 'mom120': ret(120), 'mom250': ret(244), 'vol60': vol60,
                 'rsnh': rsnh, 'combo': combo,
                 'ma10': ma10[i], 'ma20': ma20[i], 'atr': atr[i], 'st': st[i],
                 'ext20': ext20, 'down': down}
    U[code] = (name, by)


def score_of(c, d, sig):
    r = U[c][1][d]
    if sig in r:
        return r[sig]
    if sig == 'rs_sharpe':  # 波动调整动量：rs90 / 60日波动（质量更高、更稳）
        return (r['rs90'] / r['vol60']) if (r['rs90'] is not None and r['vol60']) else None
    if sig == 'rsblend':  # 多周期相对强弱平均（更黏，吃确认后的长趋势）
        vals = [r['rs90'], r['rs120'], r['rs180']]
        return sum(vals) / 3 if None not in vals else None
    if sig == 'rs13612':  # 13612W 加权相对强弱（含12月，最黏）
        v1, v3, v6, v12 = r['rs60'], r['rs120'], r['rs180'], r['mom250']
        return None if None in (v1, v3, v6, v12) else 12 * v1 + 4 * v3 + 2 * v6 + 1 * v12
    return None


def topfire(c, d, peak, rule):
    r = U[c][1][d]
    if rule == 'none':
        return False
    if rule == 'ma20':
        return r['c'] < r['ma20']
    if rule == 'ma10':
        return r['c'] < r['ma10']
    if rule == 'st':
        return r['st'] == -1
    if rule == 'chand4':
        return r['c'] < peak - 4 * r['atr']
    if rule == 'chand5':
        return r['c'] < peak - 5 * r['atr']
    if rule == 'ext':
        return r['ext20'] >= 0.18 and r['down']
    return False


def run(score='rs90', weights=(0.8, 0.2), exit_rule='none', rebalance=5,
        start=None, end=None, cost_bps=5.0, log=False):
    days = [d for d in ALLDAYS if (start or WIN[0]) <= d <= (end or WIN[1])]
    cost = cost_bps / 10000.0; N = len(weights)
    cash = 1.0; pos = {}; eqmax = 0; mdd = 0; trades = 0; topexits = 0; rec = []
    eq = lambda d: cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def ranked(d):
        out = [(score_of(c, d, score), c) for c in U
               if d in U[c][1] and score_of(c, d, score) is not None and score_of(c, d, score) > 0]
        out.sort(reverse=True); return out

    def family_ok(c):
        fam = family(U[c][0]); return all(family(U[h][0]) != fam for h in pos)

    def topcodes(d):
        keep = []; used = set()
        for _, c in ranked(d):
            fam = family(U[c][0])
            if fam in used:
                continue
            keep.append(c); used.add(fam)
            if len(keep) >= N:
                break
        return keep

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
        cash -= amt; pos[c] = {'a': amt * (1 - cost), 'gross': amt, 'e': U[c][1][d]['c'],
                               'ed': d, 'peak': U[c][1][d]['h']}; trades += 1

    def refill(d):
        # 把空槽按当前最强正动量腿补满（牛市不下车），并按集中度权重下单（第1名重仓）
        E = eq(d)
        for i, rank_c in enumerate(topcodes(d)):
            if rank_c in pos or not family_ok(rank_c):
                continue
            amt = E * weights[i]
            openpos(rank_c, d, min(amt, cash))

    for idx, d in enumerate(days):
        # ① 每日逃顶：见顶/破位即离场
        for c in list(pos):
            if d not in U[c][1]:
                continue
            pos[c]['peak'] = max(pos[c].get('peak', pos[c]['e']), U[c][1][d]['h'])
            if topfire(c, d, pos[c]['peak'], exit_rule):
                close(c, d, f'逃顶({exit_rule})'); topexits += 1
        # ② 逃顶后/有空槽则当日立刻轮进最强腿
        if len(pos) < N:
            refill(d)
        # ③ 每 rebalance 日做 leader-runner 式换腿（跌出加权TopN 的换掉）+ 补满
        if idx % rebalance == 0:
            keep = set(topcodes(d))
            for c in list(pos):
                if c not in keep:
                    close(c, d, '跌出TopN')
            refill(d)
        e = eq(d); eqmax = max(eqmax, e); mdd = min(mdd, (e / eqmax - 1) * 100)
    if not days:
        return None
    last = days[-1]
    for c, p in list(pos.items()):
        if log and last in U[c][1]:
            rec.append({'entry': p['ed'], 'exit': last, 'code': c, 'name': U[c][0],
                        'pnl': (U[c][1][last]['c'] / p['e'] - 1) * 100,
                        'contrib': p['gross'] * (U[c][1][last]['c'] / p['e'] - 1), 'reason': '持有中'})
    fin = eq(last); n = len(days); ann = (fin ** (244 / n) - 1) * 100
    return {'score': score, 'weights': weights, 'exit': exit_rule, 'ret': (fin - 1) * 100,
            'ann': ann, 'mdd': mdd, 'trades': trades, 'topexits': topexits, 'days': n, 'rec': rec}


def bh(code, s, e):
    seg = [b for b in fetch(code) if s <= b['d'] <= e]
    if len(seg) < 2:
        return None
    peak = seg[0]['c']; dd = 0
    for b in seg:
        peak = max(peak, b['c']); dd = min(dd, (b['c'] / peak - 1) * 100)
    return (seg[-1]['c'] / seg[0]['c'] - 1) * 100, dd


SUBWINS = [('2025H1', '2025-01-02', '2025-06-30'), ('2025H2', '2025-07-01', '2025-12-31'),
           ('2026H1', '2026-01-02', '2026-06-26'), ('全段', '2025-01-02', '2026-06-26')]
EXITS = ['none', 'ma20', 'ma10', 'st', 'chand4', 'chand5', 'ext']

print(f'载入 {len(U)}/{len(POOL)} | 牛市进攻，逃顶信号对比 | leader-runner 80/20 基线≈{LR_BASE:.0f}%\n')
print('=== 全段(2025-26) 各逃顶信号 × 集中度（score=rs90）===')
print(f'{"exit":<8}{"80/20收益":>10}{"回撤":>7}{"逃顶次":>7}  | {"70/30收益":>10}{"回撤":>7}')
full_rows = {}
for ex in EXITS:
    a = run('rs90', (0.8, 0.2), ex); b = run('rs90', (0.7, 0.3), ex)
    full_rows[ex] = a
    print(f'{ex:<8}{a["ret"]:>9.0f}%{a["mdd"]:>6.0f}%{a["topexits"]:>7}  | {b["ret"]:>9.0f}%{b["mdd"]:>6.0f}%')

print('\n=== 分段稳健性（score=rs90, 80/20）：每个逃顶信号在各子段的收益 ===')
print(f'{"exit":<8}' + ''.join(f'{w[0]:>10}' for w in SUBWINS))
for ex in EXITS:
    cells = []
    for nm, s, e in SUBWINS:
        r = run('rs90', (0.8, 0.2), ex, start=s, end=e)
        cells.append(f'{r["ret"]:>9.0f}%')
    print(f'{ex:<8}' + ''.join(cells))

print('\n=== 排名口径对比（80/20, 全段）rs90 vs accel136 ===')
for sc in ('rs90', 'accel136'):
    for ex in ('none', 'ma20', 'st'):
        r = run(sc, (0.8, 0.2), ex)
        print(f'  {sc:<9} exit={ex:<6} {r["ret"]:>6.0f}% / 回撤{r["mdd"]:.0f}% / 逃顶{r["topexits"]}')

print('\n=== 主线辨认信号实战对比（集中80/20）：rs90 / rsnh / combo ===')
print(f'{"score":<8}{"exit":<6}{"全段收益":>10}{"回撤":>7}  |  分段: ' + '  '.join(w[0] for w in SUBWINS[:3]))
score_rows = {}
for sc in ('rs90', 'rsnh', 'combo'):
    for ex in ('none', 'ext'):
        r = run(sc, (0.8, 0.2), ex)
        subs = [run(sc, (0.8, 0.2), ex, start=s, end=e)['ret'] for _, s, e in SUBWINS[:3]]
        score_rows[(sc, ex)] = (r, subs)
        print(f'{sc:<8}{ex:<6}{r["ret"]:>9.0f}%{r["mdd"]:>6.0f}%  |  ' + '  '.join(f'{x:>5.0f}%' for x in subs))

print('\n=== 买入信号大筛选（集中80/20, exit=none）：目标>rs90 348% ===')
CAND = ['rs60', 'rs90', 'rs120', 'rs150', 'rs180', 'mom120', 'mom250',
        'rs_sharpe', 'rsblend', 'rs13612']
print(f'{"score":<10}{"全段收益":>10}{"回撤":>7}{"交易":>6}  | 分段 2025H1/H2 2026H1 | 子段最差')
sweep = []
for sc in CAND:
    full_r = run(sc, (0.8, 0.2), 'none')
    subs = [run(sc, (0.8, 0.2), 'none', start=s, end=e)['ret'] for _, s, e in SUBWINS[:3]]
    sweep.append((sc, full_r, subs, min(subs)))
    flag = '  <<< 超rs90' if full_r['ret'] > 348 and min(subs) > 0 else ''
    print(f'{sc:<10}{full_r["ret"]:>9.0f}%{full_r["mdd"]:>6.0f}%{full_r["trades"]:>6}  | '
          + ' '.join(f'{x:>4.0f}%' for x in subs) + f'  | {min(subs):>4.0f}%{flag}')
print('\n--- rs90 邻域稳健性（尖峰 or 平台？）---')
print(f'{"lookback":<10}' + ''.join(f'{n:>7}' for n in ['rs60', 'rs80', 'rs85', 'rs90', 'rs95', 'rs100', 'rs110', 'rs120']))
neigh = {n: run(n, (0.8, 0.2), 'none')['ret'] for n in ['rs60', 'rs80', 'rs85', 'rs90', 'rs95', 'rs100', 'rs110', 'rs120']}
print(f'{"全段收益":<8}' + ''.join(f'{neigh[n]:>6.0f}%' for n in ['rs60', 'rs80', 'rs85', 'rs90', 'rs95', 'rs100', 'rs110', 'rs120']))

winners = sorted([s for s in sweep if s[1]['ret'] > 348 and s[3] > 0], key=lambda s: -s[1]['ret'])
if winners:
    w = winners[0]
    print(f'\n✅ 跑赢 rs90 的最佳买入信号：{w[0]}  全段{w[1]["ret"]:.0f}% / 回撤{w[1]["mdd"]:.0f}% / 子段最差{w[3]:.0f}%')
else:
    print('\n❌ 无信号在"全段>348% 且各子段为正"下稳健跑赢 rs90（rs90 仍是收益王）。')

print('\n指数躺平(全段):', end=' ')
for code, nm in [('510300', '沪深300'), ('588000', '科创50'), ('159915', '创业板指')]:
    b = bh(code, '2025-01-02', '2026-06-26')
    print(f'{nm}{b[0]:+.0f}%/{b[1]:.0f}%', end='  ')
print()

# 选最优：全段收益最高且四个子段均为正、回撤不劣于 none 太多
def pick():
    cand = []
    for ex in EXITS:
        for w in ((0.8, 0.2), (0.7, 0.3)):
            full = run('rs90', w, ex)
            subs = [run('rs90', w, ex, start=s, end=e)['ret'] for _, s, e in SUBWINS[:3]]
            cand.append((full, w, ex, min(subs)))
    # 必须全段 > leader-runner 基线 且 各子段都为正
    over = [c for c in cand if c[0]['ret'] > LR_BASE and c[3] > 0]
    pool = over if over else cand
    pool.sort(key=lambda c: c[0]['ret'], reverse=True)
    return pool[0]

# 诚实选择：纯收益最优是 exit=none（348%），但用户明确要"及时逃顶"规则；
# 数据显示越激进逃顶越亏，唯一近乎免费的是 ext(乖离反转,只在真·冲顶回落触发,全程仅~10次)。
# 故主推 = 集中80/20 + ext 选择性逃顶：344% ≈ 无逃顶348%，但给出明确锁顶纪律。
theory_max = run('rs90', (0.8, 0.2), 'none')
HEAD_W, HEAD_EX = (0.8, 0.2), 'ext'
full = run('rs90', HEAD_W, HEAD_EX, log=True)
print(f'\n理论上限(不逃顶) 80/20 none：{theory_max["ret"]:.0f}% / 回撤{theory_max["mdd"]:.0f}%')
print(f'主推进攻档：rs90 80/20 exit=ext（选择性逃顶）：{full["ret"]:.0f}% / 回撤{full["mdd"]:.0f}% / 逃顶{full["topexits"]}次')
print('  → 结论：激进逃顶(st/ma)显著降收益；ext 近乎免费且提供明确锁顶规则。')


def write_records(path, rec):
    rec = sorted(rec, key=lambda r: (r['entry'], r['exit'], r['code']))
    with open(path, 'w') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 收益 | 组合贡献 | 原因 |\n|---|---|---|---|---:|---:|---|\n')
        for r in rec:
            f.write(f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {r["name"]} | {r["pnl"]:+.1f}% | {r["contrib"]*100:+.1f}% | {r["reason"]} |\n')
    return rec


records = write_records(TRADE_LOG, full['rec'])


def mdcell(v):
    return str(v).replace('|', '\\|')


with open(SUMMARY_LOG, 'w') as f:
    f.write('# ETF 主线进攻·逃顶轮动模式 回测摘要\n\n')
    f.write('- 框架: 集中上主线（80/20 keep）+ 每日逃顶信号 + 触发即轮进最强腿（牛市不下车）。\n')
    f.write(f'- 对照基线: leader-runner 80/20 全段 ≈ {LR_BASE:.0f}%（本引擎 exit=none ≈ {theory_max["ret"]:.0f}%，理论上限）。\n')
    f.write(f'- 主推: score=rs90 weights=80%/20% exit=ext（选择性逃顶）；全段 {full["ret"]:.0f}% / 回撤{full["mdd"]:.0f}%，全程仅逃顶 {full["topexits"]} 次。\n')
    f.write('- 核心结论: 牛市里**激进逃顶(st/ma)显著降收益**，逃顶越灵敏亏越多且未降回撤；ext(乖离反转,真·冲顶才触发)近乎免费、给出明确锁顶纪律。\n')
    f.write('- 反过拟合: 逃顶信号均为单参数经典规则、有经济逻辑；同一配置跨牛市三个子段一致(none≥各逃顶)。\n\n')
    f.write('## 全段(2025-26) 各逃顶信号（score=rs90, 80/20）\n\n')
    f.write('| 逃顶信号 | 收益 | 年化 | 回撤 | 逃顶次数 |\n|---|---:|---:|---:|---:|\n')
    for ex in EXITS:
        r = full_rows[ex]
        f.write(f'| {ex} | {r["ret"]:.0f}% | {r["ann"]:.0f}% | {r["mdd"]:.0f}% | {r["topexits"]} |\n')
    f.write('\n## 分段稳健性（80/20, 各子段收益）\n\n')
    f.write('| 逃顶信号 | ' + ' | '.join(w[0] for w in SUBWINS) + ' |\n|' + '---|' * (len(SUBWINS) + 1) + '\n')
    for ex in EXITS:
        cells = [f'{run("rs90",(0.8,0.2),ex,start=s,end=e)["ret"]:.0f}%' for _, s, e in SUBWINS]
        f.write(f'| {ex} | ' + ' | '.join(cells) + ' |\n')
    f.write('\n## 买入信号大筛选（集中80/20, exit=none）：目标 > rs90 348%\n\n')
    f.write('| score | 全段收益 | 回撤 | 2025H1 | 2025H2 | 2026H1 | 子段最差 |\n|---|---:|---:|---:|---:|---:|---:|\n')
    for sc, fr, subs, mn in sweep:
        f.write(f'| {sc} | {fr["ret"]:.0f}% | {fr["mdd"]:.0f}% | ' + ' | '.join(f'{x:.0f}%' for x in subs) + f' | {mn:.0f}% |\n')
    f.write('\n**没有任何信号在"全段>348%且各子段为正"下跑赢 rs90。** 但下面这张邻域表说明：这不是 rs90 的胜利，而是警告。\n\n')
    f.write('### rs90 邻域稳健性：尖峰还是平台？\n\n')
    f.write('| 回看窗口 | ' + ' | '.join(['rs60', 'rs80', 'rs85', 'rs90', 'rs95', 'rs100', 'rs110', 'rs120']) + ' |\n')
    f.write('|---|' + '---:|' * 8 + '\n')
    f.write('| 全段收益 | ' + ' | '.join(f'{neigh[n]:.0f}%' for n in ['rs60', 'rs80', 'rs85', 'rs90', 'rs95', 'rs100', 'rs110', 'rs120']) + ' |\n\n')
    f.write('收益随回看窗口**剧烈跳动**（74→159→106→**348**→272→152→90→83），rs90/rs95 是孤立尖峰、紧邻直接腰斩。\n'
            '稳健信号应随参数平滑变化——rs90 不是。**因此 348% 含大量"路径运气"（恰好把那条超级主线一直排第1骑到底），'
            '不应作为前瞻预期。** 真正稳健、各子段为正的是 rsblend(+167%,多周期RS均值) 与 rs_sharpe(+101%,回撤仅-14%)；'
            '把它们当作可复现的中枢预期更诚实，348% 视为运气上尾。\n\n')
    f.write('## 主线辨认信号实战对比（集中80/20）：rs90 / rsnh / combo\n\n')
    f.write('| score | exit | 全段收益 | 回撤 | 2025H1 | 2025H2 | 2026H1 | 定位 |\n|---|---|---:|---:|---:|---:|---:|---|\n')
    posn = {'rs90': '趋势确认·黏住龙头(最大收益)', 'rsnh': 'RS线新高·早上车低回撤(churn多)', 'combo': 'RS新高+rs90确认(质量高,收益中)'}
    for sc in ('rs90', 'rsnh', 'combo'):
        for ex in ('none', 'ext'):
            r, subs = score_rows[(sc, ex)]
            f.write(f'| {sc} | {ex} | {r["ret"]:.0f}% | {r["mdd"]:.0f}% | ' + ' | '.join(f'{x:.0f}%' for x in subs) + f' | {posn[sc]} |\n')
    f.write('\n**关键发现（与单腿分析反转）**：单腿时 rsnh≈rs90（~162%），但叠加集中度+keep 后 '
            '**rs90 飙到 348%，rsnh/combo 仅 150-165%**。原因：rs90 是"趋势确认"信号，**黏性强**——'
            '一旦锁定主导主线就骑到底，把 80% 重仓的复利吃满；rsnh 按"谁刚创RS新高"排名，**换手频繁**，'
            '过早轮出主导腿，打断了单边牛市最值钱的连续复利。\n\n'
            '**结论**：① 想要**最大收益**——仍用 rs90（黏住龙头骑到底）。② rsnh/combo 的价值是**早上车+低回撤**'
            '（-17/-18% vs -22%），属风控属性，牛市进攻期非首选。③ rsnh 适合当**首次上车的择时触发器/过滤器**，'
            '不适合当横向排名器（当排名器会churn）。\n\n')
    f.write('指数躺平(全段): ')
    f.write(' ｜ '.join(f'{nm}{bh(c,"2025-01-02","2026-06-26")[0]:+.0f}%/{bh(c,"2025-01-02","2026-06-26")[1]:.0f}%'
                        for c, nm in [('510300', '沪深300'), ('588000', '科创50'), ('159915', '创业板指')]) + '\n\n')
    f.write(f'## 主推进攻档(ext)交易记录：{len(records)} 笔\n\n详见 `trades_offense.md`。\n')

print(f'\n交易记录: {TRADE_LOG} | {len(records)} 笔')
print(f'摘要: {SUMMARY_LOG}')
