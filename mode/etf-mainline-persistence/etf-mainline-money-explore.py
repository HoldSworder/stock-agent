#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探索：跳出 rs/ma 价格指标，用「量能/资金」类因子识别主线。

背景（已查证）：
  - 业界识别主线公认靠「动量+资金+情绪」三维共振（东方证券行业轮动 / STMS / etf-quant-dao）。
  - 但「聪明钱」因子多为个股级：北向(2024年中已停实时流向)、主力净流入(push2his fflow 对ETF返回空,
    仅个股有)、龙虎榜/两融——都难映射到 ETF 且难拿干净历史回测。
  - 唯一「非价格 + 已有数据可回测」的是 K线自带的【成交量】。本脚本用量能近似资金：

  cmf20    蔡金资金流(CMF)  ((c-l)-(h-c))/(h-l)*v 的20日量权净额∈[-1,1]，OHLCV算的经典资金流代理
  amt      放量动量         成交额(c*v) 近5日MA / 近20日MA，>1=资金正在涌入放量
  conc     资金集中度变化    该ETF成交额占全池份额 vs 20日前(研究:行业资金集中流入=主线确认)
  rs90+cmf 共振确认         rs90 领先腿中，再要求 CMF>0(资金确认)——动量×资金共振，看能否提升稳健/捕获

核心指标仍为【主线捕获率】+ 上车早晚 + 分段稳健，与 capture-explore 对齐，直接对比 rs90 基线。

运行：python3 mode/etf-mainline-persistence/etf-mainline-money-explore.py
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
    vols = [b['v'] for b in bars]
    amts = [b['c'] * b['v'] for b in bars]   # 成交额近似 = 收盘×量
    ma60 = sma(closes, 60)
    rs_series = [b['c'] / bclose[b['d']] for b in bars]
    amt_ma5 = sma(amts, 5); amt_ma20 = sma(amts, 20)
    # CMF 分子：每日 money flow volume = ((c-l)-(h-c))/(h-l)*v
    mfv = []
    for b in bars:
        rng = b['h'] - b['l']
        mult = 0.0 if rng <= 0 else ((b['c'] - b['l']) - (b['h'] - b['c'])) / rng
        mfv.append(mult * b['v'])
    by = {}
    for i, b in enumerate(bars):
        d = b['d']; rs = rs_series[i]
        def rsret(n):
            if i < n:
                return None
            prev = rs_series[i - n]
            return rs / prev - 1 if prev else None
        # CMF20：近20日 money flow volume 之和 / 近20日量之和 ∈[-1,1]
        if i >= 19:
            vsum = sum(vols[i - 19:i + 1])
            cmf20 = sum(mfv[i - 19:i + 1]) / vsum if vsum > 0 else None
        else:
            cmf20 = None
        # 放量动量：成交额5日MA / 20日MA（>1=近期放量）
        amt_mom = (amt_ma5[i] / amt_ma20[i]) if amt_ma20[i] > 0 else None
        by[d] = {'c': b['c'], 'h': b['h'], 'rs': rs, 'rs60': rsret(60), 'rs90': rsret(90),
                 'cmf20': cmf20, 'amt_mom': amt_mom, 'amt_ma20': amt_ma20[i],
                 'ma60': ma60[i], 'above60': b['c'] > ma60[i]}
    U[code] = (name, by)

DAYS = [d for d in ALLDAYS if WIN[0] <= d <= WIN[1]]
FAMILIES = {}
for c in U:
    FAMILIES.setdefault(family(U[c][0]), []).append(c)

# 资金集中度：每日全池成交额合计 → 该ETF份额；conc = 份额(今) - 份额(20日前)
TOTAMT = {}
for d in DAYS:
    TOTAMT[d] = sum(U[c][1][d]['amt_ma20'] for c in U if d in U[c][1] and U[c][1][d]['amt_ma20'] > 0)
DAYIDX = {d: i for i, d in enumerate(DAYS)}


