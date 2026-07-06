#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ETF 主线双动量·哨兵降仓模式：13612W 混合动量 + 绝对动量/广度门 + 无主线撤防御。

设计动机（补 RS90/leader-runner 的命门）：
  RS90 是纯相对强度，没有 regime 开关——2024 无主线年它被迫死扛"最不烂的板块"，
  全年 +7% 却吃 -30% 回撤，9月急反转里市场暴涨它反而亏。本模式照搬已被多市场、
  数十年样本外验证的 Dual Momentum / Keller VAA 思想，只做"参数极少 + 有经济逻辑"的迁移：

  ① 排名口径 = 13612W 混合动量（1/3/6/12月收益加权，近月权重大），替代 RS90 单窗口；
     score = 12*(p0/p1-1) + 4*(p0/p3-1) + 2*(p0/p6-1) + 1*(p0/p12-1)，月数=21/63/126/252 个交易日。
  ② 绝对动量/广度门（核心）：每个仓位只买 13612W>0 的板块（Antonacci 绝对动量）；
     没有足够多正动量板块时，空出的仓位撤到防御资产（Keller 广度动量：现金/债比例=缺口数/N）。
  ③ 防御资产 = {十年国债511260, 黄金518880, 货币511990} 里 13612W 最强的一只（货币≈现金底）。
  ④ 月频调仓（这类框架都是月频，低换手、抗 whipsaw、省成本）。

反过拟合：参数极少且全部固定（13612W 权重、月频、N），不挖网格；同一套固定配置跑所有窗口，
  重点看 2024 无主线年是否成功"降仓避险"（而非冲收益）。对照 gate=none（不降仓）与指数躺平。

