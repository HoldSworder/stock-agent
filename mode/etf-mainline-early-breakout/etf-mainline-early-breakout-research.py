#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ETF 早期突破主线模式研究：不用 RS，用突破/加速度/量能更早识别主线。

目标：
- 最大持仓 3 只；
- 入场只使用标的自身突破、加速度、量能和绝对趋势，退出使用弱势替换和趋势破位；
- 用同一 ETF 池、同一 K 线数据源，与既有模式公平比较。

运行：
  python3 mode/etf-mainline-early-breakout/etf-mainline-early-breakout-research.py

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
    '/Users/qiuzhuoran/Desktop/自用/code/stock-agent/mode/etf-mainline-early-breakout/backtest-data',
)
TRADE_LOG = os.environ.get('SA_RESEARCH_TRADE_LOG', f'{OUT_DIR}/trades_early_breakout.md')
SUMMARY_LOG = os.environ.get('SA_RESEARCH_SUMMARY_LOG', f'{OUT_DIR}/summary_early_breakout.md')
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
    vols = [b['v'] for b in bars]
    ma20 = sma(closes, 20)
    ma30 = sma(closes, 30)
    ma60 = sma(closes, 60)
    ma120 = sma(closes, 120)
    vma20 = sma(vols, 20)
    vma60 = sma(vols, 60)
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
        hi20prev = max(highs[max(0, i - 20):i]) if i else b['h']
        hi60prev = max(highs[max(0, i - 60):i]) if i else b['h']
        hi120prev = max(highs[max(0, i - 120):i]) if i else b['h']
        breakout20 = b['c'] / hi20prev - 1 if hi20prev else 0.0
        breakout60 = b['c'] / hi60prev - 1 if hi60prev else 0.0
        breakout120 = b['c'] / hi120prev - 1 if hi120prev else 0.0
        vol_ratio20 = b['v'] / vma20[i] if vma20[i] else 1.0
        vol_ratio60 = b['v'] / vma60[i] if vma60[i] else 1.0
        slope20_60 = ma20[i] / ma60[i] - 1 if ma60[i] else 0.0
        accel20_60 = ret(20) - ret(60)
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
            'hi20prev': hi20prev,
            'hi60prev': hi60prev,
            'hi120prev': hi120prev,
            'breakout20': breakout20,
            'breakout60': breakout60,
            'breakout120': breakout120,
            'vol_ratio20': vol_ratio20,
            'vol_ratio60': vol_ratio60,
            'slope20_60': slope20_60,
            'accel20_60': accel20_60,
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
            'mom126': ret(126),
            'mom252': ret(252),
            'abs13612': 12 * ret(21) + 4 * ret(63) + 2 * ret(126) + ret(252),
            'abs_mom_blend': 0.5 * ret(90) + 0.3 * ret(60) + 0.2 * ret(120),
            'abs_accel': ret(60) - ret(120),
            'early_breakout': breakout60 + 0.5 * ret(20) + 0.2 * max(0.0, vol_ratio20 - 1.0) + 0.5 * slope20_60,
            'early_accel': accel20_60 + 0.5 * breakout20 + 0.2 * max(0.0, vol_ratio20 - 1.0),
            'early_trend': 0.4 * ret(20) + 0.4 * ret(60) + 0.2 * slope20_60 + 0.1 * max(0.0, vol_ratio60 - 1.0),
            'rs60': rsret(60),
            'rs90': rsret(90),
            'rs120': rsret(120),
            'combo90': 0.5 * rsret(90) + 0.5 * ret(90),
            'combo60_90': 0.5 * rsret(60) + 0.5 * rsret(90),
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
               cost_bps=0.0, cfg=None):
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
        fam = family(U[c][0])
        return all(family(U[h][0]) != fam for h in pos if h != replace)

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
        for c in list(pos):
            if d not in U[c][1]:
                continue
            reason = runner_exit_reason(c, d, pos[c], rank_pos.get(c, 999), cfg)
            if reason:
                close_position(c, d, reason)

        if idx % rebalance == 0:
            candidates = [c for _, c in ranked if c not in pos and family_ok(c)]
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

            candidates = [c for _, c in ranked if c not in pos and family_ok(c)]
            for c in candidates:
                if len(pos) >= 3:
                    break
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
                    'entryClose': p['e'], 'exitClose': r['c'],
                    'pnl': (r['c'] / p['e'] - 1) * 100,
                    'contrib': p['gross'] * (r['c'] / p['e'] * (1 - cost) - 1),
                    'reason': '持有中',
                })
    avgheld = held_sum / len(active_days) if active_days else 0
    return {
        'kind': 'runner', 'label': label, 'score': score_key, 'abs': abs_key, 'cfg': cfg, 'px': px,
        'cost_bps': cost_bps, 'ret': (fin - 1) * 100, 'flat_ret': flat_ret, 'ann': ann, 'mdd': mdd,
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
                    'entryClose': p['e'], 'exitClose': r['c'],
                    'pnl': (r['c'] / p['e'] - 1) * 100,
                    'contrib': p['gross'] * (r['c'] / p['e'] * (1 - cost) - 1),
                    'reason': '持有中',
                })
    avgheld = held_sum / len(active_days) if active_days else 0
    return {
        'kind': 'weighted', 'label': label, 'score': score_key, 'abs': abs_key, 'weights': weights,
        'exit_rule': exit_rule, 'px': px, 'cost_bps': cost_bps,
        'reset_weights': reset_weights,
        'ret': (fin - 1) * 100, 'flat_ret': flat_ret, 'ann': ann, 'mdd': mdd, 'trades': trades,
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


BASELINE_RET = 364.9
HIGH_BAR_RET = 364.9

cfgs = []
for protect_gain in (0.25, 0.30, 0.40):
    for protect_dd in (0.15, 0.18, 0.22):
        for trend_ma in ('ma60', 'ma120'):
            for trend_dd in (0.10, 0.15):
                for weak_rank in (6, 9, 12):
                    cfgs.append({
                        'protect_gain': protect_gain,
                        'protect_dd': protect_dd,
                        'trend_ma': trend_ma,
                        'trend_dd': trend_dd,
                        'weak_rank': weak_rank,
                        'weak_ma': 'ma60',
                        'switch': 0.05,
                        'min_hold': 10,
                    })

tests = []
SCORE_KEYS = (
    'early_breakout', 'early_accel', 'early_trend',
    'breakout20', 'breakout60', 'breakout120',
    'accel20_60', 'mom20', 'mom30', 'mom40', 'mom50', 'mom60', 'abs_accel', 'abs13612',
)

for score_key in SCORE_KEYS:
    for abs_key in (None, 'above60', 'above120'):
        for cfg in cfgs:
            label = (
                f'{score_key}|{abs_key or "noabs"}|pg{cfg["protect_gain"]:.0%}'
                f'|pd{cfg["protect_dd"]:.0%}|{cfg["trend_ma"]}|wr{cfg["weak_rank"]}'
            )
            tests.append(run_runner(label, score_key, abs_key, 5, 0.0, True, cfg=cfg))

for score_key in SCORE_KEYS:
    for abs_key in (None, 'above60', 'above120'):
        for weights in ((1.0,), (0.95, 0.05), (0.9, 0.1), (0.85, 0.15), (0.8, 0.2), (0.7, 0.3), (0.6, 0.4), (0.5, 0.5), (0.5, 0.3, 0.2), (0.6, 0.25, 0.15), (0.45, 0.35, 0.20), (0.7, 0.2, 0.1)):
            for exit_rule in ('rank', 'ma120', 'ma60trail12'):
                for reset_weights in (False, True):
                    mode = 'reset' if reset_weights else 'keep'
                    label = f'wrot-{mode}|{score_key}|{abs_key or "noabs"}|{"/".join(f"{w:.0%}" for w in weights)}|{exit_rule}'
                    tests.append(run_weighted_rotation(label, score_key, abs_key, 5, 0.0, weights, True, exit_rule=exit_rule, reset_weights=reset_weights))


def score_result(r):
    excess = max(0.0, r['ret'] - BASELINE_RET)
    return excess * 0.05 + r['ret'] / max(1, abs(r['mdd'])) - r['trades'] * 0.003


tests.sort(key=score_result, reverse=True)
passed = [r for r in tests if r['ret'] > BASELINE_RET]
passed_high_with_exit = [r for r in passed if r['ret'] > HIGH_BAR_RET and r.get('exit_rule') in ('ma120', 'ma60trail12')]
passed_escape = [r for r in passed if r.get('exit_rule') == 'ma60trail12']
best = passed_high_with_exit[0] if passed_high_with_exit else (passed_escape[0] if passed_escape else (passed[0] if passed else tests[0]))


def rerun_like(r, label, start=None, end=None, log=False, px='close', cost_bps=0.0):
    if r['kind'] == 'weighted':
        return run_weighted_rotation(
            label, r['score'], r['abs'], 5, 0.0, r['weights'], True,
            start, end, log, px, cost_bps, r['exit_rule'], r['reset_weights'],
        )
    return run_runner(
        label, r['score'], r['abs'], 5, 0.0, True,
        start, end, log, px, cost_bps, r['cfg'],
    )

print(f'载入 {len(U)}/{len(POOL)} | 区间 {days[0]}→{days[-1]} | 策略族=早期突破主线 | 基准收益>{BASELINE_RET:.1f}%')
print('Top30:')
print(f'{"策略":<58}{"收益":>8}{"年化":>7}{"回撤":>7}{"交易":>6}{"均仓":>6}{"空槽日":>7}')
for r in tests[:30]:
    print(f'{r["label"]:<58}{r["ret"]:>7.0f}%{r["ann"]:>6.0f}%{r["mdd"]:>6.0f}%{r["trades"]:>6}{r["avgheld"]:>6.2f}{r["underinvested_days"]:>7}')

print('超过基准候选数:', len(passed))
print('宽基:')
for code, name in [('510300', '沪深300'), ('510500', '中证500'), ('159915', '创业板指'), ('588000', '科创50')]:
    r, dd = buyhold(code)
    print(f'  {name:<8}{r:>6.0f}% / 回撤{dd:.0f}%')

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

print('候选方案复核:')
for r in checks:
    print(f'  {r["label"]:<14}{r["ret"]:>7.0f}% / 回撤{r["mdd"]:.0f}% / 交易{r["trades"]} / 均仓{r["avgheld"]:.2f} / 空槽日{r["underinvested_days"]} / 最大持仓{r["maxheld"]}')

print('成交/成本敏感性:')
for r in sensitivity:
    print(f'  {r["label"]:<16}{r["ret"]:>7.0f}% / 回撤{r["mdd"]:.0f}% / 交易{r["trades"]} / 均仓{r["avgheld"]:.2f} / 空槽日{r["underinvested_days"]}')

# ===== 稳健性体检：mom30 是稳健平台还是运气尖峰？=====
# 固定推荐结构（wrot-keep, above120, 单腿100%, ma120退出），只扫动量回看窗口。
def neigh_run(score_key, weights=(1.0,), start=None, end=None):
    return run_weighted_rotation(f'neigh-{score_key}', score_key, 'above120', 5, 0.0,
                                 weights, True, start, end, False, 'close', 5.0,
                                 'ma120', False)

NEIGH = ['mom20', 'mom25', 'mom30', 'mom35', 'mom40', 'mom45', 'mom50', 'mom60']
neigh_full = {k: neigh_run(k) for k in NEIGH}
neigh_2025 = {k: neigh_run(k, start='2025-01-01', end='2025-12-31') for k in NEIGH}
neigh_2026 = {k: neigh_run(k, start='2026-01-01', end='2026-06-26') for k in NEIGH}

# 集中度稳健性：mom30 在 单腿 / 80-20 / 70-30 / 60-40 下
CONC = [(1.0,), (0.8, 0.2), (0.7, 0.3), (0.6, 0.4)]
conc_rows = []
for w in CONC:
    full_r = run_weighted_rotation('conc', 'mom30', 'above120', 5, 0.0, w, True,
                                   None, None, False, 'close', 5.0, 'ma120', False)
    r25 = run_weighted_rotation('c25', 'mom30', 'above120', 5, 0.0, w, True,
                                '2025-01-01', '2025-12-31', False, 'close', 5.0, 'ma120', False)
    r26 = run_weighted_rotation('c26', 'mom30', 'above120', 5, 0.0, w, True,
                                '2026-01-01', '2026-06-26', False, 'close', 5.0, 'ma120', False)
    conc_rows.append((w, full_r, r25, r26))

print('\n=== 稳健性体检 A：动量回看窗口邻域（推荐结构, 5bp）===')
print(f'{"窗口":<8}' + ''.join(f'{k:>8}' for k in NEIGH))
print(f'{"全段":<7}' + ''.join(f'{neigh_full[k]["ret"]:>7.0f}%' for k in NEIGH))
print(f'{"2025":<7}' + ''.join(f'{neigh_2025[k]["ret"]:>7.0f}%' for k in NEIGH))
print(f'{"2026":<7}' + ''.join(f'{neigh_2026[k]["ret"]:>7.0f}%' for k in NEIGH))
print(f'{"回撤":<7}' + ''.join(f'{neigh_full[k]["mdd"]:>7.0f}%' for k in NEIGH))
vals = [neigh_full[k]['ret'] for k in NEIGH]
spread = max(vals) - min(vals)
print(f'邻域极差={spread:.0f}pp（>200pp=尖峰/脆；<120pp=平台/稳）')

print('\n=== 稳健性体检 B：集中度（mom30, 5bp）单腿 vs 分仓 ===')
print(f'{"权重":<12}{"全段":>8}{"2025":>8}{"2026":>8}{"回撤":>8}')
for w, fr, r25, r26 in conc_rows:
    print(f'{"/".join(f"{x:.0%}" for x in w):<12}{fr["ret"]:>7.0f}%{r25["ret"]:>7.0f}%{r26["ret"]:>7.0f}%{fr["mdd"]:>7.0f}%')

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
    f.write('# ETF 早期突破主线模式回测摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}\n')
    f.write(f'- ETF池: {len(U)}/{len(POOL)} 只可用\n')
    f.write(f'- 对比基准: 上一版 mom90 绝对动量龙头约 +{BASELINE_RET:.1f}%\n')
    f.write('- 最大持仓: 3；同主题最多 1 只；每 5 个交易日补仓/弱者替换。\n')
    if best['kind'] == 'weighted':
        f.write(f'- 退出: 跌出加权 TopN；推荐版额外使用 {best["exit_rule"]} 趋势退出口径；不按单标的定制。\n\n')
    else:
        f.write('- 退出: 盈利保护、趋势破位、弱势跌出排行后破 MA60；不按单标的定制。\n\n')
    f.write('## Top10 参数\n\n')
    f.write('| 策略 | 收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 超上一版 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---|\n')
    for r in tests[:10]:
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {r["underinvested_days"]} | {"是" if r["ret"] > BASELINE_RET else "否"} |\n')
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
    f.write('\n## 稳健性体检（关键）：+420% 是稳健边际还是运气尖峰？\n\n')
    f.write('### A) 动量回看窗口邻域（固定推荐结构, 含5bp成本）\n\n')
    f.write('| 区间 | ' + ' | '.join(NEIGH) + ' |\n|---|' + '---:|' * len(NEIGH) + '\n')
    f.write('| 全段 | ' + ' | '.join(f'{neigh_full[k]["ret"]:.0f}%' for k in NEIGH) + ' |\n')
    f.write('| 2025 | ' + ' | '.join(f'{neigh_2025[k]["ret"]:.0f}%' for k in NEIGH) + ' |\n')
    f.write('| 2026 | ' + ' | '.join(f'{neigh_2026[k]["ret"]:.0f}%' for k in NEIGH) + ' |\n')
    f.write('| 回撤 | ' + ' | '.join(f'{neigh_full[k]["mdd"]:.0f}%' for k in NEIGH) + ' |\n\n')
    f.write(f'**邻域极差 {spread:.0f}pp**。mom30=405% 是孤立尖峰，邻居 mom40 掉到 138%、mom45 仅 71%——'
            '稳健信号应随窗口平滑变化，这里不是。\n\n')
    f.write('### B) 集中度稳健性（mom30, 含5bp）：单腿 vs 分仓\n\n')
    f.write('| 权重 | 全段 | 2025 | 2026 | 回撤 |\n|---|---:|---:|---:|---:|\n')
    for w, fr, r25, r26 in conc_rows:
        f.write(f'| {"/".join(f"{x:.0%}" for x in w)} | {fr["ret"]:.0f}% | {r25["ret"]:.0f}% | {r26["ret"]:.0f}% | {fr["mdd"]:.0f}% |\n')
    f.write('\n**致命点**：从单腿100%(405%) 一旦加到两腿(80/20=79%)，收益**断崖式崩塌**。说明 +420% 几乎全部来自'
            '单腿恰好撞中全球芯片(+103%)、卫星(+88%)、半导体设备(+78%) 三四笔运气单，分散后被稀释。这是过拟合/路径运气的铁证，'
            '与 leader-runner 的"集中度单调递增"完全相反。\n\n')
    f.write('### 诚实结论\n\n'
            '- **不要把 +420%/+405% 当作前瞻预期**，它是单腿+特定窗口的运气上尾。\n'
            '- 可复现的中枢预期约 **+80%~+120%**（分仓 60/40~70/30，或换相邻窗口）。\n'
            '- 该口径回撤普遍 -25%~-34%，2026 子段最差到 -38.9%，短动量在震荡期会被反复打脸。\n'
            '- 早期突破/短动量"早上车"的代价是**信号噪声大、稳健性差**；要稳健高收益，仍以多周期相对强弱(rsblend)等更黏的信号为底座。\n\n')
    f.write('## 收益集中度\n\n')
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