def conc_chg(c, d):
    """资金集中度变化：成交额占全池份额(今) - (20日前)。正=资金在向该ETF集中。"""
    by = U[c][1]; i = DAYIDX.get(d)
    if i is None or i < 20 or d not in by:
        return None
    d0 = DAYS[i - 20]
    if d0 not in by or TOTAMT[d] <= 0 or TOTAMT[d0] <= 0:
        return None
    share_now = by[d]['amt_ma20'] / TOTAMT[d]
    share_old = by[d0]['amt_ma20'] / TOTAMT[d0] if by[d0]['amt_ma20'] else 0
    return share_now - share_old


def run(selector, N=2, weights=None, rebalance=5, start=None, end=None, cost_bps=5.0, log=False):
    days = [d for d in DAYS if (start or WIN[0]) <= d <= (end or WIN[1])]
    cost = cost_bps / 10000.0
    weights = weights or tuple([1.0 / N] * N)
    cash = 1.0; pos = {}; eqmax = 0; mdd = 0; trades = 0; rec = []
    held_fam_days = {}
    eq = lambda d: cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def score(c, d):
        r = U[c][1].get(d)
        if not r or not r['above60']:
            return None
        if selector == 'rs90':
            return r['rs90'] if (r['rs90'] is not None and r['rs90'] > 0) else None
        if selector == 'cmf20':
            return r['cmf20'] if (r['cmf20'] is not None and r['cmf20'] > 0) else None
        if selector == 'amt':
            return r['amt_mom'] if (r['amt_mom'] is not None and r['amt_mom'] > 1.0) else None
        if selector == 'conc':
            cc = conc_chg(c, d)
            return cc if (cc is not None and cc > 0) else None
        if selector == 'rs90+cmf':
            # 共振确认：rs90 正且 CMF>0（动量×资金双确认），打分仍用 rs90
            if r['rs90'] is None or r['rs90'] <= 0 or r['cmf20'] is None or r['cmf20'] <= 0:
                return None
            return r['rs90']
        if selector == 'rs90+amt':
            if r['rs90'] is None or r['rs90'] <= 0 or r['amt_mom'] is None or r['amt_mom'] <= 1.0:
                return None
            return r['rs90']
        return None

    def pick(d):
        arr = [(score(c, d), c) for c in U if score(c, d) is not None]
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
                        'pnl': (px / p['e'] - 1) * 100, 'reason': reason})
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
                        'pnl': (U[c][1][last]['c'] / p['e'] - 1) * 100, 'reason': '持有中'})
    fin = eq(last); n = len(days)
    return {'sel': selector, 'ret': (fin - 1) * 100, 'mdd': mdd, 'trades': trades,
            'ann': (fin ** (244 / n) - 1) * 100, 'rec': rec, 'held_fam_days': held_fam_days}


def capture_pct(selector, N=2):
    res = run(selector, N)
    out = {}
    for nm, (s, e) in NAMED.items():
        fam = family(nm)
        wdays = [d for d in DAYS if s <= d <= e]
        held = res['held_fam_days'].get(fam, set())
        hit = sum(1 for d in wdays if d in held)
        out[nm] = hit / len(wdays) * 100 if wdays else 0
    return out


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


SEGS = [('2025H1', '2025-01-02', '2025-06-30'), ('2025H2', '2025-07-01', '2025-12-31'),
        ('2026H1', '2026-01-02', '2026-06-26')]
SELS = ['rs90', 'cmf20', 'amt', 'conc', 'rs90+cmf', 'rs90+amt']
print(f'载入 {len(U)}/{len(POOL)} | 主题数 {len(FAMILIES)} | 量能/资金类因子 vs rs90\n')
print('=== 总收益 + 分段（N2均权, 含5bp）===')
print(f'{"信号":<10}{"全段":>8}{"回撤":>7}{"交易":>6}  | 2025H1/H2 2026H1')
res_all = {}
for sel in SELS:
    r = run(sel, 2)
    subs = [run(sel, 2, start=s, end=e)['ret'] for _, s, e in SEGS]
    res_all[sel] = (r, subs)
    print(f'{sel:<10}{r["ret"]:>7.0f}%{r["mdd"]:>6.0f}%{r["trades"]:>6}  | ' + ' '.join(f'{x:>4.0f}%' for x in subs))

