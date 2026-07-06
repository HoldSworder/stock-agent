#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ETF 主线指标大扫：系统比较可历史回测的量价/技术指标。

目标：
- 最大持仓 3 只；
- 入场使用标的自身 30/60 日动量、阶段新高和趋势过滤，退出使用趋势破位；
- 用同一 ETF 池、同一 K 线数据源，与既有模式公平比较。

运行：
  python3 mode/etf-mainline-factor-sweep/etf-mainline-factor-sweep-research.py

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
SINGLE_TREND_ROBUST_RET = 472.5
OUT_DIR = os.environ.get(
    'SA_MODE_OUT_DIR',
    '/Users/qiuzhuoran/Desktop/自用/code/stock-agent/mode/etf-mainline-factor-sweep/backtest-data',
)
TRADE_LOG = os.environ.get('SA_RESEARCH_TRADE_LOG', f'{OUT_DIR}/trades_factor_sweep.md')
RUNNER_TRADE_LOG = os.environ.get('SA_RUNNER_TRADE_LOG', f'{OUT_DIR}/trades_runner_best.md')
RUNNER_MAINLINE_TRADE_LOG = os.environ.get(
    'SA_RUNNER_MAINLINE_TRADE_LOG',
    f'{OUT_DIR}/trades_runner_mainline_best.md',
)
TQ_TRADE_LOG = os.environ.get('SA_TQ_TRADE_LOG', f'{OUT_DIR}/trades_tq.md')
SUMMARY_LOG = os.environ.get('SA_RESEARCH_SUMMARY_LOG', f'{OUT_DIR}/summary_factor_sweep.md')
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


def mainline_group(name):
    fam = family(name)
    groups = {
        '半导体芯片': ('半导体设备', '科创芯片', '全球芯片', '中韩半导体', '芯片宽泛'),
        '港股科技': ('港美互联网', '恒生科技', '港股通科技'),
        'AI软件': ('人工智能', '信创软件'),
        '电力能源': ('电网电力', '能源资源'),
        '消费传媒': ('消费', '传媒游戏'),
    }
    for group, families in groups.items():
        if fam in families:
            return group
    return fam


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
        cached = json.load(open(fp))
        if cached and all('amt' in x for x in cached):
            return cached
    try:
        d = get(f'{ASTOCK}/api/call/mootdx_kline?symbol={code}&category=4&offset=800')
        o = [
            {
                'd': x['datetime'][:10],
                'o': x['open'],
                'h': x['high'],
                'l': x['low'],
                'c': x['close'],
                'v': x.get('volume') or 0,
                'amt': x.get('amount') or 0,
            }
            for x in (d or [])
        ]
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


def ema_series(xs, n):
    out = []
    k = 2 / (n + 1)
    v = None
    for x in xs:
        v = x if v is None else x * k + v * (1 - k)
        out.append(v)
    return out


def stdev(xs):
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def flat_return(curve):
    """非复利(等权)累计收益(%)。

    复利总收益 (curve[-1]-1) 会被后期权益基数放大,使最后几笔大行情主导
    headline,导致模式横向评估有路径依赖偏差。这里把每日权益曲线还原成
    与基数无关的当日收益率 r_t = curve[t]/curve[t-1]-1,再做等权求和,
    每一天/每一段贡献相同,不受其出现在时间轴的位置影响。
    """
    if len(curve) < 2:
        return (curve[-1] - 1) * 100 if curve else 0.0
    return sum(curve[i] / curve[i - 1] - 1 for i in range(1, len(curve)) if curve[i - 1] > 0) * 100


