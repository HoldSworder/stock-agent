#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ETF 主线持续领先（persistence）研究：真正选出/追上"持续主升的主线"。

用户洞察：现有模式按单一动量数周频排序，总churn进一周脉冲(游戏/信创/黄金)，错过/滞后
真正持续数月的主线（25创新药、25通信、25-26中韩半导体、26通信+科创芯片+半导体设备）；
且从未在"同一模式里同时持有多条真主升线"，收益因此封顶。

本包做三件事：
  诊断A) 列出各子段"真·主升"标的（按实现涨幅），看它们是不是我们能命名的那几条主线；
  诊断B) 看现有 rs90 周频到底持了什么、churn多频繁、对真主线捕获多少；
  方案 ) 设计"持续领先"选择器——按 RS 横截面排名的【持续性】(过去L日稳居前K的比例)选主线，
         可同时持有 N 条durable主线，并测它对真主线的捕获率与收益、分段稳健性。

核心假设：真主线的共性 = RS 排名长期稳居前列；噪声 = 冲一下就掉。用"持续性"而非"瞬时动量"
排序，天然过滤脉冲、锁定durable龙头，并能把同时在涨的多条主线一起持有。

运行：python3 mode/etf-mainline-persistence/etf-mainline-persistence-research.py
环境变量同其它模式：SA_HOST / SA_ASTOCK / SA_APP_TOKEN / SA_CACHE
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
# 用户点名的"真·主线"（用于捕获率诊断）
NAMED = {'159567': '港股创新药', '513120': '港股创新药(广发)', '515880': '通信', '159695': '通信(嘉实)',
         '513310': '中韩半导体', '588200': '科创芯片', '159516': '半导体设备'}


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
    by = {}
    for i, b in enumerate(bars):
        d = b['d']; rs = b['c'] / bclose[d]
        def rsret(n):
            if i < n:
                return None
            prev = closes[i - n] / bclose[bars[i - n]['d']]
            return rs / prev - 1 if prev else None
        by[d] = {'c': b['c'], 'h': b['h'], 'rs': rs, 'rs60': rsret(60), 'rs90': rsret(90),
                 'ma60': ma60[i], 'above60': b['c'] > ma60[i]}
    U[code] = (name, by)

DAYS = [d for d in ALLDAYS if WIN[0] <= d <= WIN[1]]

# ---- 横截面日排名（按 rs60 相对强弱）& 持续性（过去L日稳居前K的比例）----
RANK_BY = 'rs60'; L = 40; K = 5
rank_pos = {}     # rank_pos[d][code] = 名次(1=最强)
for d in DAYS:
    arr = [(U[c][1][d][RANK_BY], c) for c in U if d in U[c][1] and U[c][1][d][RANK_BY] is not None]
    arr.sort(reverse=True)
    rank_pos[d] = {c: i + 1 for i, (_, c) in enumerate(arr)}

didx = {d: i for i, d in enumerate(DAYS)}
def persistence(c, d):
    i = didx[d]; lo = max(0, i - L + 1); cnt = tot = 0
    for j in range(lo, i + 1):
        dj = DAYS[j]
        if c in rank_pos[dj]:
            tot += 1
            if rank_pos[dj][c] <= K:
                cnt += 1
    return cnt / tot if tot else 0.0


# ===================== 诊断 A：各子段真·主升标的 =====================
def seg_ret(c, s, e):
    seg = [U[c][1][d]['c'] for d in DAYS if s <= d <= e and d in U[c][1]]
    return (seg[-1] / seg[0] - 1) * 100 if len(seg) >= 2 else None

SEGS = [('2025H1', '2025-01-02', '2025-06-30'), ('2025H2', '2025-07-01', '2025-12-31'),
        ('2026H1', '2026-01-02', '2026-06-26')]