print('\n=== 主线捕获率（当令窗口内持有该主题交易日占比, N2）===')
print(f'{"信号":<10}' + ''.join(f'{nm:>12}' for nm in NAMED))
cap_all = {}
for sel in SELS:
    cap = capture_pct(sel, 2)
    cap_all[sel] = cap
    print(f'{sel:<10}' + ''.join(f'{cap[nm]:>11.0f}%' for nm in NAMED))

print('\n=== 上车早晚（上车时相对60日低点已涨幅, 中位; 越小越早）===')
er = {}
for sel in SELS:
    er[sel] = entry_rise(sel)
    print(f'  {sel:<10} {er[sel]:.0f}%')

with open(f'{OUT}/summary_money_explore.md', 'w') as f:
    f.write('# 探索：量能/资金类因子识别主线（跳出 rs/ma）\n\n')
    f.write(f'区间 {DAYS[0]}→{DAYS[-1]}｜{len(U)}只池｜{len(FAMILIES)}个主题｜N2均权含5bp。\n\n')
    f.write('## 背景：为什么只能用量能近似资金\n\n')
    f.write('- 业界识别主线靠「动量+资金+情绪」三维共振；资金维度首选北向+主力净流入。\n')
    f.write('- 但已查证：北向实时流向 2024 年中停发；主力净流入(push2his fflow)对 **ETF 返回空**(仅个股有)；'
            '龙虎榜/两融均为个股级，难映射 ETF 且无干净历史。\n')
    f.write('- 故「非价格 + 可回测」的资金代理只能取 K线自带成交量：CMF(蔡金资金流)、放量动量、资金集中度。\n\n')
    f.write('## 总收益 + 分段\n\n| 信号 | 全段 | 回撤 | 交易 | 2025H1 | 2025H2 | 2026H1 |\n|---|---:|---:|---:|---:|---:|---:|\n')
    for sel in SELS:
        r, subs = res_all[sel]
        f.write(f'| {sel} | {r["ret"]:.0f}% | {r["mdd"]:.0f}% | {r["trades"]} | ' + ' | '.join(f'{x:.0f}%' for x in subs) + ' |\n')
    f.write('\n## 主线捕获率（当令窗口内持有该主题交易日占比）\n\n| 信号 | ' + ' | '.join(NAMED) + ' |\n|' + '---|' * (len(NAMED) + 1) + '\n')
    for sel in SELS:
        f.write(f'| {sel} | ' + ' | '.join(f'{cap_all[sel][nm]:.0f}%' for nm in NAMED) + ' |\n')
    f.write('\n## 上车早晚（上车时相对60日低点已涨幅中位, 越小越早）\n\n| 信号 | 上车已涨中位 |\n|---|---:|\n')
    for sel in SELS:
        f.write(f'| {sel} | {er[sel]:.0f}% |\n')
    f.write('\n## 因子口径\n\n')
    f.write('- **cmf20** 蔡金资金流：`((c-l)-(h-c))/(h-l)*v` 的20日量权净额∈[-1,1]，>0=资金净流入。\n')
    f.write('- **amt** 放量动量：成交额(c·v)5日MA/20日MA，>1=近期放量涌入。\n')
    f.write('- **conc** 资金集中度变化：该ETF成交额占全池份额今 - 20日前，>0=资金向其集中(对应研究"行业资金集中=主线确认")。\n')
    f.write('- **rs90+cmf / rs90+amt** 共振确认：rs90 领先腿中再要求资金确认(CMF>0 / 放量)，验证"动量×资金"是否提升稳健或捕获。\n')

print(f'\n交付：{OUT}/summary_money_explore.md')
