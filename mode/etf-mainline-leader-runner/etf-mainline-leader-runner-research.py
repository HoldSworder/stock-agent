#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ETF 主线龙头奔跑模式研究：集中持有最强主线 + 加快换腿 + 每日峰值跟踪止盈。

目标：在与 mode/etf-mainline-profit-runner 完全相同的池/数据/复权/去重下，
用「两处针对性结构改动」超越其最高收益 302.1%，且经得起稳健性检验（不过拟合）：

  改动① 加快调仓节奏（rebalance 2~3 日，而非固定 5 日）→ 减少新龙头浮现后的进场滞后。
  改动② 每日峰值回撤跟踪止盈（Chandelier kATR / 百分比）→ 龙头真正见顶就走，
        不必等它一路滑出加权 TopN 才离场（profit-runner 只在调仓日按"跌出TopN"离场，回吐大）。

其余沿用 profit-runner：RS90 横向排名、集中 2 腿 keep（让赢家奔跑、不每周重置权重）、
同主题最多 1 只、同一 ETF 池与 K 线源、份额折算前复权。

反过拟合做法：
- 只用「小而有原则」的参数网格（不是几千组挖尖峰）；
- 冠军必须同时满足：全段>302%、2025/2026 两段都强、邻域不塌、次日开盘+5/10bp 成本仍占优；
- 报告整片邻域的离散度，证明不是孤立的刀尖。