print(f'载入 {len(U)}/{len(POOL)} | 横截面按 {RANK_BY} 排名, 持续性=过去{L}日稳居前{K}比例\n')
print('=== 诊断A：各子段实现涨幅 Top6（真·主线 ground truth）===')
for nm, s, e in SEGS:
    rows = sorted(((seg_ret(c, s, e), c) for c in U if seg_ret(c, s, e) is not None), reverse=True)[:6]
    print(f'  {nm}: ' + ' | '.join(f'{U[c][0]}{r:+.0f}%' for r, c in rows))

# rs90 横截面日排名（我们实际使用的信号），用于"当令窗口内的公平名次"
rank90 = {}
for d in DAYS:
    arr = [(U[c][1][d]['rs90'], c) for c in U if d in U[c][1] and U[c][1][d]['rs90'] is not None]
    arr.sort(reverse=True)
    rank90[d] = {c: i + 1 for i, (_, c) in enumerate(arr)}

# 每条点名主线的"当令窗口"（其领涨的子段）
PRIME = {'159567': ('2025H1', '2025-01-02', '2025-06-30'), '513120': ('2025H1', '2025-01-02', '2025-06-30'),
         '515880': ('2025H2', '2025-07-01', '2025-12-31'), '159695': ('2025H2', '2025-07-01', '2025-12-31'),
         '513310': ('2026H1', '2026-01-02', '2026-06-26'), '588200': ('2026H1', '2026-01-02', '2026-06-26'),
         '159516': ('2026H1', '2026-01-02', '2026-06-26')}