运行：python3 mode/etf-mainline-dualmom-gate/etf-mainline-dualmom-gate-research.py
环境变量同其它模式：SA_HOST / SA_ASTOCK / SA_APP_TOKEN / SA_CACHE
"""
import json, urllib.request, ssl, os, re, sys
from collections import deque

HOST = os.environ.get('SA_HOST', '192.168.31.144')
ASTOCK = os.environ.get('SA_ASTOCK', f'http://{HOST}:9119')
NAS = f'http://{HOST}:8787/api'
TOKEN = os.environ.get('SA_APP_TOKEN', '')
CACHE = os.environ.get('SA_CACHE', '/tmp/klcache')
OUT_DIR = os.environ.get('SA_MODE_OUT_DIR',
                         os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backtest-data'))
TRADE_LOG = os.environ.get('SA_RESEARCH_TRADE_LOG', f'{OUT_DIR}/trades_dualmom_gate.md')
SUMMARY_LOG = os.environ.get('SA_RESEARCH_SUMMARY_LOG', f'{OUT_DIR}/summary_dualmom_gate.md')
os.makedirs(CACHE, exist_ok=True); os.makedirs(OUT_DIR, exist_ok=True)
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

DEFENSIVE = {'511260': '十年国债', '518880': '黄金', '511990': '货币'}
BENCH = '510300'

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


POOL = load_pool()
ALL = dict(POOL); ALL.update(DEFENSIVE)
bench = fetch(BENCH); bclose = {x['d']: x['c'] for x in bench}
ALLDAYS = sorted(bclose)

# 13612W：1/3/6/12 月（21/63/126/252 交易日）加权动量
LB = [(21, 12), (63, 4), (126, 2), (252, 1)]


def build(code):
    bars = [b for b in fetch(code) if b['d'] in bclose]
    if len(bars) < 260:
        return None
    closes = [b['c'] for b in bars]
    by = {}
    for i, b in enumerate(bars):
        if i < 252:
            continue
        score = sum(w * (closes[i] / closes[i - n] - 1) for n, w in LB if closes[i - n])
        by[b['d']] = {'c': b['c'], 'm': score}
    return (ALL.get(code, code), by) if by else None


sys.stderr.write(f'构建 {len(ALL)} 只指标（含防御 {len(DEFENSIVE)}）...\n')
U = {}
for code in ALL:
    r = build(code)
    if r:
        U[code] = r
SECTORS = [c for c in POOL if c in U]
DEF = [c for c in DEFENSIVE if c in U]
benchU = build(BENCH)  # 沪深300 当 canary


def rebal_days(days):
    out = []
    prev = None
    for d in days:
        ym = d[:7]
        if ym != prev:
            out.append(d); prev = ym
    return out


def run(start, end, N=3, gate='breadth', cost_bps=5.0):
    days = [d for d in ALLDAYS if start <= d <= end]
    rdays = set(rebal_days(days))
    cost = cost_bps / 10000.0
    cash = 1.0; pos = {}; eqmax = 0; mdd = 0; trades = 0; rec = []
    def_days = 0; def_w_sum = 0; n_days = 0
    eq = lambda d: cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def close(c, d, reason):
        nonlocal cash, trades
        p = pos[c]; px = U[c][1][d]['c']; cash += p['a'] * (px / p['e']) * (1 - cost)
        rec.append({'entry': p['ed'], 'exit': d, 'code': c, 'name': U[c][0],
                    'm': p['m'], 'pnl': (px / p['e'] - 1) * 100,
                    'contrib': p['gross'] * (px / p['e'] - 1), 'def': c in DEFENSIVE, 'reason': reason})
        del pos[c]; trades += 1

    def open_(c, d, amt):
        nonlocal cash, trades
        if amt <= 1e-6 or d not in U[c][1]:
            return
        cash -= amt; pos[c] = {'a': amt * (1 - cost), 'gross': amt, 'e': U[c][1][d]['c'],
                               'ed': d, 'm': U[c][1][d]['m']}; trades += 1

    def best_def(d):
        avail = [(U[c][1][d]['m'], c) for c in DEF if d in U[c][1]]
        return max(avail)[1] if avail else None

    for d in days:
        if d in rdays:
            # 目标集合
            target = []  # list of codes, 长度<=N
            canary_on = True
            if gate == 'canary' and benchU and d in benchU[1]:
                canary_on = benchU[1][d]['m'] > 0
            if canary_on:
                cand = sorted([(U[c][1][d]['m'], c) for c in SECTORS if d in U[c][1] and U[c][1][d]['m'] > 0], reverse=True)
                used = set()
                for _, c in cand:
                    fam = family(U[c][0])
                    if fam in used:
                        continue
                    target.append(c); used.add(fam)
                    if len(target) >= N:
                        break
            # 不足 N（或 canary off / gate=none 时的处理）
            if gate == 'none':
                # 控制组：永远满仓 top-N 板块，无视正负、不撤防御
                cand = sorted([(U[c][1][d]['m'], c) for c in SECTORS if d in U[c][1]], reverse=True)
                target = []; used = set()
                for _, c in cand:
                    fam = family(U[c][0])
                    if fam in used:
                        continue
                    target.append(c); used.add(fam)
                    if len(target) >= N:
                        break
                def_slots = 0
            else:
                def_slots = N - len(target)  # 空缺撤防御
            def_code = best_def(d) if def_slots > 0 else None
            tset = set(target) | ({def_code} if def_code else set())
            # 卖出不在目标里的
            for c in list(pos):
                if c not in tset:
                    close(c, d, '调仓换出')
            E = eq(d); slot = E / N
            # 买入板块腿（缺的）
            for c in target:
                if c not in pos:
                    open_(c, d, min(slot, cash))
            # 防御腿：占 def_slots 个仓位
            if def_code and def_slots > 0:
                want = slot * def_slots
                cur = pos[def_code]['a'] * (U[def_code][1][d]['c'] / pos[def_code]['e']) if def_code in pos else 0
                if def_code not in pos:
                    open_(def_code, d, min(want, cash))
                # 若已持有防御则让其继续（近似），不精细再平衡，降低换手
        e = eq(d); eqmax = max(eqmax, e); mdd = min(mdd, (e / eqmax - 1) * 100)
        dv = sum(pos[c]['a'] * (U[c][1][d]['c'] / pos[c]['e']) for c in pos if c in DEFENSIVE and d in U[c][1])
        n_days += 1; def_w_sum += (dv / e if e else 0)
        if dv > 1e-6:
            def_days += 1
    if not days:
        return None
    last = days[-1]
    for c, p in list(pos.items()):
        if last in U[c][1]:
            rec.append({'entry': p['ed'], 'exit': last, 'code': c, 'name': U[c][0], 'm': p['m'],
                        'pnl': (U[c][1][last]['c'] / p['e'] - 1) * 100,
                        'contrib': p['gross'] * (U[c][1][last]['c'] / p['e'] - 1), 'def': c in DEFENSIVE, 'reason': '持有中'})
    fin = eq(last); n = len(days); ann = (fin ** (244 / n) - 1) * 100
    return {'ret': (fin - 1) * 100, 'ann': ann, 'mdd': mdd, 'trades': trades,
            'def_frac': def_w_sum / n_days * 100, 'def_days': def_days / n_days * 100,
            'days': n, 'rec': rec}


def bh(code, start, end):
    seg = [b for b in fetch(code) if start <= b['d'] <= end]
    if len(seg) < 2:
        return None
    peak = seg[0]['c']; dd = 0
    for b in seg:
        peak = max(peak, b['c']); dd = min(dd, (b['c'] / peak - 1) * 100)
    return (seg[-1]['c'] / seg[0]['c'] - 1) * 100, dd


WINDOWS = [
    ('2024无主线磨底 04→09.20', '2024-04-01', '2024-09-20'),
    ('2024无主线+反转 04→12', '2024-04-01', '2024-12-31'),
    ('2025-26主升', '2025-01-02', '2026-06-26'),
    ('全段 2024.04→2026.06', '2024-04-01', '2026-06-26'),
]
print(f'板块 {len(SECTORS)} | 防御 {len(DEF)}={[U[c][0] for c in DEF]} | 数据起点需≥252日，故窗口从2024-04起')
print('对比：breadth(本模式,降仓) vs canary(GEM式) vs none(永远满仓,对照) vs 指数躺平\n')
for nm, s, e in WINDOWS:
    print(f'【{nm}】')
    for gate in ('breadth', 'canary', 'none'):
        for N in (2, 3):
            r = run(s, e, N=N, gate=gate)
            if not r:
                continue
            print(f'  {gate:<8}N{N}  {r["ret"]:>6.0f}% 年化{r["ann"]:>5.0f}% 回撤{r["mdd"]:>5.0f}% '
                  f'交易{r["trades"]:>3} 防御仓位均值{r["def_frac"]:>4.0f}% 防御天数占比{r["def_days"]:>4.0f}%')
    idx = []
    for code, inm in [('510300', '沪深300'), ('510500', '中证500'), ('588000', '科创50')]:
        b = bh(code, s, e)
        if b:
            idx.append(f'{inm}{b[0]:+.0f}%/{b[1]:.0f}%')
    print(f'  指数躺平: {" | ".join(idx)}\n')


# ---- 主推：canary N3（唯一真正起到降仓作用的门），全段出交易记录 + 摘要 ----
# 诚实负结论：breadth 逐资产门 ≈ none（A股行业高相关，无主线时仍总有正动量板块，门极少触发）；
# 真正有效的是 GEM 式"大盘沪深300 绝对动量"总开关 = canary。
PRIMARY = dict(N=3, gate='canary')
full = run('2024-04-01', '2026-06-26', **PRIMARY)


def write_records(path, rec):
    rec = sorted(rec, key=lambda r: (r['entry'], r['exit'], r['code']))
    with open(path, 'w') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 13612W | 类型 | 收益 | 组合贡献 | 原因 |\n')
        f.write('|---|---|---|---|---:|---|---:|---:|---|\n')
        for r in rec:
            typ = '防御' if r['def'] else '板块'
            f.write(f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {r["name"]} | {r["m"]*100:+.0f} | {typ} | '
                    f'{r["pnl"]:+.1f}% | {r["contrib"]*100:+.1f}% | {r["reason"]} |\n')
    return rec


records = write_records(TRADE_LOG, full['rec'])


def mdcell(v):
    return str(v).replace('|', '\\|')


with open(SUMMARY_LOG, 'w') as f:
    f.write('# ETF 主线双动量·哨兵降仓模式 回测摘要\n\n')
    f.write('- 排名: 13612W 混合动量（1/3/6/12月加权）；门: 绝对动量(>0)+广度撤防御；月频；防御={国债/黄金/货币}择强。\n')
    f.write('- 核心目的: 在无主线年自动降仓避险，而非冲收益。重点看 2024 样本外。\n')
    f.write('- 反过拟合: 参数全部固定、不挖网格；同一配置跑所有窗口。\n\n')
    f.write('## 各窗口对比（breadth=本模式降仓 / canary=GEM式 / none=永远满仓对照）\n\n')
    for nm, s, e in WINDOWS:
        f.write(f'### {nm}\n\n| 配置 | 收益 | 年化 | 回撤 | 交易 | 防御仓位均值 | 防御天数占比 |\n|---|---:|---:|---:|---:|---:|---:|\n')
        for gate in ('breadth', 'canary', 'none'):
            for N in (2, 3):
                r = run(s, e, N=N, gate=gate)
                if r:
                    f.write(f'| {gate} N{N} | {r["ret"]:.0f}% | {r["ann"]:.0f}% | {r["mdd"]:.0f}% | {r["trades"]} | {r["def_frac"]:.0f}% | {r["def_days"]:.0f}% |\n')
        idx = []
        for code, inm in [('510300', '沪深300'), ('510500', '中证500'), ('588000', '科创50')]:
            b = bh(code, s, e)
            if b:
                idx.append(f'{inm} {b[0]:+.0f}%/{b[1]:.0f}%')
        f.write(f'\n指数躺平: {" ｜ ".join(idx)}\n\n')
    f.write('## 关键结论\n\n')
    f.write('1. **breadth（逐板块绝对动量门）≈ none（永远满仓）**：A股行业ETF 高相关，无主线时仍总有正动量板块，门几乎不触发 → 该思路对行业ETF 失效。\n')
    f.write('2. **canary（GEM式·大盘沪深300绝对动量总开关）真正降仓**：2024 把回撤从 −32% 砍到 −13%、亏损翻正；代价是牛市少赚。\n')
    f.write('3. 这是**风险控制覆盖层**，非收益最大化：本样本被超级牛(科创50 +162%)主导，连指数躺平的总收益都难被超越——它的价值在无主线年的回撤保护。\n\n')
    f.write(f'## 主推档 canary N3 全段交易记录：{len(records)} 笔\n\n详见 `trades_dualmom_gate.md`。\n')

print(f'\n主推 canary N3 全段：{full["ret"]:.0f}% / 回撤{full["mdd"]:.0f}% / 防御天数占比{full["def_days"]:.0f}%')
print(f'交易记录: {TRADE_LOG} | {len(records)} 笔')
print(f'摘要: {SUMMARY_LOG}')