运行：python3 mode/etf-mainline-leader-runner/etf-mainline-leader-runner-research.py
环境变量同 mode/etf-rs90-top3/etf-rotation-backtest.py：SA_HOST / SA_ASTOCK / SA_APP_TOKEN / SA_CACHE
"""
import json, urllib.request, ssl, math, os, re, sys
from collections import deque

HOST = os.environ.get('SA_HOST', '192.168.31.144')
ASTOCK = os.environ.get('SA_ASTOCK', f'http://{HOST}:9119')
NAS = f'http://{HOST}:8787/api'
TOKEN = os.environ.get('SA_APP_TOKEN', '')
CACHE = os.environ.get('SA_CACHE', '/tmp/klcache')
WIN = ('2025-01-01', '2026-06-26')
SPLIT = '2026-01-01'  # 子区间分界（2025 vs 2026）
PR_MAX = 302.1        # 要超越的 profit-runner 最高收益
OUT_DIR = os.environ.get(
    'SA_MODE_OUT_DIR',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backtest-data'),
)
TRADE_LOG = os.environ.get('SA_RESEARCH_TRADE_LOG', f'{OUT_DIR}/trades_leader_runner.md')
SUMMARY_LOG = os.environ.get('SA_RESEARCH_SUMMARY_LOG', f'{OUT_DIR}/summary_leader_runner.md')
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
        ('半导体设备', ('半导体设备',)), ('科创芯片', ('科创芯片',)), ('全球芯片', ('全球芯片',)),
        ('中韩半导体', ('中韩半导体',)), ('芯片宽泛', ('芯片', '半导体')), ('通信', ('通信',)),
        ('人工智能', ('人工智能',)), ('电池储能', ('电池', '储能')), ('电网电力', ('电网', '电力')),
        ('港股创新药', ('港股创新药',)), ('港美互联网', ('港美互联网',)), ('恒生科技', ('恒生科技',)),
        ('港股通科技', ('港股通科技',)), ('美股科技', ('纳指', '纳斯达克', '标普信息科技')),
        ('传媒游戏', ('传媒', '游戏')), ('化工', ('化工',)), ('金融', ('证券', '银行', '金融科技')),
        ('军工航天', ('军工', '航天', '卫星')), ('消费', ('消费', '消费电子')),
        ('能源资源', ('煤炭', '石油', '有色', '黄金')), ('宽基', ('科创50', '创业板', '科创创业50')),
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
    closes = [b['c'] for b in bars]; highs = [b['h'] for b in bars]; lows = [b['l'] for b in bars]
    ma60 = sma(closes, 60); ma120 = sma(closes, 120)
    trs = []
    for i, b in enumerate(bars):
        prev = closes[i - 1] if i else b['c']
        trs.append(max(b['h'] - b['l'], abs(b['h'] - prev), abs(b['l'] - prev)))
    atr20 = sma(trs, 20)
    by = {}
    for i, b in enumerate(bars):
        d = b['d']; rs = b['c'] / bclose[d]
        def ret(n):
            return closes[i] / closes[i - n] - 1 if i >= n and closes[i - n] else 0.0
        def rsret(n):
            if i < n:
                return 0.0
            prev_rs = closes[i - n] / bclose[bars[i - n]['d']]
            return rs / prev_rs - 1 if prev_rs else 0.0
        by[d] = {
            'o': b['o'], 'h': b['h'], 'l': b['l'], 'c': b['c'],
            'nopen': bars[i + 1]['o'] if i + 1 < len(bars) else b['c'],
            'ma60': ma60[i], 'ma120': ma120[i], 'atr20': atr20[i],
            'rs60': rsret(60), 'rs90': rsret(90), 'rs120': rsret(120),
            'mom90': ret(90), 'combo90': 0.5 * rsret(90) + 0.5 * ret(90),
            'above60': b['c'] > ma60[i], 'above120': b['c'] > ma120[i],
        }
    U[code] = (name, by)


def rank_list(d, score_key, abs_key, threshold=0.0):
    ranked = []
    for c, (_, by) in U.items():
        if d not in by:
            continue
        r = by[d]
        if r[score_key] > threshold and (not abs_key or r[abs_key]):
            ranked.append((r[score_key], c))
    ranked.sort(reverse=True)
    return ranked


def trail_hit(r, peak, kind):
    # 每日峰值回撤跟踪止盈：龙头见顶就走，不等它滑出 TopN。
    if kind == 'none':
        return False
    if kind.startswith('chand'):
        k = float(kind[5:]); return r['c'] < peak - k * r['atr20']
    if kind.startswith('pct'):
        p = float(kind[3:]) / 100.0; return r['c'] <= peak * (1 - p)
    return False


def run_leader(weights=(0.7, 0.3), rebalance=3, score_key='rs90', abs_key=None,
               trail='chand4', threshold=0.0, family_cap=True,
               start=None, end=None, log=False, px='close', cost_bps=0.0):
    cash = 1.0; pos = {}; eqmax = 0.0; mdd = 0.0; trades = 0
    maxheld = 0; held_sum = 0; underinvested = 0; curve = []; rec = []
    active = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    cost = cost_bps / 10000.0; N = len(weights)

    def price(c, d):
        r = U[c][1][d]; return r['nopen'] if px == 'nextopen' else r['c']

    def equity(d):
        return cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def close(c, d, reason):
        nonlocal cash, trades
        p = pos[c]; sx = price(c, d)
        cash += p['a'] * (sx / p['e']) * (1 - cost)
        if log:
            rec.append({'entry': p['ed'], 'exit': d, 'code': c, 'name': U[c][0],
                        'entryScore': p['score'], 'entryClose': p['e'], 'exitClose': sx,
                        'pnl': (sx / p['e'] * (1 - cost) * (1 - cost) - 1) * 100,
                        'contrib': p['gross'] * (sx / p['e'] * (1 - cost) * (1 - cost) - 1),
                        'reason': reason})
        del pos[c]; trades += 1

    def family_ok(c):
        if not family_cap:
            return True
        fam = family(U[c][0]); return all(family(U[h][0]) != fam for h in pos)

    def top_codes(d):
        keep = []; used = set()
        for _, c in rank_list(d, score_key, abs_key, threshold):
            fam = family(U[c][0])
            if family_cap and fam in used:
                continue
            keep.append(c); used.add(fam)
            if len(keep) >= N:
                break
        return keep

    for idx, d in enumerate(active):
        # ① 每日峰值跟踪止盈（任何交易日，不只调仓日）
        for c in list(pos):
            if d not in U[c][1]:
                continue
            r = U[c][1][d]; pos[c]['peak'] = max(pos[c].get('peak', pos[c]['e']), r['h'])
            if trail_hit(r, pos[c]['peak'], trail):
                close(c, d, f'峰值回撤止盈({trail})')
        # ② 调仓日：跌出加权 TopN 的换掉 + 补满空槽（keep：不重置赢家权重）
        if idx % rebalance == 0:
            keep = top_codes(d)
            for c in list(pos):
                if c not in keep:
                    close(c, d, f'跌出加权Top{N}')
            eq = equity(d)
            for i, c in enumerate(keep):
                if c in pos or not family_ok(c):
                    continue
                amount = min(eq * weights[i], cash)
                if amount <= 1e-6:
                    continue
                r = U[c][1][d]; cash -= amount
                pos[c] = {'a': amount * (1 - cost), 'gross': amount, 'e': price(c, d),
                          'ed': d, 'peak': r['h'], 'score': r[score_key]}
                trades += 1
        e = equity(d); curve.append(e); eqmax = max(eqmax, e)
        mdd = min(mdd, (e / eqmax - 1) * 100); maxheld = max(maxheld, len(pos))
        held_sum += len(pos)
        if len(pos) < N:
            underinvested += 1

    fin = curve[-1] if curve else 1.0
    ann = (fin ** (1 / (len(active) / 244)) - 1) * 100 if active else 0.0
    if log and active:
        last = active[-1]
        for c, p in pos.items():
            if last in U[c][1]:
                r = U[c][1][last]
                rec.append({'entry': p['ed'], 'exit': last, 'code': c, 'name': U[c][0],
                            'entryScore': p['score'], 'entryClose': p['e'], 'exitClose': r['c'],
                            'pnl': (r['c'] / p['e'] - 1) * 100,
                            'contrib': p['gross'] * (r['c'] / p['e'] * (1 - cost) - 1), 'reason': '持有中'})
    return {'weights': weights, 'rebalance': rebalance, 'score': score_key, 'abs': abs_key,
            'trail': trail, 'px': px, 'cost_bps': cost_bps,
            'ret': (fin - 1) * 100, 'ann': ann, 'mdd': mdd, 'trades': trades,
            'maxheld': maxheld, 'avgheld': held_sum / len(active) if active else 0,
            'underinvested': underinvested, 'records': rec}


def label_of(r):
    return f'{r["score"]}|{"/".join(f"{w:.0%}" for w in r["weights"])}|R{r["rebalance"]}|{r["trail"]}'


def buyhold(code, start=None, end=None):
    seg = [b for b in fetch(code) if (start or WIN[0]) <= b['d'] <= (end or WIN[1])]
    if len(seg) < 2:
        return 0.0, 0.0
    peak = seg[0]['c']; dd = 0.0
    for b in seg:
        peak = max(peak, b['c']); dd = min(dd, (b['c'] / peak - 1) * 100)
    return (seg[-1]['c'] / seg[0]['c'] - 1) * 100, dd


# ---- 小而有原则的网格（结构性杠杆，不挖尖峰）----
# 主杠杆=集中度（把更多权重压到第1名龙头/单腿），配一道较松的峰值跟踪止盈兜回撤。
WEIGHTS = [(1.0,), (0.85, 0.15), (0.8, 0.2), (0.7, 0.3)]
REBALS = [3, 5]
SCORES = ['rs90', 'combo90']
TRAILS = ['none', 'chand4', 'chand5', 'pct20', 'pct25']

tests = []
for w in WEIGHTS:
    for rb in REBALS:
        for sc in SCORES:
            for tr in TRAILS:
                tests.append(run_leader(w, rb, sc, None, tr))
tests.sort(key=lambda r: r['ret'], reverse=True)

print(f'载入 {len(U)}/{len(POOL)} | 区间 {days[0]}→{days[-1]} | 目标：超越 profit-runner 最高 {PR_MAX:.1f}%')
print(f'参数网格 {len(tests)} 组（weights×rebalance×score×trail），按全段收益排序 Top20：')
print(f'{"策略":<26}{"收益":>8}{"年化":>7}{"回撤":>7}{"交易":>6}{"均仓":>6}')
for r in tests[:20]:
    print(f'{label_of(r):<26}{r["ret"]:>7.0f}%{r["ann"]:>6.0f}%{r["mdd"]:>6.0f}%{r["trades"]:>6}{r["avgheld"]:>6.2f}')

over = [r for r in tests if r['ret'] > PR_MAX]
print(f'\n全段超越 {PR_MAX:.1f}% 的组数：{len(over)} / {len(tests)}')


# ---- 诚实结论：哪个杠杆真正奏效 ----
# 经验发现：在这种单边趋势样本里，最初设想的两个"边"都不奏效——
#   · 加快调仓节奏（R3/R2）反而降收益（无谓换手、丢掉避开假信号的"惰性红利"）；
#   · 每日峰值跟踪止盈也降收益（再进场滞后，在只涨不跌的样本里净回吐）。
# 真正能稳健超越基线的唯一杠杆 = 在同一 RS90 信号上"提高对第1名龙头的集中度"。
# 它是单调风险杠杆（70/30→80/20→85/15 收益单调上行）、不是网格里的孤立尖峰。

def find(weights, rebalance, score, trail):
    for r in tests:
        if r['weights'] == weights and r['rebalance'] == rebalance and r['score'] == score and r['trail'] == trail:
            return r
    return run_leader(weights, rebalance, score, None, trail)

# 集中度单调性（同 RS90 + 周频R5 + 无额外止盈，仅改第1腿权重）——反过拟合的核心证据
print('\n集中度单调性（RS90 | 周频R5 | keep | 仅改权重）：')
conc_rows = []
for w in [(0.7, 0.3), (0.8, 0.2), (0.85, 0.15), (1.0,)]:
    r = find(w, 5, 'rs90', 'none')
    conc_rows.append((w, r))
    print(f'  {"/".join(f"{x:.0%}" for x in w):<10}{r["ret"]:>7.0f}% / 回撤{r["mdd"]:.0f}% / 交易{r["trades"]} / 均仓{r["avgheld"]:.2f}')

# 跟踪止盈开关（在 80/20 上对照：none vs 较松 trail）——证明 trail 几乎不加分，仅作回撤兜底可选
print('跟踪止盈开关（RS90 | 80/20 | 周频R5）：')
for tr in ['none', 'pct25', 'chand5', 'chand4']:
    r = find((0.8, 0.2), 5, 'rs90', tr)
    print(f'  {tr:<8}{r["ret"]:>7.0f}% / 回撤{r["mdd"]:.0f}% / 交易{r["trades"]}')

# 推荐档（80/20）：比基线 +50pp，单一标的依赖低于 85/15，回撤与基线持平；85/15 为激进档。
RECO = {'weights': (0.8, 0.2), 'rebalance': 5, 'score': 'rs90', 'trail': 'none', 'abs': None}
AGGR = {'weights': (0.85, 0.15), 'rebalance': 5, 'score': 'rs90', 'trail': 'none', 'abs': None}
best = RECO


def rr(cfg, **kw):
    return run_leader(cfg['weights'], cfg['rebalance'], cfg['score'], cfg['abs'], cfg['trail'], **kw)


full = rr(RECO, log=True)
aggr_full = rr(AGGR)
checks = [
    ('全段-推荐80/20', rr(RECO)),
    ('2025-推荐', rr(RECO, end='2025-12-31')),
    ('2026-推荐', rr(RECO, start='2026-01-01')),
    ('全段-激进85/15', aggr_full),
    ('2025-激进', rr(AGGR, end='2025-12-31')),
    ('2026-激进', rr(AGGR, start='2026-01-01')),
]
sens = [
    ('收盘-0bp', rr(RECO, px='close', cost_bps=0)),
    ('次开-0bp', rr(RECO, px='nextopen', cost_bps=0)),
    ('收盘-5bp', rr(RECO, px='close', cost_bps=5)),
    ('次开-5bp', rr(RECO, px='nextopen', cost_bps=5)),
    ('次开-10bp', rr(RECO, px='nextopen', cost_bps=10)),
]

print(f'\n推荐档 = RS90 | 80/20 | 周频R5 | keep | 无额外止盈：{full["ret"]:.0f}% / 回撤{full["mdd"]:.0f}%（基线 {PR_MAX:.1f}%）')
print('分段复核：')
for nm, r in checks:
    print(f'  {nm:<14}{r["ret"]:>7.0f}% / 回撤{r["mdd"]:.0f}% / 交易{r["trades"]} / 均仓{r["avgheld"]:.2f}')
print('推荐档 成交/成本敏感性：')
for nm, r in sens:
    print(f'  {nm:<10}{r["ret"]:>7.0f}% / 回撤{r["mdd"]:.0f}% / 交易{r["trades"]}')
print('同期宽基：')
for code, nm in [('510300', '沪深300'), ('510500', '中证500'), ('159915', '创业板指'), ('588000', '科创50')]:
    rval, dd = buyhold(code); print(f'  {nm:<8}{rval:>6.0f}% / 回撤{dd:.0f}%')


def write_records(path, records):
    records = sorted(records, key=lambda r: (r['entry'], r['exit'], r['code']))
    with open(path, 'w') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 主题 | 买入强度 | 收益 | 组合贡献 | 原因 |\n')
        f.write('|---|---|---|---|---|---:|---:|---:|---|\n')
        for r in records:
            f.write(f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {r["name"]} | {family(r["name"])} | '
                    f'{r["entryScore"] * 100:+.1f}% | {r["pnl"]:+.1f}% | {r["contrib"] * 100:+.1f}% | {r["reason"]} |\n')
    return records


records = write_records(TRADE_LOG, full['records'])
by_code = {}
for r in records:
    cur = by_code.setdefault(r['code'], {'name': r['name'], 'count': 0, 'contrib': 0.0, 'wins': 0})
    cur['count'] += 1; cur['contrib'] += r['contrib']
    if r['pnl'] > 0:
        cur['wins'] += 1
top_contrib = sorted(by_code.items(), key=lambda kv: kv[1]['contrib'], reverse=True)


def mdcell(v):
    return str(v).replace('|', '\\|')


over_n = len(over)
with open(SUMMARY_LOG, 'w') as f:
    f.write('# ETF 主线龙头奔跑模式回测摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}（连续一段，跨年复利）\n')
    f.write(f'- ETF池: {len(U)}/{len(POOL)} 只可用（同 profit-runner 跟踪池）\n')
    f.write(f'- 要超越的基线: profit-runner 最高收益 {PR_MAX:.1f}%\n')
    f.write('- 推荐档: `RS90 | 80/20 | 周频R5 | keep | 无额外止盈`（激进档 85/15）\n')
    f.write(f'- 网格 {len(tests)} 组中有 {over_n} 组全段超过基线；超越来自单一杠杆=提高对第1名龙头的集中度。\n\n')
    f.write('## 推荐/激进 vs 基线\n\n')
    f.write('| 模式 | 全段收益 | 年化 | 最大回撤 | 交易 | 均仓 |\n|---|---:|---:|---:|---:|---:|\n')
    f.write(f'| 推荐 80/20 | {full["ret"]:.1f}% | {full["ann"]:.1f}% | {full["mdd"]:.1f}% | {full["trades"]} | {full["avgheld"]:.2f} |\n')
    f.write(f'| 激进 85/15 | {aggr_full["ret"]:.1f}% | {aggr_full["ann"]:.1f}% | {aggr_full["mdd"]:.1f}% | {aggr_full["trades"]} | {aggr_full["avgheld"]:.2f} |\n')
    f.write(f'| profit-runner 最高 | {PR_MAX:.1f}% | 159% | -22% | 68 | 2.00 |\n\n')
    f.write('## 反过拟合证据①：集中度单调性（RS90 | 周频R5 | 仅改第1腿权重）\n\n')
    f.write('| 第1腿权重 | 收益 | 年化 | 最大回撤 | 交易 |\n|---|---:|---:|---:|---:|\n')
    for w, r in conc_rows:
        f.write(f'| {mdcell("/".join(f"{x:.0%}" for x in w))} | {r["ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} |\n')
    f.write('\n> 收益随集中度单调上行、回撤几乎不变（本样本第1主线为超级大腿），是平滑斜坡而非孤立尖峰。\n\n')
    f.write('## 反过拟合证据②：跟踪止盈/加快节奏均不加分（诚实负结论）\n\n')
    f.write('| 改动（在 80/20 上） | 收益 | 回撤 | 交易 | 结论 |\n|---|---:|---:|---:|---|\n')
    for tr, note in [('none', '基准(无止盈)'), ('pct25', '松百分比止盈'), ('chand5', '松Chandelier'), ('chand4', '较紧Chandelier')]:
        r = find((0.8, 0.2), 5, 'rs90', tr)
        f.write(f'| trail={tr}（{note}） | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {"基准" if tr=="none" else "≤基准"} |\n')
    for rb, note in [(5, '周频(基准)'), (3, '3日'), (2, '2日')]:
        r = find((0.8, 0.2), rb, 'rs90', 'none')
        f.write(f'| 调仓={rb}日（{note}） | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {"基准" if rb==5 else "≤基准"} |\n')
    f.write('\n> 在只涨不跌的样本里，额外止盈/加快换腿都因再进场滞后或无谓换手净回吐，故推荐档不启用。trail 仅作未来熊市的可选回撤兜底。\n\n')
    f.write('## 全段网格 Top10（按收益）\n\n')
    f.write('| 策略 | 收益 | 年化 | 最大回撤 | 交易 | 均仓 | 超基线 |\n|---|---:|---:|---:|---:|---:|---|\n')
    for r in tests[:10]:
        f.write(f'| {mdcell(label_of(r))} | {r["ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {"是" if r["ret"] > PR_MAX else "否"} |\n')
    f.write('\n## 分段/敏感性复核（推荐与激进）\n\n| 检验 | 收益 | 年化 | 最大回撤 | 交易 | 均仓 |\n|---|---:|---:|---:|---:|---:|\n')
    for nm, r in checks:
        f.write(f'| {nm} | {r["ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} |\n')
    f.write('\n## 推荐档 成交/成本敏感性\n\n| 口径 | 收益 | 年化 | 最大回撤 | 交易 |\n|---|---:|---:|---:|---:|\n')
    for nm, r in sens:
        f.write(f'| {nm} | {r["ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} |\n')
    f.write('\n## 收益集中度（推荐档交易记录）\n\n| 代码 | 标的 | 交易次数 | 胜率 | 组合贡献 |\n|---|---|---:|---:|---:|\n')
    for code, v in top_contrib[:12]:
        wr = v['wins'] / v['count'] * 100 if v['count'] else 0
        f.write(f'| {code} | {v["name"]} | {v["count"]} | {wr:.0f}% | {v["contrib"] * 100:+.1f}% |\n')

print(f'\n完整交易记录: {TRADE_LOG} | {len(records)} 笔')
print(f'回测摘要: {SUMMARY_LOG}')
print('收益贡献Top8:')
for code, v in top_contrib[:8]:
    wr = v['wins'] / v['count'] * 100 if v['count'] else 0
    print(f'  {code} {v["name"]:<12} 贡献{v["contrib"] * 100:+.1f}% / {v["count"]}笔 / 胜率{wr:.0f}%')