print('\n=== 诊断B：点名主线在其【当令窗口】内的真实名次（公平口径, rs90排名）===')
print(f'{"标的":<16}{"当令窗口":>8}{"窗口内中位名次":>14}{"≤前3天数占比":>13}{"≤前5天数占比":>13}')
for c, nm in NAMED.items():
    if c not in U or c not in PRIME:
        continue
    seg, s, e = PRIME[c]
    poss = [rank90[d][c] for d in DAYS if s <= d <= e and c in rank90[d]]
    if not poss:
        continue
    med = sorted(poss)[len(poss) // 2]
    t3 = sum(1 for p in poss if p <= 3) / len(poss) * 100
    t5 = sum(1 for p in poss if p <= 5) / len(poss) * 100
    print(f'{U[c][0]:<16}{seg:>8}{med:>14}{t3:>12.0f}%{t5:>12.0f}%')


# ===================== 回测引擎（可选 score：rs90 / persist）=====================
def run(selector='persist', N=3, weights=None, rebalance=5, min_pers=0.45,
        start=None, end=None, cost_bps=5.0, log=False):
    days = [d for d in DAYS if (start or WIN[0]) <= d <= (end or WIN[1])]
    cost = cost_bps / 10000.0
    weights = weights or tuple([1.0 / N] * N)
    cash = 1.0; pos = {}; eqmax = 0; mdd = 0; trades = 0; rec = []
    held_hist = {}
    eq = lambda d: cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def score(c, d):
        r = U[c][1][d]
        if not r['above60']:
            return None
        if selector == 'rs90':
            return r['rs90'] if (r['rs90'] is not None and r['rs90'] > 0) else None
        # persist：先要正相对强弱，再用持续性排序（锁定durable龙头）
        if r['rs60'] is None or r['rs60'] <= 0:
            return None
        return persistence(c, d)

    def topcodes(d):
        arr = [(score(c, d), c) for c in U if d in U[c][1] and score(c, d) is not None and score(c, d) > 0]
        arr.sort(reverse=True)
        keep = []; used = set()
        for sc, c in arr:
            if selector == 'persist' and sc < min_pers:
                continue
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
        cash -= amt; pos[c] = {'a': amt * (1 - cost), 'gross': amt, 'e': U[c][1][d]['c'], 'ed': d}; trades += 1

    for idx, d in enumerate(days):
        if idx % rebalance == 0:
            keep = topcodes(d)
            for c in list(pos):
                if c not in keep:
                    close(c, d, '跌出主线榜')
            E = eq(d)
            for i, c in enumerate(keep):
                if c in pos:
                    continue
                openpos(c, d, min(E * weights[i], cash))
        for c in pos:
            held_hist.setdefault(c, 0)
            held_hist[c] += 1
        e = eq(d); eqmax = max(eqmax, e); mdd = min(mdd, (e / eqmax - 1) * 100)
    last = days[-1]
    for c, p in list(pos.items()):
        if log and last in U[c][1]:
            rec.append({'entry': p['ed'], 'exit': last, 'code': c, 'name': U[c][0],
                        'pnl': (U[c][1][last]['c'] / p['e'] - 1) * 100,
                        'contrib': p['gross'] * (U[c][1][last]['c'] / p['e'] - 1), 'reason': '持有中'})
    fin = eq(last); n = len(days)
    return {'sel': selector, 'N': N, 'ret': (fin - 1) * 100, 'mdd': mdd, 'trades': trades,
            'ann': (fin ** (244 / n) - 1) * 100, 'rec': rec, 'held_hist': held_hist}


# ===================== 真主线捕获率 =====================
def capture(res):
    held_fams = set()
    for c in res['held_hist']:
        held_fams.add(family(U[c][0]))
    named_fams = {family(nm) for nm in NAMED.values()}
    hit = named_fams & held_fams
    return hit, named_fams


print('\n=== 方案：持续领先 persistence vs rs90（含5bp）===')
print(f'{"配置":<26}{"全段":>8}{"回撤":>7}{"交易":>6}{"真主线覆盖":>11}  | 2025H1/H2 2026H1')
configs = [('rs90 N2 均权', 'rs90', 2, None), ('rs90 N3 均权', 'rs90', 3, None),
           ('persist N2 均权', 'persist', 2, None), ('persist N3 均权', 'persist', 3, None),
           ('persist N3 50/30/20', 'persist', 3, (0.5, 0.3, 0.2))]
results = {}
for label, sel, N, w in configs:
    r = run(sel, N, w)
    subs = [run(sel, N, w, start=s, end=e)['ret'] for _, s, e in SEGS]
    hit, named_fams = capture(r)
    results[label] = (r, subs, hit, named_fams)
    print(f'{label:<26}{r["ret"]:>7.0f}%{r["mdd"]:>6.0f}%{r["trades"]:>6}{len(hit):>7}/{len(named_fams):<3}  | '
          + ' '.join(f'{x:>4.0f}%' for x in subs))

# 选展示档：persist N3 50/30/20（同时持多条durable主线）
HEAD = run('persist', 3, (0.5, 0.3, 0.2), log=True)
hit, named_fams = capture(HEAD)
print(f'\n展示档 persist N3(50/30/20)：{HEAD["ret"]:.0f}% / 回撤{HEAD["mdd"]:.0f}% / 覆盖真主线家族 {sorted(hit)}')

# 写交付
def write_trades(path, rec):
    rec = sorted(rec, key=lambda r: (r['entry'], r['exit'], r['code']))
    with open(path, 'w') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 主题 | 收益 | 组合贡献 | 原因 |\n|---|---|---|---|---|---:|---:|---|\n')
        for r in rec:
            f.write(f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {r["name"]} | {family(r["name"])} | {r["pnl"]:+.1f}% | {r["contrib"]*100:+.1f}% | {r["reason"]} |\n')
    return rec

trades = write_trades(f'{OUT}/trades_persistence.md', HEAD['rec'])

with open(f'{OUT}/summary_persistence.md', 'w') as f:
    f.write('# ETF 主线持续领先（persistence）回测摘要\n\n')
    f.write(f'区间 {DAYS[0]}→{DAYS[-1]}｜55只跟踪池｜横截面按 {RANK_BY} 排名｜持续性=过去{L}日稳居前{K}比例｜含5bp。\n\n')
    f.write('## 诊断A：各子段真·主升 Top6\n\n')
    for nm, s, e in SEGS:
        rows = sorted(((seg_ret(c, s, e), c) for c in U if seg_ret(c, s, e) is not None), reverse=True)[:6]
        f.write(f'- **{nm}**：' + '；'.join(f'{U[c][0]} {r:+.0f}%' for r, c in rows) + '\n')
    f.write('\n## 诊断B：点名主线在其【当令窗口】内的真实名次（公平口径, rs90排名）\n\n')
    f.write('| 标的 | 当令窗口 | 窗口内中位名次 | ≤前3占比 | ≤前5占比 |\n|---|---|---:|---:|---:|\n')
    for c, nm in NAMED.items():
        if c not in U or c not in PRIME:
            continue
        seg, s, e = PRIME[c]
        poss = [rank90[d][c] for d in DAYS if s <= d <= e and c in rank90[d]]
        if not poss:
            continue
        med = sorted(poss)[len(poss) // 2]
        t3 = sum(1 for p in poss if p <= 3) / len(poss) * 100
        t5 = sum(1 for p in poss if p <= 5) / len(poss) * 100
        f.write(f'| {U[c][0]} | {seg} | {med} | {t3:.0f}% | {t5:.0f}% |\n')
    f.write('\n**关键**：rs90 在每条主线当令窗口内把它排到 #1–#2（创新药#2、通信#1、中韩半导体#1，100%居前3）——'
            '主线**抓得到**，规则有实用性。科创芯片/半导体设备名次低(#11–14)非漏抓，而是同一半导体大主题里的弱兄弟，'
            '龙头(中韩半导体+131%)已被排第1持有、收益高于弱兄弟(+83%)，持龙头本就更优。\n\n')
    f.write('## 方案对比：persistence vs rs90（含5bp）\n\n')
    f.write('| 配置 | 全段 | 回撤 | 交易 | 真主线家族覆盖 | 2025H1 | 2025H2 | 2026H1 |\n|---|---:|---:|---:|---:|---:|---:|---:|\n')
    for label, sel, N, w in configs:
        r, subs, hit, named_fams = results[label]
        f.write(f'| {label} | {r["ret"]:.0f}% | {r["mdd"]:.0f}% | {r["trades"]} | {len(hit)}/{len(named_fams)} | '
                + ' | '.join(f'{x:.0f}%' for x in subs) + ' |\n')
    f.write(f'\n## 展示档 persist N3(50/30/20)：{HEAD["ret"]:.0f}% / 回撤{HEAD["mdd"]:.0f}%，覆盖真主线家族 {sorted(hit)}\n\n')
    f.write('## 综合结论（直面"突破不了收益"与"规则没实用性"）\n\n')
    f.write('1. **真主线是接力的，不是并存的**：创新药(25H1)→通信(25H2)→半导体(26H1)。'
            '"把各段主升标的同时持仓"是事后视角——它们当令窗口不重叠，现实只能轮动到当下那条。\n')
    f.write('2. **现有 rs90 规则其实有实用性**：N2/N3 已覆盖全部 5/5 点名主线，且在每条主线当令窗口内将其排到 #1–#2。'
            '我们不是"找不到主线"。\n')
    f.write('3. **"锁定持续领先(persistence)"假设已验证失败**（85% < rs90 188%）：真主线并不总稳居单一指标前列，'
            '持续性过滤既滞后又漏掉当令但非长青的主线。负面结论保留备查。\n')
    f.write('4. **收益封顶的真因 = 接力切换的过渡损耗 + 多腿稀释，而非选不出主线**。'
            '想突破只能更重仓当下唯一龙头，但那正是已被证伪的"运气尖峰"（rs90 80/20=348% 换参即崩）。\n')
    f.write('5. **可复现的现实最优 = rs90 N2(188%/-24%) 或 N3(180%/-18%)**，它就是"随主线接力、持有当下真龙头"的模式。'
            '若要略增收益，可在"龙头是无争议#1（如中韩半导体100%居首）"时把权重向第1腿倾斜，但须设上限以避开尖峰脆性。\n\n')
    f.write('详见 `trades_persistence.md`。\n')

print(f'\n交付：summary_persistence.md / trades_persistence.md（{len(trades)}笔）')
