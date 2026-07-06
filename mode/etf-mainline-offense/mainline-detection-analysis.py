#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""主线识别信号分析：RS90 上车滞后量化 + 多种主线辨认信号对比。

回答两个问题：
A) RS90 选出主线时，该主线一般已从底部涨了多少？（量化 RS90 的滞后）
B) 除 RS90 外，还有哪些方式能辨认当下主线？把候选信号在同一"单腿周频轮动"里跑，
   对比【上车时已涨幅(滞后)｜全段收益｜前瞻40日平均收益(信号质量)】。

候选排名信号（横向选最强1只，同主题去重，仅正值）：
  rs90      相对沪深300 90日强弱变化率（现行基线，滞后）
  rsmom20   相对强弱20日变化率（更快的相对动量）
  mom60     绝对动量：60日价格收益（脱离底部的"主升"绝对强度）
  mom20     绝对动量：20日价格收益（最快，易追在半山腰/噪声）
  rsnh      RS新高度：rs / 过去120日rs最高 （Minervini 思路：相对强弱线先创新高）
  combo     rs90 与 rsnh 同时强（先创RS新高、再确认变化率）

运行：python3 mode/etf-mainline-offense/mainline-detection-analysis.py
"""
import json, urllib.request, ssl, os, re, sys, statistics as st
from collections import deque

HOST = os.environ.get('SA_HOST', '192.168.31.144')
ASTOCK = os.environ.get('SA_ASTOCK', f'http://{HOST}:9119')
NAS = f'http://{HOST}:8787/api'
TOKEN = os.environ.get('SA_APP_TOKEN', '')
CACHE = os.environ.get('SA_CACHE', '/tmp/klcache')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backtest-data', 'mainline_detection.md')
os.makedirs(CACHE, exist_ok=True); os.makedirs(os.path.dirname(OUT), exist_ok=True)
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
    by = {}
    for i, b in enumerate(bars):
        d = b['d']; rs = b['c'] / bclose[d]

        def chg(n, series):
            return series[i] / series[i - n] - 1 if i >= n and series[i - n] else None

        def rschg(n):
            if i < n:
                return None
            prev = closes[i - n] / bclose[bars[i - n]['d']]
            return rs / prev - 1 if prev else None

        lo60 = min(closes[max(0, i - 59):i + 1]); lo90 = min(closes[max(0, i - 89):i + 1])
        rs_hist = [closes[j] / bclose[bars[j]['d']] for j in range(max(0, i - 119), i + 1)]
        rsnh = rs / max(rs_hist) if rs_hist else 1.0
        by[d] = {'c': b['c'], 'rs90': rschg(90), 'rsmom20': rschg(20),
                 'mom60': chg(60, closes), 'mom20': chg(20, closes),
                 'rsnh': rsnh, 'rise60': b['c'] / lo60 - 1 if lo60 else 0,
                 'rise90': b['c'] / lo90 - 1 if lo90 else 0,
                 'i': i, 'closes': None}
    U[code] = (name, by, closes, [x['d'] for x in bars])


def score_of(c, d, sig):
    r = U[c][1][d]
    if sig == 'combo':
        a, b = r['rs90'], r['rsnh']
        return (a + (b - 1) * 2) if a is not None else None  # rs90变化率 + RS新高度溢价
    if sig == 'rsnh':
        # 越接近/突破自身RS新高越强；要求正动量(rs90>0)以排除下跌反弹
        return r['rsnh'] if (r['rs90'] is not None and r['rs90'] > 0) else None
    return r.get(sig)


def fwd_ret(c, d, n=40):
    name, by, closes, days = U[c]
    i = by[d]['i']
    if i + n < len(closes) and closes[i]:
        return closes[i + n] / closes[i] - 1
    return None


SIGS = ['rs90', 'rsmom20', 'mom60', 'mom20', 'rsnh', 'combo']
days = [d for d in ALLDAYS if WIN[0] <= d <= WIN[1]]


def pick_top1(d, sig):
    cand = [(score_of(c, d, sig), c) for c in U if d in U[c][1] and score_of(c, d, sig) is not None and score_of(c, d, sig) > 0]
    cand.sort(reverse=True)
    return cand[0][1] if cand else None


# ---- 单腿周频轮动：隔离信号质量（集中度无关）----
def run_single(sig, cost_bps=5.0):
    cost = cost_bps / 10000.0; cash = 1.0; hold = None; ent = 0.0
    rises = []; fwds = []; eqmax = 0; mdd = 0; switches = 0
    for idx, d in enumerate(days):
        if hold and d in U[hold][1]:
            e = cash if not hold else cash * (U[hold][1][d]['c'] / ent)
            eqmax = max(eqmax, e); mdd = min(mdd, (e / eqmax - 1) * 100)
        if idx % 5 != 0:
            continue
        top = pick_top1(d, sig)
        if top == hold or top is None:
            continue
        if hold and d in U[hold][1]:
            cash = cash * (U[hold][1][d]['c'] / ent) * (1 - cost)
        # 记录新上车主线的滞后 & 前瞻
        rises.append(U[top][1][d]['rise60'] * 100)
        fw = fwd_ret(top, d, 40)
        if fw is not None:
            fwds.append(fw * 100)
        hold = top; ent = U[top][1][d]['c']; cash = cash * (1 - cost); switches += 1
    if hold and days[-1] in U[hold][1]:
        cash = cash * (U[hold][1][days[-1]]['c'] / ent)
    return {'sig': sig, 'ret': (cash - 1) * 100, 'mdd': mdd, 'switches': switches,
            'rise_med': st.median(rises) if rises else 0,
            'rise_mean': st.mean(rises) if rises else 0,
            'fwd_med': st.median(fwds) if fwds else 0,
            'win40': (sum(1 for x in fwds if x > 0) / len(fwds) * 100) if fwds else 0}


# ====== A) RS90 上车滞后量化（周频选 top1，记录上车时已从60/90日低点涨幅）======
rs90_rise60 = []; rs90_rise90 = []
hold = None
for idx, d in enumerate(days):
    if idx % 5 != 0:
        continue
    top = pick_top1(d, 'rs90')
    if top and top != hold:
        rs90_rise60.append(U[top][1][d]['rise60'] * 100)
        rs90_rise90.append(U[top][1][d]['rise90'] * 100)
        hold = top

def pct(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(len(xs) * p / 100))] if xs else 0

print(f'载入 {len(U)}/{len(POOL)} 只\n')
print('=== A) RS90 上车时，主线已从底部涨了多少（周频换腿样本，n=%d）===' % len(rs90_rise60))
print(f'  相对60日低点：中位 {st.median(rs90_rise60):.0f}% | 25分位 {pct(rs90_rise60,25):.0f}% | 75分位 {pct(rs90_rise60,75):.0f}% | 最大 {max(rs90_rise60):.0f}%')
print(f'  相对90日低点：中位 {st.median(rs90_rise90):.0f}% | 25分位 {pct(rs90_rise90,25):.0f}% | 75分位 {pct(rs90_rise90,75):.0f}% | 最大 {max(rs90_rise90):.0f}%')
share = sum(1 for x in rs90_rise60 if x > 20) / len(rs90_rise60) * 100
print(f'  上车时已涨>20%(相对60日低)的比例：{share:.0f}%')

print('\n=== B) 各主线辨认信号对比（单腿周频，隔离信号质量）===')
print(f'{"信号":<9}{"上车已涨(中位)":>13}{"全段收益":>10}{"回撤":>8}{"前瞻40日(中位)":>14}{"40日胜率":>9}{"换腿":>6}')
rows = []
for sig in SIGS:
    r = run_single(sig); rows.append(r)
    print(f'{sig:<9}{r["rise_med"]:>12.0f}%{r["ret"]:>9.0f}%{r["mdd"]:>7.0f}%{r["fwd_med"]:>13.0f}%{r["win40"]:>8.0f}%{r["switches"]:>6}')

with open(OUT, 'w') as f:
    f.write('# 主线识别信号分析\n\n区间 2025-01-02 → 2026-06-26｜55只跟踪池｜相对沪深300｜单腿周频(隔离信号质量)。\n\n')
    f.write('## A) RS90 上车滞后：选出主线时已从底部涨了多少\n\n')
    f.write(f'- 相对**60日低点**：中位 **{st.median(rs90_rise60):.0f}%**（25~75分位 {pct(rs90_rise60,25):.0f}%~{pct(rs90_rise60,75):.0f}%，最大 {max(rs90_rise60):.0f}%）\n')
    f.write(f'- 相对**90日低点**：中位 **{st.median(rs90_rise90):.0f}%**（25~75分位 {pct(rs90_rise90,25):.0f}%~{pct(rs90_rise90,75):.0f}%）\n')
    f.write(f'- 上车时已涨>20%(相对60日低)的比例：**{share:.0f}%**\n\n')
    f.write('> RS90 是 90 日相对强弱"变化率"，本质是趋势确认信号——它要等主线已经走出一段才点亮，'
            '所以中位已涨一两成才上车。好处是过滤掉假启动，代价是放弃鱼头。\n\n')
    f.write('## B) 候选主线辨认信号对比（单腿周频）\n\n')
    f.write('| 信号 | 上车已涨(中位) | 全段收益 | 回撤 | 前瞻40日(中位) | 40日胜率 | 换腿 | 含义 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---|\n')
    meaning = {'rs90': '90日相对强弱变化率(现行,滞后)', 'rsmom20': '20日相对强弱变化率(更快)',
               'mom60': '60日绝对收益(主升强度)', 'mom20': '20日绝对收益(最快,噪声大)',
               'rsnh': 'RS线新高度(Minervini:相对强弱先创新高)', 'combo': 'rs90+RS新高溢价'}
    for r in rows:
        f.write(f'| {r["sig"]} | {r["rise_med"]:.0f}% | {r["ret"]:.0f}% | {r["mdd"]:.0f}% | {r["fwd_med"]:.0f}% | {r["win40"]:.0f}% | {r["switches"]} | {meaning[r["sig"]]} |\n')
    f.write('\n说明：**上车已涨越小=越早抓到主线（滞后越小）**；**前瞻40日中位/胜率越高=信号质量越好（上车后还能涨）**。\n')

print(f'\n已写出：{OUT}')