def linreg_stats(xs):
    n = len(xs)
    if n < 3 or any(x <= 0 for x in xs):
        return {'slope_ret': 0.0, 'r2': 0.0}
    ys = [math.log(x) for x in xs]
    xmean = (n - 1) / 2
    ymean = sum(ys) / n
    sxx = sum((j - xmean) ** 2 for j in range(n))
    syy = sum((y - ymean) ** 2 for y in ys)
    if not sxx or not syy:
        return {'slope_ret': 0.0, 'r2': 0.0}
    sxy = sum((j - xmean) * (ys[j] - ymean) for j in range(n))
    slope = sxy / sxx
    r2 = (sxy * sxy) / (sxx * syy)
    return {'slope_ret': math.exp(slope * n) - 1, 'r2': max(0.0, min(1.0, r2))}


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
    bench_closes = [bclose[b['d']] for b in bars]
    highs = [b['h'] for b in bars]
    lows = [b['l'] for b in bars]
    vols = [b['v'] for b in bars]
    amounts = [b.get('amt') or (b['v'] * b['c']) for b in bars]
    ma20 = sma(closes, 20)
    ma30 = sma(closes, 30)
    ma60 = sma(closes, 60)
    ma120 = sma(closes, 120)
    ema12 = ema_series(closes, 12)
    ema26 = ema_series(closes, 26)
    macd_dif = [a - b for a, b in zip(ema12, ema26)]
    macd_dea = ema_series(macd_dif, 9)
    vma20 = sma(vols, 20)
    vma60 = sma(vols, 60)
    ama5 = sma(amounts, 5)
    ama20 = sma(amounts, 20)
    ama60 = sma(amounts, 60)
    trs = []
    for i, b in enumerate(bars):
        prev = closes[i - 1] if i else b['c']
        trs.append(max(b['h'] - b['l'], abs(b['h'] - prev), abs(b['l'] - prev)))
    atr20 = sma(trs, 20)
    atr60 = sma(trs, 60)
    plus_dm = [0.0]
    minus_dm = [0.0]
    obv = [0.0]
    amount_obv = [0.0]
    pvt = [0.0]
    for i in range(1, len(bars)):
        up_move = highs[i] - highs[i - 1]
        down_move = lows[i - 1] - lows[i]
        plus_dm.append(up_move if up_move > down_move and up_move > 0 else 0.0)
        minus_dm.append(down_move if down_move > up_move and down_move > 0 else 0.0)
        direction = 1.0 if closes[i] > closes[i - 1] else -1.0 if closes[i] < closes[i - 1] else 0.0
        obv.append(obv[-1] + direction * vols[i])
        amount_obv.append(amount_obv[-1] + direction * amounts[i])
        pvt.append(pvt[-1] + (closes[i] / closes[i - 1] - 1) * vols[i] if closes[i - 1] else pvt[-1])
    plus_dm20 = sma(plus_dm, 20)
    minus_dm20 = sma(minus_dm, 20)
    dx20_raw = []
    for i in range(len(bars)):
        plus_di = 100 * plus_dm20[i] / atr20[i] if atr20[i] else 0.0
        minus_di = 100 * minus_dm20[i] / atr20[i] if atr20[i] else 0.0
        dx20_raw.append(abs(plus_di - minus_di) / (plus_di + minus_di) if plus_di + minus_di else 0.0)
    adx20_series = sma(dx20_raw, 20)
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
        def bret(n):
            return bench_closes[i] / bench_closes[i - n] - 1 if i >= n and bench_closes[i - n] else 0.0
        def bench_stats(n):
            if i < n:
                return {'beta': 1.0, 'corr': 0.0, 'alpha': 0.0}
            asset = [
                closes[j] / closes[j - 1] - 1
                for j in range(i - n + 1, i + 1)
                if closes[j - 1]
            ]
            bench_ret = [
                bench_closes[j] / bench_closes[j - 1] - 1
                for j in range(i - n + 1, i + 1)
                if bench_closes[j - 1]
            ]
            m = min(len(asset), len(bench_ret))
            if m < 2:
                return {'beta': 1.0, 'corr': 0.0, 'alpha': ret(n) - bret(n)}
            asset = asset[-m:]
            bench_ret = bench_ret[-m:]
            ma = sum(asset) / m
            mb = sum(bench_ret) / m
            cov = sum((a - ma) * (b0 - mb) for a, b0 in zip(asset, bench_ret)) / (m - 1)
            var_b = sum((b0 - mb) ** 2 for b0 in bench_ret) / (m - 1)
            var_a = sum((a - ma) ** 2 for a in asset) / (m - 1)
            beta = cov / var_b if var_b else 1.0
            corr = cov / math.sqrt(var_a * var_b) if var_a > 0 and var_b > 0 else 0.0
            return {'beta': beta, 'corr': corr, 'alpha': ret(n) - beta * bret(n)}
        rets20 = [closes[j] / closes[j - 1] - 1 for j in range(max(1, i - 19), i + 1) if closes[j - 1]]
        hi20prev = max(highs[max(0, i - 20):i]) if i else b['h']
        hi60prev = max(highs[max(0, i - 60):i]) if i else b['h']
        hi120prev = max(highs[max(0, i - 120):i]) if i else b['h']
        breakout20 = b['c'] / hi20prev - 1 if hi20prev else 0.0
        breakout60 = b['c'] / hi60prev - 1 if hi60prev else 0.0
        breakout120 = b['c'] / hi120prev - 1 if hi120prev else 0.0
        vol_ratio20 = b['v'] / vma20[i] if vma20[i] else 1.0
        vol_ratio60 = b['v'] / vma60[i] if vma60[i] else 1.0
        amount_ratio5 = amounts[i] / ama5[i] if ama5[i] else 1.0
        amount_ratio20 = amounts[i] / ama20[i] if ama20[i] else 1.0
        amount_ratio60 = amounts[i] / ama60[i] if ama60[i] else 1.0
        amount_trend = ama5[i] / ama20[i] if ama20[i] else 1.0
        amount20_sum = sum(amounts[max(0, i - 19):i + 1])
        amount60_sum = sum(amounts[max(0, i - 59):i + 1])
        amount_price20 = sum(closes[j] * amounts[j] for j in range(max(0, i - 19), i + 1)) / amount20_sum if amount20_sum else ma20[i]
        amount_price60 = sum(closes[j] * amounts[j] for j in range(max(0, i - 59), i + 1)) / amount60_sum if amount60_sum else ma60[i]
        amount_price_dist20 = b['c'] / amount_price20 - 1 if amount_price20 else 0.0
        amount_price_dist60 = b['c'] / amount_price60 - 1 if amount_price60 else 0.0
        slope20_60 = ma20[i] / ma60[i] - 1 if ma60[i] else 0.0
        accel20_60 = ret(20) - ret(60)
        low60prev = min(lows[max(0, i - 60):i]) if i else b['l']
        low120prev = min(lows[max(0, i - 120):i]) if i else b['l']
        pos60 = (b['c'] - low60prev) / (hi60prev - low60prev) if hi60prev > low60prev else 0.5
        pos120 = (b['c'] - low120prev) / (hi120prev - low120prev) if hi120prev > low120prev else 0.5
        dist_ma20 = b['c'] / ma20[i] - 1 if ma20[i] else 0.0
        dist_ma60 = b['c'] / ma60[i] - 1 if ma60[i] else 0.0
        dist_ma120 = b['c'] / ma120[i] - 1 if ma120[i] else 0.0
        ma_stack = (1 if ma20[i] > ma60[i] > ma120[i] else 0) + max(0.0, slope20_60)
        atr_pct = atr20[i] / b['c'] if b['c'] else 0.0
        atr_ratio20_60 = atr20[i] / atr60[i] if atr60[i] else 1.0
        day_range = b['h'] - b['l']
        intraday_range_pct = day_range / b['c'] if b['c'] else 0.0
        close_location = (b['c'] - b['l']) / day_range if day_range else 0.5
        body_pct = (b['c'] - b['o']) / b['o'] if b['o'] else 0.0
        upper_shadow_pct = (b['h'] - max(b['o'], b['c'])) / b['c'] if b['c'] else 0.0
        lower_shadow_pct = (min(b['o'], b['c']) - b['l']) / b['c'] if b['c'] else 0.0
        gap_pct = (b['o'] / closes[i - 1] - 1) if i and closes[i - 1] else 0.0
        range_contract = 1.0 - atr_ratio20_60
        vol20 = stdev(rets20) * math.sqrt(252)
        def path_stats(n):
            if i < n:
                return {
                    'up_ratio': 0.5,
                    'eff': 0.0,
                    'sharpe': 0.0,
                    'sortino': 0.0,
                    'maxdd': 0.0,
                    'ulcer': 0.0,
                    'skew': 0.0,
                    'tail_loss': 0.0,
                    'calmar': 0.0,
                }
            win_closes = closes[i - n:i + 1]
            win_rets = [
                win_closes[j] / win_closes[j - 1] - 1
                for j in range(1, len(win_closes))
                if win_closes[j - 1]
            ]
            total = ret(n)
            abs_sum = sum(abs(x) for x in win_rets)
            vol = stdev(win_rets) * math.sqrt(n) if len(win_rets) > 1 else 0.0
            downside = math.sqrt(sum(min(0.0, x) ** 2 for x in win_rets) / len(win_rets)) * math.sqrt(n) if win_rets else 0.0
            peak = win_closes[0]
            maxdd = 0.0
            drawdowns = []
            for px0 in win_closes:
                peak = max(peak, px0)
                dd = px0 / peak - 1 if peak else 0.0
                maxdd = min(maxdd, dd)
                drawdowns.append(dd)
            ulcer = math.sqrt(sum(dd * dd for dd in drawdowns) / len(drawdowns)) if drawdowns else 0.0
            rmean = sum(win_rets) / len(win_rets) if win_rets else 0.0
            rstd = stdev(win_rets)
            skew = (
                sum((x - rmean) ** 3 for x in win_rets) / len(win_rets) / (rstd ** 3)
                if win_rets and rstd else 0.0
            )
            tail_loss = sum(sorted(win_rets)[:max(1, len(win_rets) // 5)]) / max(1, len(win_rets) // 5) if win_rets else 0.0
            calmar = total / abs(maxdd) if maxdd < 0 else total
            return {
                'up_ratio': sum(1 for x in win_rets if x > 0) / len(win_rets) if win_rets else 0.5,
                'eff': total / abs_sum if abs_sum else 0.0,
                'sharpe': total / vol if vol else 0.0,
                'sortino': total / downside if downside else 0.0,
                'maxdd': maxdd,
                'ulcer': ulcer,
                'skew': skew,
                'tail_loss': tail_loss,
                'calmar': calmar,
            }
        p30 = path_stats(30)
        p60 = path_stats(60)
        up_ratio30 = p30['up_ratio']
        up_ratio60 = p60['up_ratio']
        efficiency30 = p30['eff']
        efficiency60 = p60['eff']
        sharpe30 = p30['sharpe']
        sharpe60 = p60['sharpe']
        sortino30 = p30['sortino']
        sortino60 = p60['sortino']
        path_mdd30 = p30['maxdd']
        path_mdd60 = p60['maxdd']
        ulcer30 = p30['ulcer']
        ulcer60 = p60['ulcer']
        skew30 = p30['skew']
        skew60 = p60['skew']
        tail_loss30 = p30['tail_loss']
        tail_loss60 = p60['tail_loss']
        calmar30 = p30['calmar']
        calmar60 = p60['calmar']
        smooth_mom30 = ret(30) + 0.20 * efficiency30 + 0.10 * (up_ratio30 - 0.5) + 0.50 * path_mdd30
        smooth_mom60 = ret(60) + 0.20 * efficiency60 + 0.10 * (up_ratio60 - 0.5) + 0.50 * path_mdd60
        drawdown_adjusted_mom30 = ret(30) + path_mdd30
        drawdown_adjusted_mom60 = ret(60) + path_mdd60
        ulcer_adjusted_mom30 = ret(30) - 0.60 * ulcer30
        tail_risk_adjusted_mom30 = ret(30) + 0.80 * tail_loss30 + 0.08 * max(0.0, skew30)
        calmar_mom30 = ret(30) + 0.03 * min(max(calmar30, -3.0), 5.0)
        quiet_trend = ret(60) - 0.8 * vol20
        vol_dryup = -abs(vol_ratio20 - 1.0) + max(0.0, ret(60))
        turnover_proxy = math.log(max(1.0, b['v']))
        amount_proxy = math.log(max(1.0, amounts[i]))
        amount_confirm = max(0.0, amount_ratio20 - 1.0)
        amount_breakout = max(0.0, breakout60) + 0.25 * max(0.0, amount_ratio20 - 1.0) + 0.15 * max(0.0, amount_trend - 1.0)
        price_amount_power = ret(30) + 0.35 * max(0.0, amount_ratio20 - 1.0) + 0.20 * max(0.0, amount_trend - 1.0)
        amount_dryup_pullback = max(0.0, ret(60)) - abs(amount_ratio20 - 0.8) - max(0.0, dist_ma20)
        mom30_amount_blend = ret(30) + 0.08 * min(max(0.0, amount_ratio20 - 1.0), 2.0)
        mom30_breakout_amount = ret(30) + 0.20 * max(0.0, breakout60) + 0.06 * min(max(0.0, amount_ratio20 - 1.0), 2.0)
        amount_cost_reclaim_score = (
            ret(30)
            + 0.12 * max(0.0, amount_price_dist20)
            + 0.10 * max(0.0, amount_price_dist60)
            + 0.06 * max(0.0, amount_trend - 1.0)
        )
        volume_price_absorption_score = (
            ret(30)
            + 0.08 * min(max(0.0, amount_ratio20 - 1.0), 2.0)
            + 0.08 * max(0.0, close_location - 0.55)
            - 0.08 * max(0.0, upper_shadow_pct - lower_shadow_pct)
        )
        mom30_trend_quality = ret(30) + 0.25 * max(0.0, slope20_60) + 0.10 * max(0.0, dist_ma60) - 0.15 * atr_pct
        mom20_trend_quality = ret(20) + 0.25 * max(0.0, slope20_60) + 0.10 * max(0.0, dist_ma60) - 0.15 * atr_pct
        mom40_trend_quality = ret(40) + 0.25 * max(0.0, slope20_60) + 0.10 * max(0.0, dist_ma60) - 0.15 * atr_pct
        mom30_trend_quality_fast = ret(30) + 0.35 * max(0.0, slope20_60) + 0.05 * max(0.0, dist_ma60) - 0.15 * atr_pct
        mom30_trend_quality_smooth = ret(30) + 0.15 * max(0.0, slope20_60) + 0.15 * max(0.0, dist_ma60) - 0.15 * atr_pct
        mom30_trend_quality_lightvol = ret(30) + 0.25 * max(0.0, slope20_60) + 0.10 * max(0.0, dist_ma60) - 0.08 * atr_pct
        mom30_trend_quality_heavyvol = ret(30) + 0.25 * max(0.0, slope20_60) + 0.10 * max(0.0, dist_ma60) - 0.25 * atr_pct
        downside_control_score = mom30_trend_quality_smooth - 0.35 * ulcer30 + 0.25 * tail_loss30
        drawdown_repair_score = mom30_trend_quality_smooth + 0.20 * (pos60 - 0.5) + 0.25 * path_mdd30
        term_structure_slope = ret(30) - ret(120)
        term_structure_curve = ret(20) - 0.5 * ret(60) - 0.5 * ret(120)
        multi_period_consistency = (
            sum(1 for x in (ret(20), ret(30), ret(60), ret(90), ret(120)) if x > 0) / 5
        )
        multi_mom_blend = 0.40 * ret(30) + 0.25 * ret(60) + 0.20 * ret(90) + 0.15 * ret(120)
        multi_mom_quality_score = multi_mom_blend + 0.12 * max(0.0, slope20_60) + 0.08 * max(0.0, dist_ma60) - 0.12 * atr_pct
        short_over_mid_heat = ret(20) - ret(60)
        balanced_momentum_score = (
            mom30_trend_quality_smooth
            + 0.05 * multi_period_consistency
            - 0.08 * max(0.0, short_over_mid_heat - 0.25)
        )
        acceleration_curve_score = (
            mom30_trend_quality_smooth
            + 0.10 * max(0.0, ret(30) - ret(60))
            - 0.06 * max(0.0, ret(20) - ret(30) - 0.12)
        )
        barbell_momentum_score = 0.55 * ret(30) + 0.30 * ret(120) + 0.15 * max(0.0, breakout60) - 0.10 * atr_pct
        candle_strength_score = (
            mom30_trend_quality_smooth
            + 0.08 * (close_location - 0.5)
            + 0.08 * max(0.0, body_pct)
            - 0.05 * upper_shadow_pct
        )
        squeeze_breakout_score = (
            mom30_trend_quality_smooth
            + 0.10 * max(0.0, range_contract)
            + 0.08 * max(0.0, breakout60)
            + 0.05 * (close_location - 0.5)
        )
        vcp_breakout_score = (
            mom30_trend_quality_smooth
            + 0.12 * max(0.0, range_contract)
            + 0.10 * max(0.0, breakout60)
            + 0.06 * max(0.0, amount_trend - 1.0)
            - 0.06 * max(0.0, upper_shadow_pct - lower_shadow_pct)
        )
        gap_momentum_score = (
            mom30_trend_quality_smooth
            + 0.08 * max(0.0, gap_pct)
            + 0.05 * max(0.0, body_pct)
            - 0.08 * max(0.0, upper_shadow_pct - lower_shadow_pct)
        )
        bs30 = bench_stats(30)
        bs60 = bench_stats(60)
        bs90 = bench_stats(90)
        beta30 = bs30['beta']
        beta60 = bs60['beta']
        corr30 = bs30['corr']
        corr60 = bs60['corr']
        alpha30 = bs30['alpha']
        alpha60 = bs60['alpha']
        alpha90 = bs90['alpha']
        residual_mom30 = alpha30
        residual_mom60 = alpha60
        alpha_trend_quality = alpha30 + 0.15 * max(0.0, slope20_60) + 0.10 * max(0.0, dist_ma60) - 0.15 * atr_pct
        independent_trend_score = mom30_trend_quality_smooth + 0.25 * alpha30 - 0.05 * max(0.0, corr60)
        low_beta_alpha_score = alpha60 - 0.05 * max(0.0, beta60 - 1.0) + 0.10 * max(0.0, dist_ma60)
        path_quality_score = (
            mom30_trend_quality_smooth
            + 0.12 * efficiency30
            + 0.08 * (up_ratio30 - 0.5)
            + 0.40 * path_mdd30
        )
        rs30_trend_quality = rsret(30) + 0.15 * max(0.0, slope20_60) + 0.10 * max(0.0, dist_ma60) - 0.15 * atr_pct
        rs60_trend_quality = rsret(60) + 0.15 * max(0.0, slope20_60) + 0.10 * max(0.0, dist_ma60) - 0.15 * atr_pct
        mom_rs30_blend = 0.60 * ret(30) + 0.40 * rsret(30)
        mom_rs60_blend = 0.55 * ret(60) + 0.45 * rsret(60)
        mom_rs_quality = 0.55 * mom30_trend_quality_smooth + 0.45 * rs30_trend_quality
        rs_accel = rsret(30) - rsret(90)
        rsi_period = [closes[j] / closes[j - 1] - 1 for j in range(max(1, i - 13), i + 1) if closes[j - 1]]
        gains = sum(max(0.0, x) for x in rsi_period)
        losses = sum(max(0.0, -x) for x in rsi_period)
        rsi14 = gains / (gains + losses) if gains + losses > 0 else 0.5
        stoch_low14 = min(lows[max(0, i - 13):i + 1])
        stoch_high14 = max(highs[max(0, i - 13):i + 1])
        stoch_k14 = (b['c'] - stoch_low14) / (stoch_high14 - stoch_low14) if stoch_high14 > stoch_low14 else 0.5
        stoch_low9 = min(lows[max(0, i - 8):i + 1])
        stoch_high9 = max(highs[max(0, i - 8):i + 1])
        kdj_k = (b['c'] - stoch_low9) / (stoch_high9 - stoch_low9) if stoch_high9 > stoch_low9 else 0.5
        willr14 = (stoch_high14 - b['c']) / (stoch_high14 - stoch_low14) if stoch_high14 > stoch_low14 else 0.5
        boll_mid = ma20[i]
        boll_width = 2 * stdev(closes[max(0, i - 19):i + 1]) if i >= 19 else 0.0
        boll_pctb = (b['c'] - (boll_mid - boll_width)) / (2 * boll_width) if boll_width else 0.5
        boll_width_pct = (2 * boll_width) / boll_mid if boll_mid else 0.0
        boll_squeeze = -boll_width_pct + max(0.0, boll_pctb - 0.8)
        macd_hist = macd_dif[i] - macd_dea[i]
        macd_norm = macd_hist / b['c'] if b['c'] else 0.0
        macd_trend_score = mom30_trend_quality_smooth + 0.35 * macd_norm + 0.08 * max(0.0, macd_dif[i] / b['c'] if b['c'] else 0.0)
        plus_di20 = 100 * plus_dm20[i] / atr20[i] if atr20[i] else 0.0
        minus_di20 = 100 * minus_dm20[i] / atr20[i] if atr20[i] else 0.0
        dmi_spread20 = (plus_di20 - minus_di20) / 100.0
        adx20 = adx20_series[i]
        dmi_trend_score = mom30_trend_quality_smooth + 0.10 * dmi_spread20 + 0.06 * adx20
        adx_breakout_score = max(0.0, breakout60) + 0.08 * adx20 + 0.10 * max(0.0, dmi_spread20)
        obv_base20 = sum(vols[max(0, i - 19):i + 1]) or 1.0
        amount_base20 = sum(amounts[max(0, i - 19):i + 1]) or 1.0
        obv_slope20 = (obv[i] - obv[i - 20]) / obv_base20 if i >= 20 else 0.0
        amount_obv_slope20 = (amount_obv[i] - amount_obv[i - 20]) / amount_base20 if i >= 20 else 0.0
        pvt_slope20 = (pvt[i] - pvt[i - 20]) / obv_base20 if i >= 20 else 0.0
        obv_confirm_score = mom30_trend_quality_smooth + 0.08 * obv_slope20 + 0.06 * amount_obv_slope20
        pvt_confirm_score = mom30_trend_quality_smooth + 0.10 * pvt_slope20
        typicals = [(highs[j] + lows[j] + closes[j]) / 3 for j in range(max(1, i - 13), i + 1)]
        mf_pos = 0.0
        mf_neg = 0.0
        start_j = max(1, i - 13)
        for off, j in enumerate(range(start_j, i + 1)):
            tp = typicals[off]
            prev_tp = (highs[j - 1] + lows[j - 1] + closes[j - 1]) / 3
            flow = tp * vols[j]
            if tp > prev_tp:
                mf_pos += flow
            elif tp < prev_tp:
                mf_neg += flow
        mfi14 = mf_pos / (mf_pos + mf_neg) if mf_pos + mf_neg else 0.5
        mfi_trend_score = mom30_trend_quality_smooth + 0.08 * (mfi14 - 0.5)
        typical20 = [(highs[j] + lows[j] + closes[j]) / 3 for j in range(max(0, i - 19), i + 1)]
        tp_now = (b['h'] + b['l'] + b['c']) / 3
        tp_mean = sum(typical20) / len(typical20)
        mean_dev = sum(abs(x - tp_mean) for x in typical20) / len(typical20)
        cci20 = (tp_now - tp_mean) / (0.015 * mean_dev) if mean_dev else 0.0
        cci_norm = cci20 / 200.0
        swing_strength_score = mom30_trend_quality_smooth + 0.06 * (stoch_k14 - 0.5) + 0.05 * max(0.0, cci_norm)
        oversold_rebound_score = max(0.0, ret(60)) + 0.15 * max(0.0, 0.35 - rsi14) + 0.12 * max(0.0, 0.25 - stoch_k14) - 0.10 * max(0.0, -dist_ma60)
        high_reclaim60 = b['c'] / hi60prev - 1 if hi60prev else 0.0
        dd_from_high60 = b['c'] / hi60prev - 1 if hi60prev else 0.0
        recovery_from_low60 = b['c'] / low60prev - 1 if low60prev else 0.0
        channel_width60 = (hi60prev - low60prev) / b['c'] if b['c'] and hi60prev > low60prev else 0.0
        reg30 = linreg_stats(closes[max(0, i - 29):i + 1])
        reg60 = linreg_stats(closes[max(0, i - 59):i + 1])
        reg_slope30 = reg30['slope_ret']
        reg_slope60 = reg60['slope_ret']
        reg_r2_30 = reg30['r2']
        reg_r2_60 = reg60['r2']
        regression_trend_score = mom30_trend_quality_smooth + 0.18 * max(0.0, reg_slope30) + 0.08 * reg_r2_30
        regression_mainline_score = 0.55 * mom30_trend_quality_smooth + 0.30 * max(0.0, reg_slope60) + 0.15 * reg_r2_60
        aroon_n = 25
        aroon_highs = highs[max(0, i - aroon_n + 1):i + 1]
        aroon_lows = lows[max(0, i - aroon_n + 1):i + 1]
        high_pos = max(range(len(aroon_highs)), key=lambda j: aroon_highs[j]) if aroon_highs else 0
        low_pos = min(range(len(aroon_lows)), key=lambda j: aroon_lows[j]) if aroon_lows else 0
        denom = max(1, len(aroon_highs) - 1)
        aroon_up25 = high_pos / denom
        aroon_down25 = low_pos / denom
        aroon_osc25 = aroon_up25 - aroon_down25
        aroon_trend_score = mom30_trend_quality_smooth + 0.08 * aroon_osc25 + 0.05 * max(0.0, aroon_up25 - 0.7)
        pullback_depth20 = (ma20[i] / b['c'] - 1) if ma20[i] and b['c'] else 0.0
        pullback_depth60 = (ma60[i] / b['c'] - 1) if ma60[i] and b['c'] else 0.0
        uptrend_pullback_score = max(0.0, ret(60)) + 0.18 * max(0.0, slope20_60) - abs(pullback_depth20) - 0.08 * max(0.0, pullback_depth60)
        ma_pullback_reclaim_score = (
            max(0.0, ret(60))
            + 0.14 * max(0.0, slope20_60)
            + 0.10 * max(0.0, body_pct)
            + 0.08 * max(0.0, close_location - 0.55)
            - 0.35 * abs(dist_ma20)
            - 0.08 * max(0.0, -dist_ma60)
        )
        volatility_expansion_score = mom30_trend_quality_smooth + 0.10 * max(0.0, atr_ratio20_60 - 1.0) + 0.08 * max(0.0, breakout60)
        volatility_regime_shift_score = (
            mom30_trend_quality_smooth
            + 0.08 * max(0.0, atr_ratio20_60 - 1.0)
            + 0.08 * max(0.0, range_contract)
            + 0.05 * max(0.0, breakout20)
        )
        streak_above20 = 0
        streak_above60 = 0
        streak_up = 0
        for j in range(i, -1, -1):
            if closes[j] > ma20[j]:
                streak_above20 += 1
            else:
                break
        for j in range(i, -1, -1):
            if closes[j] > ma60[j]:
                streak_above60 += 1
            else:
                break
        for j in range(i, 0, -1):
            if closes[j] > closes[j - 1]:
                streak_up += 1
            else:
                break
        high_close_hits20 = 0
        high_close_hits60 = 0
        for j in range(max(0, i - 19), i + 1):
            hprev = max(highs[max(0, j - 60):j + 1])
            if hprev and closes[j] >= hprev * 0.995:
                high_close_hits20 += 1
        for j in range(max(0, i - 59), i + 1):
            hprev = max(highs[max(0, j - 60):j + 1])
            if hprev and closes[j] >= hprev * 0.995:
                high_close_hits60 += 1
        new_high_rate20 = high_close_hits20 / min(20, i + 1)
        new_high_rate60 = high_close_hits60 / min(60, i + 1)
        rets30 = [closes[j] / closes[j - 1] - 1 for j in range(max(1, i - 29), i + 1) if closes[j - 1]]
        mom30_z = ret(30) / (stdev(rets30) * math.sqrt(30)) if len(rets30) > 2 and stdev(rets30) else 0.0
        trend_age_score = (
            mom30_trend_quality_smooth
            + 0.04 * min(streak_above20 / 20, 1.0)
            + 0.04 * min(streak_above60 / 60, 1.0)
            - 0.03 * max(0.0, streak_above60 / 80 - 1.0)
        )
        new_high_persistence_score = (
            mom30_trend_quality_smooth
            + 0.08 * new_high_rate20
            + 0.05 * new_high_rate60
            + 0.04 * max(0.0, breakout60)
        )
        normalized_momentum_score = mom30_trend_quality_smooth + 0.05 * max(0.0, min(mom30_z, 3.0))
        anti_exhaustion_score = (
            mom30_trend_quality_smooth
            - 0.08 * max(0.0, rsi14 - 0.85)
            - 0.06 * max(0.0, boll_pctb - 1.05)
            - 0.05 * max(0.0, upper_shadow_pct - lower_shadow_pct)
        )
        mature_trend_score = (
            0.70 * mom30_trend_quality_smooth
            + 0.12 * min(streak_above60 / 60, 1.0)
            + 0.10 * new_high_rate60
            + 0.08 * max(0.0, alpha30)
        )
        recovery_breakout_score = (
            0.55 * ret(30)
            + 0.20 * max(0.0, high_reclaim60)
            + 0.15 * min(max(0.0, recovery_from_low60), 0.8)
            - 0.10 * max(0.0, -dd_from_high60)
        )
        ma_ribbon_width = (max(ma20[i], ma30[i], ma60[i], ma120[i]) / min(ma20[i], ma30[i], ma60[i], ma120[i]) - 1) if min(ma20[i], ma30[i], ma60[i], ma120[i]) else 0.0
        ma_ribbon_score = mom30_trend_quality_smooth + 0.08 * ma_ribbon_width + 0.08 * ma_stack
        trend_quality = ret(60) + slope20_60 + max(0.0, dist_ma60) - atr_pct
        breakout_quality = max(0.0, breakout60) + max(0.0, breakout120) + 0.5 * max(0.0, vol_ratio20 - 1.0) - atr_pct
        mainline_core = (
            0.45 * ret(60)
            + 0.35 * ret(30)
            + 0.20 * max(0.0, breakout60)
            + 0.15 * max(0.0, breakout120)
            + 0.20 * max(0.0, slope20_60)
            + 0.04 * min(max(0.0, vol_ratio20 - 1.0), 2.0)
        )
        mainline_early = (
            0.45 * ret(30)
            + 0.25 * ret(20)
            + 0.20 * max(0.0, breakout60)
            + 0.15 * max(0.0, slope20_60)
            + 0.05 * min(max(0.0, vol_ratio20 - 1.0), 2.0)
        )
        mainline_persist = (
            0.40 * ret(60)
            + 0.25 * ret(90)
            + 0.20 * max(0.0, slope20_60)
            + 0.15 * max(0.0, b['c'] / ma120[i] - 1 if ma120[i] else 0.0)
        )
        benchmark_risk_on = 0.60 * max(0.0, bret(30)) + 0.40 * max(0.0, bret(60))
        benchmark_risk_off = max(0.0, -bret(30)) + 0.5 * max(0.0, -bret(60))
        confirm_stack_score = (
            mom30_trend_quality_smooth
            + 0.05 * max(0.0, pvt_slope20)
            + 0.04 * max(0.0, gap_pct)
            + 0.04 * max(0.0, macd_norm)
            + 0.03 * max(0.0, alpha30)
        )
        ensemble_core_score = (
            0.55 * mom30_trend_quality_smooth
            + 0.18 * gap_momentum_score
            + 0.14 * pvt_confirm_score
            + 0.08 * mom_rs_quality
            + 0.05 * alpha_trend_quality
        )
        ensemble_risk_adjusted_score = (
            ensemble_core_score
            - 0.08 * max(0.0, atr_pct - 0.04)
            + 0.04 * path_mdd30
            - 0.04 * benchmark_risk_off
        )
        regime_trend_score = (
            mom30_trend_quality_smooth
            + 0.06 * benchmark_risk_on
            - 0.08 * benchmark_risk_off
            + 0.04 * max(0.0, alpha30)
        )
        mainline_quality_score = (
            0.50 * mom30_trend_quality_smooth
            + 0.18 * pvt_confirm_score
            + 0.14 * gap_momentum_score
            + 0.10 * mom_rs_quality
            + 0.08 * alpha_trend_quality
        )
        by[d] = {
            'o': b['o'],
            'h': b['h'],
            'l': b['l'],
            'c': b['c'],
            'amount': amounts[i],
            'nopen': bars[i + 1]['o'] if i + 1 < len(bars) else b['c'],
            'ma20': ma20[i],
            'ma30': ma30[i],
            'ma60': ma60[i],
            'ma120': ma120[i],
            'atr20': atr20[i],
            'atr60': atr60[i],
            'low10prev': min(lows[max(0, i - 10):i]) if i else b['l'],
            'low20prev': min(lows[max(0, i - 20):i]) if i else b['l'],
            'hi20prev': hi20prev,
            'hi60prev': hi60prev,
            'hi120prev': hi120prev,
            'breakout20': breakout20,
            'breakout60': breakout60,
            'breakout120': breakout120,
            'vol_ratio20': vol_ratio20,
            'vol_ratio60': vol_ratio60,
            'amount_ratio5': amount_ratio5,
            'amount_ratio20': amount_ratio20,
            'amount_ratio60': amount_ratio60,
            'amount_trend': amount_trend,
            'amount_price_dist20': amount_price_dist20,
            'amount_price_dist60': amount_price_dist60,
            'amount_confirm': amount_confirm,
            'amount_proxy': amount_proxy,
            'amount_breakout': amount_breakout,
            'price_amount_power': price_amount_power,
            'amount_dryup_pullback': amount_dryup_pullback,
            'mom30_amount_blend': mom30_amount_blend,
            'mom30_breakout_amount': mom30_breakout_amount,
            'amount_cost_reclaim_score': amount_cost_reclaim_score,
            'volume_price_absorption_score': volume_price_absorption_score,
            'mom30_trend_quality': mom30_trend_quality,
            'mom20_trend_quality': mom20_trend_quality,
            'mom40_trend_quality': mom40_trend_quality,
            'mom30_trend_quality_fast': mom30_trend_quality_fast,
            'mom30_trend_quality_smooth': mom30_trend_quality_smooth,
            'mom30_trend_quality_lightvol': mom30_trend_quality_lightvol,
            'mom30_trend_quality_heavyvol': mom30_trend_quality_heavyvol,
            'rs30_trend_quality': rs30_trend_quality,
            'rs60_trend_quality': rs60_trend_quality,
            'mom_rs30_blend': mom_rs30_blend,
            'mom_rs60_blend': mom_rs60_blend,
            'mom_rs_quality': mom_rs_quality,
            'rs_accel': rs_accel,
            'up_ratio30': up_ratio30,
            'up_ratio60': up_ratio60,
            'efficiency30': efficiency30,
            'efficiency60': efficiency60,
            'sharpe30': sharpe30,
            'sharpe60': sharpe60,
            'sortino30': sortino30,
            'sortino60': sortino60,
            'path_mdd30': path_mdd30,
            'path_mdd60': path_mdd60,
            'ulcer30': ulcer30,
            'ulcer60': ulcer60,
            'skew30': skew30,
            'skew60': skew60,
            'tail_loss30': tail_loss30,
            'tail_loss60': tail_loss60,
            'calmar30': calmar30,
            'calmar60': calmar60,
            'smooth_mom30': smooth_mom30,
            'smooth_mom60': smooth_mom60,
            'drawdown_adjusted_mom30': drawdown_adjusted_mom30,
            'drawdown_adjusted_mom60': drawdown_adjusted_mom60,
            'ulcer_adjusted_mom30': ulcer_adjusted_mom30,
            'tail_risk_adjusted_mom30': tail_risk_adjusted_mom30,
            'calmar_mom30': calmar_mom30,
            'downside_control_score': downside_control_score,
            'drawdown_repair_score': drawdown_repair_score,
            'term_structure_slope': term_structure_slope,
            'term_structure_curve': term_structure_curve,
            'multi_period_consistency': multi_period_consistency,
            'multi_mom_blend': multi_mom_blend,
            'multi_mom_quality_score': multi_mom_quality_score,
            'short_over_mid_heat': short_over_mid_heat,
            'balanced_momentum_score': balanced_momentum_score,
            'acceleration_curve_score': acceleration_curve_score,
            'barbell_momentum_score': barbell_momentum_score,
            'path_quality_score': path_quality_score,
            'slope20_60': slope20_60,
            'accel20_60': accel20_60,
            'pos60': pos60,
            'pos120': pos120,
            'dist_ma20': dist_ma20,
            'dist_ma60': dist_ma60,
            'dist_ma120': dist_ma120,
            'ma_stack': ma_stack,
            'atr_pct': atr_pct,
            'atr_ratio20_60': atr_ratio20_60,
            'range_contract': range_contract,
            'intraday_range_pct': intraday_range_pct,
            'close_location': close_location,
            'body_pct': body_pct,
            'upper_shadow_pct': upper_shadow_pct,
            'lower_shadow_pct': lower_shadow_pct,
            'gap_pct': gap_pct,
            'candle_strength_score': candle_strength_score,
            'squeeze_breakout_score': squeeze_breakout_score,
            'vcp_breakout_score': vcp_breakout_score,
            'gap_momentum_score': gap_momentum_score,
            'beta30': beta30,
            'beta60': beta60,
            'corr30': corr30,
            'corr60': corr60,
            'alpha30': alpha30,
            'alpha60': alpha60,
            'alpha90': alpha90,
            'residual_mom30': residual_mom30,
            'residual_mom60': residual_mom60,
            'alpha_trend_quality': alpha_trend_quality,
            'independent_trend_score': independent_trend_score,
            'low_beta_alpha_score': low_beta_alpha_score,
            'inv_atr': -atr_pct,
            'quiet_trend': quiet_trend,
            'vol_dryup': vol_dryup,
            'turnover_proxy': turnover_proxy,
            'rsi14': rsi14,
            'stoch_k14': stoch_k14,
            'kdj_k': kdj_k,
            'willr14': willr14,
            'boll_pctb': boll_pctb,
            'boll_width_pct': boll_width_pct,
            'boll_squeeze': boll_squeeze,
            'macd_hist': macd_hist,
            'macd_norm': macd_norm,
            'macd_trend_score': macd_trend_score,
            'plus_di20': plus_di20,
            'minus_di20': minus_di20,
            'dmi_spread20': dmi_spread20,
            'adx20': adx20,
            'dmi_trend_score': dmi_trend_score,
            'adx_breakout_score': adx_breakout_score,
            'obv_slope20': obv_slope20,
            'amount_obv_slope20': amount_obv_slope20,
            'pvt_slope20': pvt_slope20,
            'obv_confirm_score': obv_confirm_score,
            'pvt_confirm_score': pvt_confirm_score,
            'mfi14': mfi14,
            'mfi_trend_score': mfi_trend_score,
            'cci20': cci20,
            'cci_norm': cci_norm,
            'swing_strength_score': swing_strength_score,
            'oversold_rebound_score': oversold_rebound_score,
            'high_reclaim60': high_reclaim60,
            'dd_from_high60': dd_from_high60,
            'recovery_from_low60': recovery_from_low60,
            'channel_width60': channel_width60,
            'reg_slope30': reg_slope30,
            'reg_slope60': reg_slope60,
            'reg_r2_30': reg_r2_30,
            'reg_r2_60': reg_r2_60,
            'regression_trend_score': regression_trend_score,
            'regression_mainline_score': regression_mainline_score,
            'aroon_up25': aroon_up25,
            'aroon_down25': aroon_down25,
            'aroon_osc25': aroon_osc25,
            'aroon_trend_score': aroon_trend_score,
            'uptrend_pullback_score': uptrend_pullback_score,
            'ma_pullback_reclaim_score': ma_pullback_reclaim_score,
            'volatility_expansion_score': volatility_expansion_score,
            'volatility_regime_shift_score': volatility_regime_shift_score,
            'streak_above20': streak_above20,
            'streak_above60': streak_above60,
            'streak_up': streak_up,
            'new_high_rate20': new_high_rate20,
            'new_high_rate60': new_high_rate60,
            'mom30_z': mom30_z,
            'trend_age_score': trend_age_score,
            'new_high_persistence_score': new_high_persistence_score,
            'normalized_momentum_score': normalized_momentum_score,
            'anti_exhaustion_score': anti_exhaustion_score,
            'mature_trend_score': mature_trend_score,
            'recovery_breakout_score': recovery_breakout_score,
            'ma_ribbon_width': ma_ribbon_width,
            'ma_ribbon_score': ma_ribbon_score,
            'trend_quality': trend_quality,
            'breakout_quality': breakout_quality,
            'mom60': ret(60),
            'mom90': ret(90),
            'mom120': ret(120),
            'mom20': ret(20),
            'mom25': ret(25),
            'mom30': ret(30),
            'mom35': ret(35),
            'mom40': ret(40),
            'mom45': ret(45),
            'mom50': ret(50),
            'mom55': ret(55),
            'mom126': ret(126),
            'mom252': ret(252),
            'abs13612': 12 * ret(21) + 4 * ret(63) + 2 * ret(126) + ret(252),
            'abs_mom_blend': 0.5 * ret(90) + 0.3 * ret(60) + 0.2 * ret(120),
            'abs_accel': ret(60) - ret(120),
            'early_breakout': breakout60 + 0.5 * ret(20) + 0.2 * max(0.0, vol_ratio20 - 1.0) + 0.5 * slope20_60,
            'early_accel': accel20_60 + 0.5 * breakout20 + 0.2 * max(0.0, vol_ratio20 - 1.0),
            'early_trend': 0.4 * ret(20) + 0.4 * ret(60) + 0.2 * slope20_60 + 0.1 * max(0.0, vol_ratio60 - 1.0),
            'sprint25_35': 0.5 * ret(25) + 0.5 * ret(35),
            'sprint30_45': 0.6 * ret(30) + 0.4 * ret(45),
            'sprint_accel': ret(30) + 0.5 * (ret(30) - ret(60)),
            'mainline_core': mainline_core,
            'mainline_early': mainline_early,
            'mainline_persist': mainline_persist,
            'benchmark_risk_on': benchmark_risk_on,
            'benchmark_risk_off': benchmark_risk_off,
            'confirm_stack_score': confirm_stack_score,
            'ensemble_core_score': ensemble_core_score,
            'ensemble_risk_adjusted_score': ensemble_risk_adjusted_score,
            'regime_trend_score': regime_trend_score,
            'mainline_quality_score': mainline_quality_score,
            'rs20': rsret(20),
            'rs30': rsret(30),
            'rs60': rsret(60),
            'rs90': rsret(90),
            'rs120': rsret(120),
            'combo90': 0.5 * rsret(90) + 0.5 * ret(90),
            'combo60_90': 0.5 * rsret(60) + 0.5 * rsret(90),
            'above60': b['c'] > ma60[i],
            'above120': b['c'] > ma120[i],
            'vol20': vol20,
            'inv_vol20': -vol20,
        }
    U[code] = (name, by)


theme_members = {}
for code, (name, _) in U.items():
    theme_members.setdefault(family(name), []).append(code)

for d in days:
    for fam, codes in theme_members.items():
        rows = [(c, U[c][1][d]) for c in codes if d in U[c][1]]
        if not rows:
            continue
        n = len(rows)
        avg_mom30 = sum(r['mom30'] for _, r in rows) / n
        avg_mom60 = sum(r['mom60'] for _, r in rows) / n
        best_mom30 = max(r['mom30'] for _, r in rows)
        breadth_above60 = sum(1 for _, r in rows if r['above60']) / n
        breadth_above120 = sum(1 for _, r in rows if r['above120']) / n
        breadth_mom30 = sum(1 for _, r in rows if r['mom30'] > 0.08) / n
        breadth_breakout60 = sum(1 for _, r in rows if r['breakout60'] > 0) / n
        avg_vol_ratio20 = sum(r['vol_ratio20'] for _, r in rows) / n
        avg_amount_ratio20 = sum(r['amount_ratio20'] for _, r in rows) / n
        avg_amount_trend = sum(r['amount_trend'] for _, r in rows) / n
        breadth_amount_confirm = sum(1 for _, r in rows if r['amount_ratio20'] > 1.25) / n
        theme_width = 0.35 * breadth_above120 + 0.30 * breadth_mom30 + 0.20 * breadth_breakout60 + 0.15 * max(0.0, avg_mom30)
        theme_power = 0.45 * avg_mom30 + 0.25 * avg_mom60 + 0.20 * breadth_above120 + 0.10 * min(max(0.0, avg_vol_ratio20 - 1.0), 2.0)
        theme_leader = best_mom30 + 0.35 * breadth_above120 + 0.20 * breadth_breakout60
        theme_amount_power = theme_power + 0.12 * min(max(0.0, avg_amount_ratio20 - 1.0), 2.0) + 0.08 * breadth_amount_confirm
        for _, r in rows:
            mom30_width_blend = r['mom30'] + 0.25 * theme_width
            mom30_theme_power = r['mom30'] + 0.20 * theme_power
            mom30_theme_leader = r['mom30'] + 0.15 * theme_leader
            mom30_theme_amount = r['mom30'] + 0.20 * theme_width + 0.06 * min(max(0.0, avg_amount_ratio20 - 1.0), 2.0)
            mom30_width_stable = r['mom30'] + 0.20 * theme_width - 0.04 * max(0.0, r['amount_ratio20'] - 2.0)
            r['theme_avg_mom30'] = avg_mom30
            r['theme_avg_mom60'] = avg_mom60
            r['theme_best_mom30'] = best_mom30
            r['theme_breadth_above60'] = breadth_above60
            r['theme_breadth_above120'] = breadth_above120
            r['theme_breadth_mom30'] = breadth_mom30
            r['theme_breadth_breakout60'] = breadth_breakout60
            r['theme_avg_vol_ratio20'] = avg_vol_ratio20
            r['theme_avg_amount_ratio20'] = avg_amount_ratio20
            r['theme_avg_amount_trend'] = avg_amount_trend
            r['theme_breadth_amount_confirm'] = breadth_amount_confirm
            r['theme_width'] = theme_width
            r['theme_power'] = theme_power
            r['theme_leader'] = theme_leader
            r['theme_amount_power'] = theme_amount_power
            r['mom30_width_blend'] = mom30_width_blend
            r['mom30_theme_power'] = mom30_theme_power
            r['mom30_theme_leader'] = mom30_theme_leader
            r['mom30_theme_amount'] = mom30_theme_amount
            r['mom30_width_stable'] = mom30_width_stable
            r['theme_member_count'] = n


PERSIST_SCORE_KEYS = (
    'mom30_trend_quality_smooth',
    'mom30',
    'theme_width',
    'mom30_theme_power',
)
top_sets = {key: {} for key in PERSIST_SCORE_KEYS}
theme_top_sets = {}
rank_stats = {}
theme_rank_stats = {}
for d in days:
    for key in PERSIST_SCORE_KEYS:
        ranked = [
            (by[d][key], c)
            for c, (_, by) in U.items()
            if d in by and by[d].get('above60')
        ]
        ranked.sort(reverse=True)
        top_sets[key][d] = {c for _, c in ranked[:8]}
        total = max(1, len(ranked) - 1)
        for pos, (_, c) in enumerate(ranked):
            row = rank_stats.setdefault((d, c), {})
            row[f'{key}_rank_pct'] = 1.0 - pos / total if total else 1.0
            row[f'{key}_rank_pos'] = pos + 1

    fam_ranked = []
    for fam, codes in theme_members.items():
        vals = [U[c][1][d]['theme_width'] for c in codes if d in U[c][1]]
        if vals:
            fam_ranked.append((max(vals), fam))
    fam_ranked.sort(reverse=True)
    theme_top_sets[d] = {fam for _, fam in fam_ranked[:6]}
    total = max(1, len(fam_ranked) - 1)
    for pos, (_, fam) in enumerate(fam_ranked):
        theme_rank_stats[(d, fam)] = {
            'theme_rank_pct': 1.0 - pos / total if total else 1.0,
            'theme_rank_pos': pos + 1,
        }

for i, d in enumerate(days):
    look10 = days[max(0, i - 9):i + 1]
    look20 = days[max(0, i - 19):i + 1]
    d5 = days[max(0, i - 5)]
    d10 = days[max(0, i - 10)]
    for c, (name, by) in U.items():
        if d not in by:
            continue
        r = by[d]
        fam = family(name)
        rank_now = rank_stats.get((d, c), {})
        rank_5 = rank_stats.get((d5, c), {})
        rank_10 = rank_stats.get((d10, c), {})
        prev5 = by.get(d5, r)
        prev10 = by.get(d10, r)
        theme_rank_now = theme_rank_stats.get((d, fam), {})
        theme_rank_5 = theme_rank_stats.get((d5, fam), {})
        tq_pct = rank_now.get('mom30_trend_quality_smooth_rank_pct', 0.0)
        mom_pct = rank_now.get('mom30_rank_pct', 0.0)
        width_pct = rank_now.get('theme_width_rank_pct', 0.0)
        theme_pct = theme_rank_now.get('theme_rank_pct', 0.0)
        tq_jump5 = tq_pct - rank_5.get('mom30_trend_quality_smooth_rank_pct', tq_pct)
        tq_jump10 = tq_pct - rank_10.get('mom30_trend_quality_smooth_rank_pct', tq_pct)
        theme_jump5 = theme_pct - theme_rank_5.get('theme_rank_pct', theme_pct)
        trend_top10 = sum(1 for x in look10 if c in top_sets['mom30_trend_quality_smooth'].get(x, set())) / len(look10)
        trend_top20 = sum(1 for x in look20 if c in top_sets['mom30_trend_quality_smooth'].get(x, set())) / len(look20)
        mom_top20 = sum(1 for x in look20 if c in top_sets['mom30'].get(x, set())) / len(look20)
        width_top20 = sum(1 for x in look20 if c in top_sets['theme_width'].get(x, set())) / len(look20)
        theme_top20 = sum(1 for x in look20 if fam in theme_top_sets.get(x, set())) / len(look20)
        theme_width_accel5 = r.get('theme_width', 0.0) - prev5.get('theme_width', r.get('theme_width', 0.0))
        theme_width_accel10 = r.get('theme_width', 0.0) - prev10.get('theme_width', r.get('theme_width', 0.0))
        theme_power_accel5 = r.get('theme_power', 0.0) - prev5.get('theme_power', r.get('theme_power', 0.0))
        theme_amount_accel5 = r.get('theme_avg_amount_ratio20', 1.0) - prev5.get('theme_avg_amount_ratio20', r.get('theme_avg_amount_ratio20', 1.0))
        r['tq_rank_pct'] = tq_pct
        r['mom_rank_pct'] = mom_pct
        r['width_rank_pct'] = width_pct
        r['theme_rank_pct'] = theme_pct
        r['tq_rank_jump5'] = tq_jump5
        r['tq_rank_jump10'] = tq_jump10
        r['theme_rank_jump5'] = theme_jump5
        r['theme_width_accel5'] = theme_width_accel5
        r['theme_width_accel10'] = theme_width_accel10
        r['theme_power_accel5'] = theme_power_accel5
        r['theme_amount_accel5'] = theme_amount_accel5
        r['cross_rank_blend'] = 0.50 * tq_pct + 0.25 * mom_pct + 0.15 * width_pct + 0.10 * theme_pct
        r['rank_surge_score'] = (
            r['mom30_trend_quality_smooth']
            + 0.25 * max(0.0, tq_jump5)
            + 0.12 * max(0.0, theme_jump5)
            - 0.10 * max(0.0, -tq_jump5)
        )
        r['rank_quality_score'] = (
            0.70 * r['mom30_trend_quality_smooth']
            + 0.25 * tq_pct
            + 0.10 * theme_pct
            - 0.08 * max(0.0, r['atr_pct'] - 0.04)
        )
        r['early_rank_confirm_score'] = (
            0.55 * r['mom30_trend_quality_smooth']
            + 0.20 * max(0.0, tq_jump10)
            + 0.15 * max(0.0, r['breakout60'])
            + 0.10 * width_pct
        )
        r['rank_ensemble_score'] = (
            0.45 * r['mom30_trend_quality_smooth']
            + 0.20 * r['gap_momentum_score']
            + 0.15 * r['pvt_confirm_score']
            + 0.10 * tq_pct
            + 0.05 * theme_pct
            + 0.05 * max(0.0, r['alpha30'])
        )
        r['theme_breadth_accel_score'] = (
            r['mom30_trend_quality_smooth']
            + 0.16 * max(0.0, theme_width_accel5)
            + 0.10 * max(0.0, theme_width_accel10)
            + 0.08 * max(0.0, theme_jump5)
        )
        r['theme_money_rotation_score'] = (
            r['mom30_trend_quality_smooth']
            + 0.12 * r.get('theme_breadth_amount_confirm', 0.0)
            + 0.08 * max(0.0, theme_amount_accel5)
            + 0.06 * max(0.0, r.get('amount_price_dist20', 0.0))
        )
        r['mainline_expansion_score'] = (
            0.58 * r['mom30_trend_quality_smooth']
            + 0.18 * r.get('theme_width', 0.0)
            + 0.10 * max(0.0, theme_width_accel5)
            + 0.08 * r.get('theme_breadth_amount_confirm', 0.0)
            + 0.06 * tq_pct
        )
        r['trend_top10_persist'] = trend_top10
        r['trend_top20_persist'] = trend_top20
        r['mom_top20_persist'] = mom_top20
        r['width_top20_persist'] = width_top20
        r['theme_top20_persist'] = theme_top20
        r['mainline_persist_score'] = (
            r['mom30_trend_quality_smooth']
            + 0.18 * trend_top20
            + 0.12 * theme_top20
            - 0.08 * max(0.0, r['atr_pct'] - 0.04)
        )
        r['mainline_continuity_score'] = (
            0.55 * r['mom30_trend_quality_smooth']
            + 0.25 * trend_top10
            + 0.15 * width_top20
            + 0.05 * theme_top20
        )
        r['theme_continuity_score'] = (
            r['mom30']
            + 0.25 * theme_top20
            + 0.15 * width_top20
            + 0.10 * r['theme_breadth_breakout60']
        )
        r['fresh_mainline_score'] = (
            r['mom30_trend_quality_smooth']
            + 0.18 * trend_top10
            - 0.12 * trend_top20
            + 0.08 * max(0.0, r['breakout60'])
        )


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


def rank_list(d, score_key, abs_key=None, threshold=0.0):
    ranked = []
    for c, (_, by) in U.items():
        if d not in by:
            continue
        r = by[d]
        if r[score_key] > threshold and (not abs_key or r[abs_key]):
            ranked.append((r[score_key], c))
    ranked.sort(reverse=True)
    return ranked


def runner_exit_reason(c, d, p, rank_pos, cfg):
    r = U[c][1][d]
    p['peak'] = max(p.get('peak', p['e']), r['h'])
    peak_ret = p['peak'] / p['e'] - 1
    drawdown = r['c'] / p['peak'] - 1

    if peak_ret >= cfg['protect_gain'] and drawdown <= -cfg['protect_dd']:
        return f'盈利保护{cfg["protect_gain"]:.0%}/{cfg["protect_dd"]:.0%}'
    if r['c'] < r[cfg['trend_ma']] and drawdown <= -cfg['trend_dd']:
        return f'趋势破位{cfg["trend_ma"]}'
    if rank_pos > cfg['weak_rank'] and r['c'] < r[cfg['weak_ma']]:
        return f'弱势跌出Top{cfg["weak_rank"]}'
    return None


def run_runner(label, score_key='mom90', abs_key=None, rebalance=5, threshold=0.0,
               family_cap=True, start=None, end=None, log=False, px='close',
               cost_bps=0.0, cfg=None, group_fn=family, group_mode='family'):
    cfg = cfg or {
        'protect_gain': 0.30,
        'protect_dd': 0.18,
        'trend_ma': 'ma60',
        'trend_dd': 0.12,
        'weak_rank': 9,
        'weak_ma': 'ma60',
        'switch': 0.06,
        'min_hold': 10,
    }
    cash = 1.0
    pos = {}
    eqmax = 0.0
    mdd = 0.0
    trades = 0
    switches = 0
    maxheld = 0
    held_sum = 0
    underinvested_days = 0
    curve = []
    rec = []
    active_days = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    day_index = {d: i for i, d in enumerate(active_days)}
    cost = cost_bps / 10000.0

    def trade_price(c, d):
        r = U[c][1][d]
        return r['nopen'] if px == 'nextopen' else r['c']

    def equity(d):
        return cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def close_position(c, d, reason):
        nonlocal cash, trades
        p = pos[c]
        sell_px = trade_price(c, d)
        cash += p['a'] * (sell_px / p['e']) * (1 - cost)
        if log:
            rec.append({
                'entry': p['ed'], 'exit': d, 'code': c, 'name': U[c][0],
                'entryScore': p['score'], 'entryMom90': p.get('mom90'),
                'entryAbove60': p.get('above60'), 'entryAbove120': p.get('above120'),
                'entryClose': p['e'], 'exitClose': sell_px,
                'pnl': (sell_px / p['e'] * (1 - cost) * (1 - cost) - 1) * 100,
                'contrib': p['gross'] * (sell_px / p['e'] * (1 - cost) * (1 - cost) - 1),
                'reason': reason,
            })
        del pos[c]
        trades += 1

    def family_ok(c, replace=None):
        if not family_cap:
            return True
        fam = group_fn(U[c][0])
        return all(group_fn(U[h][0]) != fam for h in pos if h != replace)

    def open_position(c, d, amount):
        nonlocal cash, trades
        if amount <= 1e-6 or c not in U or d not in U[c][1]:
            return False
        r = U[c][1][d]
        cash -= amount
        pos[c] = {
            'a': amount * (1 - cost), 'gross': amount, 'e': trade_price(c, d),
            'ed': d, 'di': day_index[d], 'peak': r['h'],
            'score': r[score_key], 'mom90': r.get('mom90'),
            'above60': r['above60'], 'above120': r['above120'],
        }
        trades += 1
        return True

    for idx, d in enumerate(active_days):
        ranked = rank_list(d, score_key, abs_key, threshold)
        rank_pos = {c: i + 1 for i, (_, c) in enumerate(ranked)}
        blocked = set()
        blocked_families = set()
        for c in list(pos):
            if d not in U[c][1]:
                continue
            reason = runner_exit_reason(c, d, pos[c], rank_pos.get(c, 999), cfg)
            if reason:
                close_position(c, d, reason)
                blocked.add(c)
                blocked_families.add(group_fn(U[c][0]))

        if idx % rebalance == 0:
            candidates = [c for _, c in ranked if c not in pos and c not in blocked and group_fn(U[c][0]) not in blocked_families and family_ok(c)]
            if len(pos) >= 3 and candidates:
                held_scores = sorted((U[c][1][d][score_key], c) for c in pos if d in U[c][1])
                if held_scores:
                    weakest_score, weakest = held_scores[0]
                    best_new = candidates[0]
                    best_score = U[best_new][1][d][score_key]
                    held_long_enough = idx - pos[weakest]['di'] >= cfg['min_hold']
                    weak_ranked_out = rank_pos.get(weakest, 999) > cfg['weak_rank']
                    trend_bad = U[weakest][1][d]['c'] < U[weakest][1][d][cfg['weak_ma']]
                    if held_long_enough and weak_ranked_out and trend_bad and best_score > weakest_score + cfg['switch'] and family_ok(best_new, weakest):
                        slot_value = pos[weakest]['a'] * (trade_price(weakest, d) / pos[weakest]['e']) * (1 - cost)
                        close_position(weakest, d, '弱者替换->' + U[best_new][0])
                        open_position(best_new, d, min(slot_value, cash))
                        switches += 1

            candidates = [c for _, c in ranked if c not in pos and c not in blocked and group_fn(U[c][0]) not in blocked_families and family_ok(c)]
            for c in candidates:
                if len(pos) >= 3:
                    break
                if not family_ok(c):
                    continue
                amount = min(equity(d) / 3, cash)
                if not open_position(c, d, amount):
                    break

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
    flat_ret = flat_return(curve)
    if log and active_days:
        last = active_days[-1]
        for c, p in pos.items():
            if last in U[c][1]:
                r = U[c][1][last]
                rec.append({
                    'entry': p['ed'], 'exit': last, 'code': c, 'name': U[c][0],
                    'entryScore': p['score'], 'entryMom90': p.get('mom90'),
                    'entryAbove60': p.get('above60'), 'entryAbove120': p.get('above120'),
                    'entryClose': p['e'], 'exitClose': r['c'],
                    'pnl': (r['c'] / p['e'] - 1) * 100,
                    'contrib': p['gross'] * (r['c'] / p['e'] * (1 - cost) - 1),
                    'reason': '持有中',
                })
    avgheld = held_sum / len(active_days) if active_days else 0
    return {
        'kind': 'runner', 'label': label, 'score': score_key, 'abs': abs_key, 'rebalance': rebalance, 'cfg': cfg, 'px': px,
        'flat_ret': flat_ret,
        'group_mode': group_mode,
        'cost_bps': cost_bps, 'ret': (fin - 1) * 100, 'ann': ann, 'mdd': mdd,
        'trades': trades, 'switches': switches, 'maxheld': maxheld, 'avgheld': avgheld,
        'underinvested_days': underinvested_days, 'records': rec,
    }


def run_weighted_rotation(label, score_key='mom90', abs_key=None, rebalance=5, threshold=0.0,
                          weights=(0.5, 0.3, 0.2), family_cap=True, start=None, end=None,
                          log=False, px='close', cost_bps=0.0, exit_rule='rank',
                          reset_weights=True):
    cash = 1.0
    pos = {}
    eqmax = 0.0
    mdd = 0.0
    trades = 0
    maxheld = 0
    held_sum = 0
    underinvested_days = 0
    rec = []
    curve = []
    active_days = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    cost = cost_bps / 10000.0

    def trade_price(c, d):
        r = U[c][1][d]
        return r['nopen'] if px == 'nextopen' else r['c']

    def equity(d):
        return cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def close_position(c, d, reason):
        nonlocal cash, trades
        p = pos[c]
        sell_px = trade_price(c, d)
        cash += p['a'] * (sell_px / p['e']) * (1 - cost)
        if log:
            rec.append({
                'entry': p['ed'], 'exit': d, 'code': c, 'name': U[c][0],
                'entryScore': p['score'], 'entryMom90': p.get('mom90'),
                'entryAbove60': p.get('above60'), 'entryAbove120': p.get('above120'),
                'entryClose': p['e'], 'exitClose': sell_px,
                'pnl': (sell_px / p['e'] * (1 - cost) * (1 - cost) - 1) * 100,
                'contrib': p['gross'] * (sell_px / p['e'] * (1 - cost) * (1 - cost) - 1),
                'reason': reason,
            })
        del pos[c]
        trades += 1

    def top_codes(d):
        keep = []
        used = set()
        limit = len(weights)
        for _, c in rank_list(d, score_key, abs_key, threshold):
            fam = family(U[c][0])
            if family_cap and fam in used:
                continue
            keep.append(c)
            used.add(fam)
            if len(keep) >= limit:
                break
        return keep

    for idx, d in enumerate(active_days):
        if idx % rebalance == 0:
            keep = top_codes(d)
            for c in list(pos):
                if c not in keep:
                    close_position(c, d, f'跌出加权Top{len(weights)}')
                elif exit_rule == 'ma120' and U[c][1][d]['c'] < U[c][1][d]['ma120']:
                    close_position(c, d, '跌破MA120')
                elif exit_rule == 'ma60trail12':
                    p = pos[c]
                    r = U[c][1][d]
                    p['peak'] = max(p.get('peak', p['e']), r['h'])
                    if r['c'] < r['ma60'] and r['c'] <= p['peak'] * 0.88:
                        close_position(c, d, 'MA60且回撤12%')

            eq = equity(d)
            target = {c: eq * weights[i] for i, c in enumerate(keep)}
            if reset_weights:
                # 每周按固定排名权重重置，属于通用组合构造，不按标的定制。
                for c in list(pos):
                    if c in target:
                        close_position(c, d, '权重重置')
            for c in keep:
                if c in pos:
                    continue
                amount = min(target[c], cash)
                if amount <= 1e-6:
                    continue
                r = U[c][1][d]
                cash -= amount
                pos[c] = {
                    'a': amount * (1 - cost), 'gross': amount, 'e': trade_price(c, d),
                    'ed': d, 'peak': r['h'], 'score': r[score_key],
                    'mom90': r.get('mom90'), 'above60': r['above60'], 'above120': r['above120'],
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
    flat_ret = flat_return(curve)
    if log and active_days:
        last = active_days[-1]
        for c, p in pos.items():
            if last in U[c][1]:
                r = U[c][1][last]
                rec.append({
                    'entry': p['ed'], 'exit': last, 'code': c, 'name': U[c][0],
                    'entryScore': p['score'], 'entryMom90': p.get('mom90'),
                    'entryAbove60': p.get('above60'), 'entryAbove120': p.get('above120'),
                    'entryClose': p['e'], 'exitClose': r['c'],
                    'pnl': (r['c'] / p['e'] - 1) * 100,
                    'contrib': p['gross'] * (r['c'] / p['e'] * (1 - cost) - 1),
                    'reason': '持有中',
                })
    avgheld = held_sum / len(active_days) if active_days else 0
    return {
        'kind': 'weighted', 'label': label, 'score': score_key, 'abs': abs_key, 'weights': weights,
        'flat_ret': flat_ret,
        'rebalance': rebalance, 'exit_rule': exit_rule, 'px': px, 'cost_bps': cost_bps,
        'reset_weights': reset_weights,
        'ret': (fin - 1) * 100, 'ann': ann, 'mdd': mdd, 'trades': trades,
        'switches': 0, 'maxheld': maxheld, 'avgheld': avgheld,
        'underinvested_days': underinvested_days, 'records': rec,
    }


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
    flat_ret = flat_return(curve)
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
        'flat_ret': flat_ret,
        'cost_bps': cost_bps, 'ret': (fin - 1) * 100,
        'ann': ann, 'mdd': mdd, 'trades': trades, 'maxheld': maxheld, 'avgheld': avgheld,
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


BASELINE_RET = 468.3
EARLY_BASELINE_RET = 420.1
WATCH_CODES = ('159567', '513120', '515880', '159695', '513310', '588200', '159516', '501225', '159206')


def ranked_mainlines(d, score_key, entry_mom30, entry_mom60, require_above120=True):
    ranked = []
    for c, (_, by) in U.items():
        if d not in by:
            continue
        r = by[d]
        if require_above120 and not r['above120']:
            continue
        if r['mom30'] < entry_mom30 or r['mom60'] < entry_mom60:
            continue
        if r['c'] < r['ma20'] or r['c'] < r['ma60']:
            continue
        ranked.append((r[score_key], c))
    ranked.sort(reverse=True)
    return ranked


def run_capture(label, score_key='mainline_core', rebalance=3, weights=(0.50, 0.30, 0.20),
                entry_mom30=0.08, entry_mom60=0.10, keep_rank=10, exit_ma='ma60',
                trail=0.18, require_above120=True, family_cap=True,
                start=None, end=None, log=False, px='close', cost_bps=0.0):
    active_days = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    cash = 1.0
    pos = {}
    rec = []
    curve = []
    eqmax = 0.0
    mdd = 0.0
    trades = 0
    maxheld = 0
    held_sum = 0
    underinvested_days = 0
    cost = cost_bps / 10000.0

    def trade_price(c, d):
        r = U[c][1][d]
        return r['nopen'] if px == 'nextopen' else r['c']

    def equity(d):
        return cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def close_position(c, d, reason):
        nonlocal cash, trades
        p = pos[c]
        sell_px = trade_price(c, d)
        cash += p['a'] * (sell_px / p['e']) * (1 - cost)
        if log:
            rec.append({
                'entry': p['ed'], 'exit': d, 'code': c, 'name': U[c][0],
                'entryScore': p['score'], 'entryMom90': p.get('mom90'),
                'entryAbove60': p.get('above60'), 'entryAbove120': p.get('above120'),
                'entryClose': p['e'], 'exitClose': sell_px,
                'pnl': (sell_px / p['e'] * (1 - cost) * (1 - cost) - 1) * 100,
                'contrib': p['gross'] * (sell_px / p['e'] * (1 - cost) * (1 - cost) - 1),
                'reason': reason,
            })
        del pos[c]
        trades += 1

    def open_position(c, d, amount):
        nonlocal cash, trades
        if amount <= 1e-6 or c not in U or d not in U[c][1]:
            return False
        r = U[c][1][d]
        px0 = trade_price(c, d)
        cash -= amount
        pos[c] = {
            'a': amount * (1 - cost), 'gross': amount, 'e': px0, 'ed': d,
            'peak': r['h'], 'score': r[score_key], 'mom90': r.get('mom90'),
            'above60': r['above60'], 'above120': r['above120'],
        }
        trades += 1
        return True

    for idx, d in enumerate(active_days):
        ranked = ranked_mainlines(d, score_key, entry_mom30, entry_mom60, require_above120)
        rank_pos = {c: i + 1 for i, (_, c) in enumerate(ranked)}
        for c in list(pos):
            if d not in U[c][1]:
                continue
            r = U[c][1][d]
            p = pos[c]
            p['peak'] = max(p['peak'], r['h'])
            drawdown = r['c'] / p['peak'] - 1
            if r['c'] < r[exit_ma] and drawdown <= -trail:
                close_position(c, d, f'跌破{exit_ma}且回撤{trail:.0%}')
            elif r['mom30'] < 0 and r['c'] < r['ma20']:
                close_position(c, d, '30日动量转负且破MA20')
            elif rank_pos.get(c, 999) > keep_rank and r['c'] < r['ma60']:
                close_position(c, d, f'跌出Top{keep_rank}且破MA60')

        if idx % rebalance == 0:
            used = {family(U[c][0]) for c in pos} if family_cap else set()
            for _, c in ranked:
                if len(pos) >= len(weights):
                    break
                if c in pos:
                    continue
                fam = family(U[c][0])
                if family_cap and fam in used:
                    continue
                slot = len(pos)
                eq = equity(d)
                amount = min(eq * weights[slot], cash)
                if open_position(c, d, amount):
                    used.add(fam)

        e = equity(d)
        curve.append(e)
        eqmax = max(eqmax, e)
        mdd = min(mdd, (e / eqmax - 1) * 100)
        maxheld = max(maxheld, len(pos))
        held_sum += len(pos)
        if len(pos) < len(weights):
            underinvested_days += 1

    fin = curve[-1]
    ann = (fin ** (1 / (len(active_days) / 244)) - 1) * 100
    flat_ret = flat_return(curve)
    if log and active_days:
        last = active_days[-1]
        for c, p in pos.items():
            if last in U[c][1]:
                r = U[c][1][last]
                rec.append({
                    'entry': p['ed'], 'exit': last, 'code': c, 'name': U[c][0],
                    'entryScore': p['score'], 'entryMom90': p.get('mom90'),
                    'entryAbove60': p.get('above60'), 'entryAbove120': p.get('above120'),
                    'entryClose': p['e'], 'exitClose': r['c'],
                    'pnl': (r['c'] / p['e'] - 1) * 100,
                    'contrib': p['gross'] * (r['c'] / p['e'] * (1 - cost) - 1),
                    'reason': '持有中',
                })
    return {
        'label': label, 'score': score_key, 'rebalance': rebalance, 'weights': weights,
        'entry_mom30': entry_mom30, 'entry_mom60': entry_mom60, 'keep_rank': keep_rank,
        'exit_ma': exit_ma, 'trail': trail, 'px': px, 'cost_bps': cost_bps,
        'flat_ret': flat_ret,
        'ret': (fin - 1) * 100, 'ann': ann, 'mdd': mdd, 'trades': trades,
        'maxheld': maxheld, 'avgheld': held_sum / len(active_days) if active_days else 0,
        'underinvested_days': underinvested_days, 'records': rec,
    }


def run_breakout_hold(label, breakout_key='hi60prev', rebalance=3, weights=(1.0,),
                      entry_mom30=0.08, entry_mom60=0.10, exit_rule='low20',
                      family_cap=True, start=None, end=None, log=False, px='close', cost_bps=0.0):
    active_days = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    cash = 1.0
    pos = {}
    rec = []
    curve = []
    eqmax = 0.0
    mdd = 0.0
    trades = 0
    maxheld = 0
    held_sum = 0
    underinvested_days = 0
    cost = cost_bps / 10000.0

    def trade_price(c, d):
        r = U[c][1][d]
        return r['nopen'] if px == 'nextopen' else r['c']

    def equity(d):
        return cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def close_position(c, d, reason):
        nonlocal cash, trades
        p = pos[c]
        sell_px = trade_price(c, d)
        cash += p['a'] * (sell_px / p['e']) * (1 - cost)
        if log:
            rec.append({
                'entry': p['ed'], 'exit': d, 'code': c, 'name': U[c][0],
                'entryScore': p['score'], 'entryMom90': p.get('mom90'),
                'entryAbove60': p.get('above60'), 'entryAbove120': p.get('above120'),
                'entryClose': p['e'], 'exitClose': sell_px,
                'pnl': (sell_px / p['e'] * (1 - cost) * (1 - cost) - 1) * 100,
                'contrib': p['gross'] * (sell_px / p['e'] * (1 - cost) * (1 - cost) - 1),
                'reason': reason,
            })
        del pos[c]
        trades += 1

    def candidates(d):
        out = []
        for c, (_, by) in U.items():
            if d not in by or c in pos:
                continue
            r = by[d]
            if not (r['above120'] and r['c'] > r['ma20'] and r['c'] > r['ma60']):
                continue
            if r['mom30'] < entry_mom30 or r['mom60'] < entry_mom60:
                continue
            if r['c'] <= r[breakout_key]:
                continue
            score = r['mainline_core'] + 0.5 * (r['c'] / r[breakout_key] - 1)
            out.append((score, c))
        out.sort(reverse=True)
        return out

    def open_position(c, d, amount):
        nonlocal cash, trades
        if amount <= 1e-6:
            return False
        r = U[c][1][d]
        cash -= amount
        pos[c] = {
            'a': amount * (1 - cost), 'gross': amount, 'e': trade_price(c, d),
            'ed': d, 'peak': r['h'], 'score': r['mainline_core'], 'mom90': r.get('mom90'),
            'above60': r['above60'], 'above120': r['above120'],
        }
        trades += 1
        return True

    for idx, d in enumerate(active_days):
        for c in list(pos):
            if d not in U[c][1]:
                continue
            r = U[c][1][d]
            if exit_rule == 'low20' and r['c'] < r['low20prev']:
                close_position(c, d, '跌破20日低点')
            elif exit_rule == 'low10' and r['c'] < r['low10prev']:
                close_position(c, d, '跌破10日低点')
            elif exit_rule == 'ma60' and r['c'] < r['ma60']:
                close_position(c, d, '跌破MA60')

        if idx % rebalance == 0:
            used = {family(U[c][0]) for c in pos} if family_cap else set()
            for _, c in candidates(d):
                if len(pos) >= len(weights):
                    break
                fam = family(U[c][0])
                if family_cap and fam in used:
                    continue
                eq = equity(d)
                amount = min(eq * weights[len(pos)], cash)
                if open_position(c, d, amount):
                    used.add(fam)

        e = equity(d)
        curve.append(e)
        eqmax = max(eqmax, e)
        mdd = min(mdd, (e / eqmax - 1) * 100)
        maxheld = max(maxheld, len(pos))
        held_sum += len(pos)
        if len(pos) < len(weights):
            underinvested_days += 1

    fin = curve[-1]
    ann = (fin ** (1 / (len(active_days) / 244)) - 1) * 100
    flat_ret = flat_return(curve)
    if log and active_days:
        last = active_days[-1]
        for c, p in pos.items():
            if last in U[c][1]:
                r = U[c][1][last]
                rec.append({
                    'entry': p['ed'], 'exit': last, 'code': c, 'name': U[c][0],
                    'entryScore': p['score'], 'entryMom90': p.get('mom90'),
                    'entryAbove60': p.get('above60'), 'entryAbove120': p.get('above120'),
                    'entryClose': p['e'], 'exitClose': r['c'],
                    'pnl': (r['c'] / p['e'] - 1) * 100,
                    'contrib': p['gross'] * (r['c'] / p['e'] * (1 - cost) - 1),
                    'reason': '持有中',
                })
    return {
        'kind': 'breakout', 'label': label, 'breakout_key': breakout_key, 'rebalance': rebalance,
        'flat_ret': flat_ret,
        'weights': weights, 'entry_mom30': entry_mom30, 'entry_mom60': entry_mom60,
        'exit_rule': exit_rule, 'px': px, 'cost_bps': cost_bps,
        'ret': (fin - 1) * 100, 'ann': ann, 'mdd': mdd, 'trades': trades,
        'maxheld': maxheld, 'avgheld': held_sum / len(active_days) if active_days else 0,
        'underinvested_days': underinvested_days, 'records': rec,
    }


tests = []
FACTOR_KEYS = (
    'mom20', 'mom30', 'mom40', 'mom60', 'mom90', 'mom120',
    'rs20', 'rs30', 'rs60', 'rs90', 'rs120',
    'combo90', 'combo60_90', 'rs_accel',
    'rs30_trend_quality', 'rs60_trend_quality',
    'mom_rs30_blend', 'mom_rs60_blend', 'mom_rs_quality',
    'up_ratio30', 'up_ratio60', 'efficiency30', 'efficiency60',
    'sharpe30', 'sharpe60', 'sortino30', 'sortino60',
    'path_mdd30', 'path_mdd60', 'smooth_mom30', 'smooth_mom60',
    'drawdown_adjusted_mom30', 'drawdown_adjusted_mom60', 'path_quality_score',
    'ulcer30', 'ulcer60', 'skew30', 'skew60', 'tail_loss30', 'tail_loss60',
    'calmar30', 'calmar60', 'ulcer_adjusted_mom30', 'tail_risk_adjusted_mom30',
    'calmar_mom30', 'downside_control_score', 'drawdown_repair_score',
    'atr_ratio20_60', 'range_contract', 'intraday_range_pct',
    'close_location', 'body_pct', 'upper_shadow_pct', 'lower_shadow_pct', 'gap_pct',
    'candle_strength_score', 'squeeze_breakout_score', 'vcp_breakout_score', 'gap_momentum_score',
    'beta30', 'beta60', 'corr30', 'corr60',
    'alpha30', 'alpha60', 'alpha90', 'residual_mom30', 'residual_mom60',
    'alpha_trend_quality', 'independent_trend_score', 'low_beta_alpha_score',
    'abs13612', 'abs_mom_blend', 'abs_accel',
    'breakout20', 'breakout60', 'breakout120',
    'early_breakout', 'early_accel', 'early_trend',
    'sprint25_35', 'sprint30_45', 'sprint_accel',
    'mainline_core', 'mainline_early', 'mainline_persist',
    'benchmark_risk_on', 'benchmark_risk_off',
    'confirm_stack_score', 'ensemble_core_score', 'ensemble_risk_adjusted_score',
    'regime_trend_score', 'mainline_quality_score',
    'slope20_60', 'dist_ma20', 'dist_ma60', 'dist_ma120', 'ma_stack',
    'pos60', 'pos120', 'trend_quality', 'breakout_quality',
    'vol_ratio20', 'vol_ratio60', 'vol_dryup', 'turnover_proxy',
    'amount_ratio5', 'amount_ratio20', 'amount_ratio60', 'amount_trend',
    'amount_price_dist20', 'amount_price_dist60',
    'amount_confirm', 'amount_proxy', 'amount_breakout', 'price_amount_power',
    'amount_dryup_pullback', 'mom30_amount_blend', 'mom30_breakout_amount',
    'amount_cost_reclaim_score', 'volume_price_absorption_score',
    'mom20_trend_quality', 'mom30_trend_quality', 'mom40_trend_quality',
    'mom30_trend_quality_fast', 'mom30_trend_quality_smooth',
    'mom30_trend_quality_lightvol', 'mom30_trend_quality_heavyvol',
    'term_structure_slope', 'term_structure_curve', 'multi_period_consistency',
    'multi_mom_blend', 'multi_mom_quality_score', 'short_over_mid_heat',
    'balanced_momentum_score', 'acceleration_curve_score', 'barbell_momentum_score',
    'inv_atr', 'inv_vol20', 'quiet_trend',
    'rsi14', 'stoch_k14', 'kdj_k', 'willr14',
    'boll_pctb', 'boll_width_pct', 'boll_squeeze',
    'macd_hist', 'macd_norm', 'macd_trend_score',
    'plus_di20', 'minus_di20', 'dmi_spread20', 'adx20',
    'dmi_trend_score', 'adx_breakout_score',
    'obv_slope20', 'amount_obv_slope20', 'pvt_slope20',
    'obv_confirm_score', 'pvt_confirm_score',
    'mfi14', 'mfi_trend_score', 'cci20', 'cci_norm',
    'swing_strength_score', 'oversold_rebound_score',
    'high_reclaim60', 'dd_from_high60', 'recovery_from_low60',
    'channel_width60', 'reg_slope30', 'reg_slope60', 'reg_r2_30', 'reg_r2_60',
    'regression_trend_score', 'regression_mainline_score',
    'aroon_up25', 'aroon_down25', 'aroon_osc25', 'aroon_trend_score',
    'uptrend_pullback_score', 'ma_pullback_reclaim_score',
    'volatility_expansion_score', 'volatility_regime_shift_score',
    'streak_above20', 'streak_above60', 'streak_up',
    'new_high_rate20', 'new_high_rate60', 'mom30_z',
    'trend_age_score', 'new_high_persistence_score',
    'normalized_momentum_score', 'anti_exhaustion_score', 'mature_trend_score',
    'recovery_breakout_score',
    'ma_ribbon_width', 'ma_ribbon_score',
    'theme_avg_mom30', 'theme_avg_mom60', 'theme_best_mom30',
    'theme_breadth_above60', 'theme_breadth_above120', 'theme_breadth_mom30',
    'theme_breadth_breakout60', 'theme_avg_vol_ratio20',
    'theme_avg_amount_ratio20', 'theme_avg_amount_trend', 'theme_breadth_amount_confirm',
    'theme_width', 'theme_power', 'theme_leader', 'theme_amount_power',
    'mom30_width_blend', 'mom30_theme_power', 'mom30_theme_leader', 'mom30_theme_amount', 'mom30_width_stable',
    'trend_top10_persist', 'trend_top20_persist', 'mom_top20_persist',
    'width_top20_persist', 'theme_top20_persist',
    'mainline_persist_score', 'mainline_continuity_score',
    'theme_continuity_score', 'fresh_mainline_score',
    'tq_rank_pct', 'mom_rank_pct', 'width_rank_pct', 'theme_rank_pct',
    'tq_rank_jump5', 'tq_rank_jump10', 'theme_rank_jump5',
    'theme_width_accel5', 'theme_width_accel10', 'theme_power_accel5', 'theme_amount_accel5',
    'cross_rank_blend', 'rank_surge_score', 'rank_quality_score',
    'early_rank_confirm_score', 'rank_ensemble_score',
    'theme_breadth_accel_score', 'theme_money_rotation_score', 'mainline_expansion_score',
)

for score_key in FACTOR_KEYS:
    for rebalance in (3, 5, 10):
        for weights in ((1.0,), (0.90, 0.10), (0.85, 0.10, 0.05), (0.70, 0.20, 0.10)):
            for abs_key in ('above60', 'above120'):
                label = f'factor|{score_key}|{abs_key}|{rebalance}d|{"/".join(f"{w:.0%}" for w in weights)}'
                tests.append(run_weighted_rotation(label, score_key, abs_key, rebalance, 0.0, weights, True, exit_rule='ma120', reset_weights=False))

for breakout_key in ('hi20prev', 'hi60prev', 'hi120prev'):
    for rebalance in (1, 3, 5):
        for weights in ((1.0,), (0.85, 0.10, 0.05), (0.70, 0.20, 0.10)):
            for entry_mom30, entry_mom60 in ((0.04, 0.06), (0.06, 0.08), (0.08, 0.10)):
                for exit_rule in ('low10', 'low20', 'ma60'):
                    label = f'breakout|{breakout_key}|{rebalance}d|{"/".join(f"{w:.0%}" for w in weights)}|m{entry_mom30:.0%}/{entry_mom60:.0%}|{exit_rule}'
                    tests.append(run_breakout_hold(label, breakout_key, rebalance, weights, entry_mom30, entry_mom60, exit_rule))

RUNNER_CFGS = (
    ('base', {
        'protect_gain': 0.30, 'protect_dd': 0.18,
        'trend_ma': 'ma60', 'trend_dd': 0.12,
        'weak_rank': 9, 'weak_ma': 'ma60',
        'switch': 0.06, 'min_hold': 10,
    }),
    ('loose', {
        'protect_gain': 0.35, 'protect_dd': 0.22,
        'trend_ma': 'ma60', 'trend_dd': 0.15,
        'weak_rank': 12, 'weak_ma': 'ma60',
        'switch': 0.04, 'min_hold': 15,
    }),
    ('tight', {
        'protect_gain': 0.25, 'protect_dd': 0.14,
        'trend_ma': 'ma30', 'trend_dd': 0.10,
        'weak_rank': 7, 'weak_ma': 'ma60',
        'switch': 0.06, 'min_hold': 8,
    }),
)
RUNNER_SCORE_KEYS = (
    'cross_rank_blend', 'mom30_width_stable', 'rank_quality_score',
    'mom_rank_pct', 'tq_rank_pct', 'rank_ensemble_score',
    'mom30_width_blend', 'mom30_theme_leader', 'mom30_theme_power',
    'early_rank_confirm_score', 'mainline_expansion_score',
    'mom30_theme_amount', 'fresh_mainline_score',
    'width_rank_pct', 'theme_rank_pct',
    'mom30_trend_quality_smooth', 'mom30_trend_quality', 'mom30_width_stable',
    'mom30_theme_power', 'theme_width', 'mainline_persist_score',
    'mainline_continuity_score', 'theme_continuity_score',
    'rank_surge_score', 'rank_quality_score', 'early_rank_confirm_score',
    'mom_rs_quality', 'rs30_trend_quality',
    'path_quality_score', 'smooth_mom30',
    'candle_strength_score', 'squeeze_breakout_score', 'vcp_breakout_score', 'gap_momentum_score',
    'amount_cost_reclaim_score', 'volume_price_absorption_score',
    'alpha_trend_quality', 'independent_trend_score',
    'macd_trend_score', 'dmi_trend_score', 'obv_confirm_score',
    'pvt_confirm_score', 'mfi_trend_score', 'recovery_breakout_score',
    'ma_ribbon_score', 'regression_trend_score', 'regression_mainline_score',
    'aroon_trend_score', 'swing_strength_score', 'uptrend_pullback_score',
    'ma_pullback_reclaim_score', 'volatility_expansion_score', 'volatility_regime_shift_score',
    'confirm_stack_score', 'ensemble_core_score',
    'ensemble_risk_adjusted_score', 'regime_trend_score', 'mainline_quality_score',
    'rank_ensemble_score', 'theme_breadth_accel_score', 'theme_money_rotation_score',
    'mainline_expansion_score', 'trend_age_score', 'new_high_persistence_score',
    'normalized_momentum_score', 'anti_exhaustion_score', 'mature_trend_score',
    'downside_control_score', 'drawdown_repair_score',
    'multi_mom_quality_score', 'balanced_momentum_score',
    'acceleration_curve_score', 'barbell_momentum_score',
)
RUNNER_SCORE_KEYS = tuple(dict.fromkeys(RUNNER_SCORE_KEYS))
for score_key in RUNNER_SCORE_KEYS:
    for abs_key in ('above60', 'above120'):
        for rebalance in (3, 5, 10):
            for cfg_name, cfg in RUNNER_CFGS:
                label = f'runner|{score_key}|{abs_key}|{rebalance}d|{cfg_name}'
                tests.append(run_runner(label, score_key, abs_key, rebalance, 0.0, True, cfg=cfg))

BROAD_RUNNER_SCORE_KEYS = (
    'cross_rank_blend', 'mom30_width_stable', 'rank_quality_score',
    'mom30_width_blend', 'mom30_theme_leader', 'mom30_theme_power',
    'mainline_expansion_score', 'fresh_mainline_score',
    'theme_width', 'theme_rank_pct', 'theme_breadth_accel_score',
    'theme_money_rotation_score',
    'multi_mom_quality_score', 'balanced_momentum_score',
    'mom30_trend_quality_smooth', 'mom_rs_quality', 'rank_quality_score',
    'gap_momentum_score', 'anti_exhaustion_score',
    'alpha_trend_quality',
    'pvt_confirm_score', 'ensemble_risk_adjusted_score',
)
BROAD_RUNNER_SCORE_KEYS = tuple(dict.fromkeys(BROAD_RUNNER_SCORE_KEYS))
for score_key in BROAD_RUNNER_SCORE_KEYS:
    for abs_key in ('above60', 'above120'):
        for rebalance in (3, 5, 10):
            for cfg_name, cfg in RUNNER_CFGS:
                label = f'runner-mainline|{score_key}|{abs_key}|{rebalance}d|{cfg_name}'
                tests.append(run_runner(
                    label, score_key, abs_key, rebalance, 0.0, True, cfg=cfg,
                    group_fn=mainline_group, group_mode='mainline',
                ))


def score_result(r):
    return r['ret'] - abs(r['mdd']) * 0.6 - r['trades'] * 0.02


def factor_group(label):
    if label.startswith('runner-mainline|'):
        return '主线大类Runner'
    if label.startswith('runner|'):
        return '多主线Runner'
    if label.startswith('breakout|'):
        return '阶段新高'
    key = label.split('|')[1] if label.startswith('factor|') else label.split('|')[0]
    if key.startswith('rs') or key.startswith('combo') or '_rs' in key:
        return '相对强弱'
    if key.startswith('up_ratio') or key.startswith('efficiency') or key.startswith('sharpe') or key.startswith('sortino') or key.startswith('path_') or key.startswith('smooth_mom') or key.startswith('drawdown_adjusted'):
        return '路径质量'
    if key in (
        'ulcer30', 'ulcer60', 'skew30', 'skew60', 'tail_loss30', 'tail_loss60',
        'calmar30', 'calmar60', 'ulcer_adjusted_mom30', 'tail_risk_adjusted_mom30',
        'calmar_mom30', 'downside_control_score', 'drawdown_repair_score',
    ):
        return '尾部风险'
    if key in (
        'atr_ratio20_60', 'range_contract', 'intraday_range_pct',
        'close_location', 'body_pct', 'upper_shadow_pct', 'lower_shadow_pct', 'gap_pct',
        'candle_strength_score', 'squeeze_breakout_score', 'vcp_breakout_score', 'gap_momentum_score',
    ):
        return 'K线结构'
    if key.startswith('alpha') or key.startswith('beta') or key.startswith('corr') or key.startswith('residual') or key in ('independent_trend_score', 'low_beta_alpha_score'):
        return '基准残差'
    if key in (
        'benchmark_risk_on', 'benchmark_risk_off',
        'confirm_stack_score', 'ensemble_core_score', 'ensemble_risk_adjusted_score',
        'regime_trend_score', 'mainline_quality_score', 'rank_ensemble_score',
    ):
        return '集成/风控'
    if key in (
        'streak_above20', 'streak_above60', 'streak_up',
        'new_high_rate20', 'new_high_rate60', 'mom30_z',
        'trend_age_score', 'new_high_persistence_score',
        'normalized_momentum_score', 'anti_exhaustion_score', 'mature_trend_score',
    ):
        return '趋势寿命'
    if key.startswith('mom') or key.startswith('sprint') or key in ('abs13612', 'abs_mom_blend', 'abs_accel'):
        if 'width' in key or 'theme' in key or 'trend_quality' in key:
            return '复合主线'
        if 'amount' in key:
            return '量能/流动性'
        return '动量'
    if key in (
        'term_structure_slope', 'term_structure_curve', 'multi_period_consistency',
        'multi_mom_blend', 'multi_mom_quality_score', 'short_over_mid_heat',
        'balanced_momentum_score', 'acceleration_curve_score', 'barbell_momentum_score',
    ):
        return '多周期一致性'
    if 'persist' in key or 'continuity' in key or key == 'fresh_mainline_score':
        return '持续性主线'
    if 'rank_' in key or key in ('cross_rank_blend', 'tq_rank_pct', 'mom_rank_pct', 'width_rank_pct', 'theme_rank_pct'):
        return '横截面排名'
    if key.startswith('theme_'):
        return '主题代理'
    if 'breakout' in key or key in ('pos60', 'pos120', 'breakout_quality'):
        return '突破/位置'
    if key in ('slope20_60', 'dist_ma20', 'dist_ma60', 'dist_ma120', 'ma_stack', 'trend_quality'):
        return '均线/趋势'
    if key in (
        'vol_ratio20', 'vol_ratio60', 'vol_dryup', 'turnover_proxy',
        'amount_ratio5', 'amount_ratio20', 'amount_ratio60', 'amount_trend',
        'amount_price_dist20', 'amount_price_dist60',
        'amount_confirm', 'amount_proxy', 'amount_breakout', 'price_amount_power',
        'amount_dryup_pullback', 'amount_cost_reclaim_score', 'volume_price_absorption_score',
    ):
        return '量能/流动性'
    if key in ('inv_atr', 'inv_vol20', 'quiet_trend'):
        return '波动'
    if key in (
        'rsi14', 'stoch_k14', 'kdj_k', 'willr14',
        'boll_pctb', 'boll_width_pct', 'boll_squeeze',
        'macd_hist', 'macd_norm', 'macd_trend_score',
        'plus_di20', 'minus_di20', 'dmi_spread20', 'adx20',
        'dmi_trend_score', 'adx_breakout_score',
        'obv_slope20', 'amount_obv_slope20', 'pvt_slope20',
        'obv_confirm_score', 'pvt_confirm_score',
        'mfi14', 'mfi_trend_score', 'cci20', 'cci_norm',
        'swing_strength_score', 'oversold_rebound_score',
        'high_reclaim60', 'dd_from_high60', 'recovery_from_low60',
        'channel_width60', 'reg_slope30', 'reg_slope60', 'reg_r2_30', 'reg_r2_60',
        'regression_trend_score', 'regression_mainline_score',
        'aroon_up25', 'aroon_down25', 'aroon_osc25', 'aroon_trend_score',
        'uptrend_pullback_score', 'ma_pullback_reclaim_score',
        'volatility_expansion_score', 'volatility_regime_shift_score',
        'recovery_breakout_score',
        'ma_ribbon_width', 'ma_ribbon_score',
    ):
        return '技术指标'
    if key.startswith('mainline'):
        return '复合主线'
    return '其他'


tests.sort(key=score_result, reverse=True)
best = tests[0]
runner_rows_all = [r for r in tests if r.get('kind') == 'runner' and r.get('group_mode', 'family') == 'family']
mainline_runner_rows_all = [r for r in tests if r.get('kind') == 'runner' and r.get('group_mode') == 'mainline']
best_runner = runner_rows_all[0] if runner_rows_all else None
best_mainline_runner = mainline_runner_rows_all[0] if mainline_runner_rows_all else None


def rerun_like(r, label, start=None, end=None, log=False, px='close', cost_bps=0.0):
    if r.get('kind') == 'weighted':
        return run_weighted_rotation(
            label, r['score'], r['abs'], r.get('rebalance', 5), 0.0, r['weights'], True,
            start, end, log, px, cost_bps, r['exit_rule'], r['reset_weights'],
        )
    if r.get('kind') == 'breakout':
        return run_breakout_hold(
            label, r['breakout_key'], r['rebalance'], r['weights'], r['entry_mom30'],
            r['entry_mom60'], r['exit_rule'], True, start, end, log, px, cost_bps,
        )
    if r.get('kind') == 'runner':
        group_mode = r.get('group_mode', 'family')
        return run_runner(
            label, r['score'], r['abs'], r.get('rebalance', 5), 0.0, True,
            start, end, log, px, cost_bps, r['cfg'],
            mainline_group if group_mode == 'mainline' else family,
            group_mode,
        )
    return run_capture(
        label, r['score'], r['rebalance'], r['weights'], r['entry_mom30'], r['entry_mom60'],
        r['keep_rank'], r['exit_ma'], r['trail'], True, True, start, end, log, px, cost_bps,
    )


robust_ranked = []
for r in tests[:80]:
    rr = rerun_like(r, '鲁棒复核', px='nextopen', cost_bps=10.0)
    robust_ranked.append((rr, r))
robust_ranked.sort(key=lambda item: item[0]['ret'], reverse=True)
best_robust_check, best_robust = robust_ranked[0]


print(f'载入 {len(U)}/{len(POOL)} | 区间 {days[0]}→{days[-1]} | 策略族=指标大扫 | 对比短周期冲刺>{BASELINE_RET:.1f}%')
print('Top20:')
print(f'{"策略":<74}{"收益":>8}{"年化":>7}{"回撤":>7}{"交易":>6}{"均仓":>6}{"空槽日":>7}')
for r in tests[:20]:
    print(f'{r["label"]:<74}{r["ret"]:>7.0f}%{r["ann"]:>6.0f}%{r["mdd"]:>6.0f}%{r["trades"]:>6}{r["avgheld"]:>6.2f}{r["underinvested_days"]:>7}')

checks = [
    rerun_like(best, '全段-候选', log=True),
    rerun_like(best, '2025-候选', '2025-01-01', '2025-12-31'),
    rerun_like(best, '2026-候选', '2026-01-01', '2026-06-26'),
]
sensitivity = [
    rerun_like(best, '候选-收盘-0bp', px='close', cost_bps=0.0),
    rerun_like(best, '候选-次开-0bp', px='nextopen', cost_bps=0.0),
    rerun_like(best, '候选-收盘-5bp', px='close', cost_bps=5.0),
    rerun_like(best, '候选-次开-5bp', px='nextopen', cost_bps=5.0),
    rerun_like(best, '候选-次开-10bp', px='nextopen', cost_bps=10.0),
]

records = write_records(TRADE_LOG, checks[0]['records'])
tq_target = next(
    (
        r for r in tests
        if r.get('kind') == 'weighted'
        and r['label'] == 'factor|mom30_trend_quality_smooth|above60|3d|100%'
    ),
    None,
)
tq_records = write_records(TQ_TRADE_LOG, rerun_like(tq_target, 'tq精确交易', log=True)['records']) if tq_target else []
runner_check = rerun_like(best_runner, 'Runner最佳', log=True) if best_runner else None
runner_records = write_records(RUNNER_TRADE_LOG, runner_check['records']) if runner_check else []
mainline_runner_check = rerun_like(best_mainline_runner, '主线大类Runner最佳', log=True) if best_mainline_runner else None
mainline_runner_records = write_records(RUNNER_MAINLINE_TRADE_LOG, mainline_runner_check['records']) if mainline_runner_check else []
by_family = {}
for r in records:
    fam = family(r['name'])
    cur = by_family.setdefault(fam, {'codes': {}, 'count': 0, 'contrib': 0.0, 'wins': 0})
    cur['codes'][r['code']] = r['name']
    cur['count'] += 1
    cur['contrib'] += r['contrib']
    if r['pnl'] > 0:
        cur['wins'] += 1
top_contrib = sorted(by_family.items(), key=lambda kv: kv[1]['contrib'], reverse=True)

capture_rows = []
for c in WATCH_CODES:
    if c not in U:
        continue
    name = U[c][0]
    hits = [r for r in records if r['code'] == c]
    capture_rows.append((c, name, family(name), len(hits), sum(r['contrib'] for r in hits) * 100))

with open(SUMMARY_LOG, 'w') as f:
    f.write('# ETF 主线指标大扫回测摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}\n')
    f.write(f'- ETF池: {len(U)}/{len(POOL)} 只可用\n')
    f.write(f'- 对比基准: 短周期冲刺 `+{BASELINE_RET:.1f}%`；早期突破 `+{EARLY_BASELINE_RET:.1f}%`\n')
    f.write('- 最大持仓: 3；原 Runner 同细主题最多 1 只；主线大类 Runner 同一大主线最多 1 只。\n')
    f.write(f'- 收盘口径最佳: `{best["label"]}`\n')
    f.write(f'- 次开10bp鲁棒最佳: `{best_robust["label"]}`，收益 `{best_robust_check["ret"]:.1f}%`\n\n')
    if runner_check:
        f.write(f'- 多主线 Runner 最佳: `{best_runner["label"]}`，收益 `{runner_check["ret"]:.1f}%`，最大持仓 `{runner_check["maxheld"]}`，均仓 `{runner_check["avgheld"]:.2f}`，交易记录见 `{os.path.basename(RUNNER_TRADE_LOG)}`。\n\n')
    if mainline_runner_check:
        f.write(f'- 主线大类 Runner 最佳: `{best_mainline_runner["label"]}`，收益 `{mainline_runner_check["ret"]:.1f}%`，最大持仓 `{mainline_runner_check["maxheld"]}`，均仓 `{mainline_runner_check["avgheld"]:.2f}`，交易记录见 `{os.path.basename(RUNNER_MAINLINE_TRADE_LOG)}`。\n\n')
    f.write('## Top20 参数\n\n')
    f.write('| 指标族 | 策略 | 收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 超短周期冲刺 |\n')
    f.write('|---|---|---:|---:|---:|---:|---:|---:|---|\n')
    for r in tests[:20]:
        f.write(f'| {factor_group(r["label"])} | {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {r["underinvested_days"]} | {"是" if r["ret"] > BASELINE_RET else "否"} |\n')
    f.write('\n## 各指标族最佳\n\n')
    f.write('| 指标族 | 策略 | 收益 | 最大回撤 | 交易 | 次开10bp收益 |\n')
    f.write('|---|---|---:|---:|---:|---:|\n')
    seen_groups = set()
    for r in sorted(tests, key=lambda x: x['ret'], reverse=True):
        g = factor_group(r['label'])
        if g in seen_groups:
            continue
        rr = rerun_like(r, '族最佳-次开10bp', px='nextopen', cost_bps=10.0)
        f.write(f'| {g} | {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {rr["ret"]:.1f}% |\n')
        seen_groups.add(g)
    f.write('\n## 本轮新增指标专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    new_keys = (
        'amount_price_dist20', 'amount_price_dist60',
        'amount_cost_reclaim_score', 'volume_price_absorption_score',
        'vcp_breakout_score', 'ma_pullback_reclaim_score',
        'volatility_regime_shift_score',
        'theme_width_accel5', 'theme_width_accel10', 'theme_power_accel5', 'theme_amount_accel5',
        'theme_breadth_accel_score', 'theme_money_rotation_score', 'mainline_expansion_score',
    )
    new_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if any(k in r['label'] for k in new_keys)
    ]
    for r in new_rows[:24]:
        rr = rerun_like(r, '新增指标-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 趋势质量扰动专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---|\n')
    trend_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if 'trend_quality' in r['label']
    ]
    for r in trend_rows[:18]:
        rr = rerun_like(r, '趋势质量-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过旧鲁棒基准' if rr['ret'] > 384.0 else '未超过旧鲁棒基准'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 多周期一致性专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    multi_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if factor_group(r['label']) == '多周期一致性'
    ]
    for r in multi_rows[:18]:
        rr = rerun_like(r, '多周期-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 相对强弱 RS 专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    rs_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if factor_group(r['label']) == '相对强弱'
    ]
    for r in rs_rows[:18]:
        rr = rerun_like(r, 'RS-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 路径质量专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    path_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if factor_group(r['label']) == '路径质量'
    ]
    for r in path_rows[:18]:
        rr = rerun_like(r, '路径质量-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 尾部风险专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    tail_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if factor_group(r['label']) == '尾部风险'
    ]
    for r in tail_rows[:18]:
        rr = rerun_like(r, '尾部风险-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## K线结构专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    candle_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if factor_group(r['label']) == 'K线结构'
    ]
    for r in candle_rows[:18]:
        rr = rerun_like(r, 'K线结构-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 基准残差专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    alpha_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if factor_group(r['label']) == '基准残差'
    ]
    for r in alpha_rows[:18]:
        rr = rerun_like(r, '基准残差-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 技术指标扩展专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    tech_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if factor_group(r['label']) == '技术指标'
    ]
    for r in tech_rows[:24]:
        rr = rerun_like(r, '技术指标-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 集成/风控专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    ensemble_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if factor_group(r['label']) == '集成/风控'
    ]
    for r in ensemble_rows[:24]:
        rr = rerun_like(r, '集成风控-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 趋势寿命专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    age_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if factor_group(r['label']) == '趋势寿命'
    ]
    for r in age_rows[:24]:
        rr = rerun_like(r, '趋势寿命-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 持续性主线专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    persist_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if factor_group(r['label']) == '持续性主线'
    ]
    for r in persist_rows[:18]:
        rr = rerun_like(r, '持续性-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 横截面排名专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    rank_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if factor_group(r['label']) == '横截面排名'
    ]
    for r in rank_rows[:18]:
        rr = rerun_like(r, '横截面-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 多主线 Runner 专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 最大持仓 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---|\n')
    runner_rows = sorted(runner_rows_all, key=lambda x: x['ret'], reverse=True)
    for r in runner_rows[:18]:
        rr = rerun_like(r, 'Runner-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过单仓鲁棒最佳' if rr['ret'] > SINGLE_TREND_ROBUST_RET else '未超过单仓鲁棒最佳'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["maxheld"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 主线大类 Runner 专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 最大持仓 | 均仓 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---|\n')
    mainline_runner_rows = sorted(mainline_runner_rows_all, key=lambda x: x['ret'], reverse=True)
    for r in mainline_runner_rows[:18]:
        rr = rerun_like(r, '主线大类Runner-次开10bp', px='nextopen', cost_bps=10.0)
        note = '超过原Runner' if runner_check and r['ret'] > runner_check['ret'] else '低于原Runner'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["maxheld"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 成交额因子专项\n\n')
    f.write('| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp收益 | 观察 |\n')
    f.write('|---|---:|---:|---:|---:|---|\n')
    amount_rows = [
        r for r in sorted(tests, key=lambda x: x['ret'], reverse=True)
        if any(k in r['label'] for k in ('amount_', 'price_amount', 'theme_amount'))
    ]
    for r in amount_rows[:15]:
        rr = rerun_like(r, '成交额-次开10bp', px='nextopen', cost_bps=10.0)
        note = '未超过鲁棒基准' if rr['ret'] < best_robust_check['ret'] else '超过鲁棒基准'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 次开10bp鲁棒榜\n\n')
    f.write('| 指标族 | 策略 | 次开10bp收益 | 最大回撤 | 交易 | 收盘收益 |\n')
    f.write('|---|---|---:|---:|---:|---:|\n')
    for rr, r in robust_ranked[:15]:
        f.write(f'| {factor_group(r["label"])} | {mdcell(r["label"])} | {rr["ret"]:.1f}% | {rr["mdd"]:.1f}% | {rr["trades"]} | {r["ret"]:.1f}% |\n')
    f.write('\n## 候选复核\n\n')
    f.write('| 策略 | 收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n')
    for r in checks:
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r.get("flat_ret", float("nan")):.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {r["underinvested_days"]} | {r["maxheld"]} |\n')
    f.write('\n## 成交/成本敏感性\n\n')
    f.write('| 策略 | 成交口径 | 单边成本 | 收益 | 年化 | 最大回撤 | 交易 | 均仓 |\n')
    f.write('|---|---|---:|---:|---:|---:|---:|---:|\n')
    for r in sensitivity:
        f.write(f'| {mdcell(r["label"])} | {r["px"]} | {r["cost_bps"]:.0f}bp | {r["ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} |\n')
    f.write('\n## 主线标的捕捉\n\n')
    f.write('| 代码 | 标的 | 主题 | 交易次数 | 组合贡献 |\n')
    f.write('|---|---|---|---:|---:|\n')
    for c, name, fam, count, contrib in capture_rows:
        f.write(f'| {c} | {name} | {fam} | {count} | {contrib:+.1f}% |\n')
    f.write('\n## 收益集中度\n\n')
    f.write('| 主题 | 涉及标的 | 交易次数 | 胜率 | 组合贡献 |\n')
    f.write('|---|---|---:|---:|---:|\n')
    for fam, v in top_contrib[:12]:
        winrate = v['wins'] / v['count'] * 100 if v['count'] else 0
        names = '、'.join(f'{code} {name}' for code, name in sorted(v['codes'].items()))
        f.write(f'| {fam} | {names} | {v["count"]} | {winrate:.0f}% | {v["contrib"] * 100:+.1f}% |\n')

print('候选方案复核:')
for r in checks:
    print(f'  {r["label"]:<14}{r["ret"]:>7.0f}% / 回撤{r["mdd"]:.0f}% / 交易{r["trades"]} / 均仓{r["avgheld"]:.2f} / 最大持仓{r["maxheld"]}')
print('成交/成本敏感性:')
for r in sensitivity:
    print(f'  {r["label"]:<16}{r["ret"]:>7.0f}% / 回撤{r["mdd"]:.0f}% / 交易{r["trades"]} / 均仓{r["avgheld"]:.2f}')
print(f'完整交易记录: {TRADE_LOG} | {len(records)} 笔')
if runner_check:
    print(f'Runner交易记录: {RUNNER_TRADE_LOG} | {len(runner_records)} 笔 | 收益{runner_check["ret"]:.1f}% / 均仓{runner_check["avgheld"]:.2f}')
if mainline_runner_check:
    print(f'主线大类Runner交易记录: {RUNNER_MAINLINE_TRADE_LOG} | {len(mainline_runner_records)} 笔 | 收益{mainline_runner_check["ret"]:.1f}% / 均仓{mainline_runner_check["avgheld"]:.2f}')
print(f'回测摘要: {SUMMARY_LOG}')
print('主线捕捉:')
for c, name, fam, count, contrib in capture_rows:
    print(f'  {c} {name:<12} {fam:<8} {count}笔 / 贡献{contrib:+.1f}%')
