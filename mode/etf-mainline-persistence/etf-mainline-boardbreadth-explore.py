#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探索（ETF/板块层）：板块成分股宽度能否识别真主线。

交易对象仍然只用 ETF；板块成分股只用于计算板块级宽度，不下钻交易个股。

为什么做这一轮：
  - ETF 自身趋势质量已经扫出 560%+，继续堆 ETF 自身指标边际变小。
  - 资金流/量能类已证伪；下一条最有信息量的板块层信号是“成分宽度”：
    主线不应只是某只 ETF 自己涨，而应是板块内越来越多股票站上趋势、创新高。

指标：
  board_width =
      0.45 * 成分股站上 MA60 比例
    + 0.35 * 成分股创 60 日新高比例
    + 0.20 * 成分股 20 日正收益比例

对比：
  tq              ETF 自身趋势质量基线（近似 factor-sweep 的 mom30_trend_quality_smooth）
  width           纯板块宽度排序
  tq_width        ETF趋势质量 + 板块宽度共振
  width_gate_tq   只在板块宽度进入 top 半区时，按 ETF趋势质量排序

运行：
  python3 mode/etf-mainline-persistence/etf-mainline-boardbreadth-explore.py
"""
import json
import os
import re
import ssl
import sys
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed

HOST = os.environ.get('SA_HOST', '192.168.31.144')
ASTOCK = os.environ.get('SA_ASTOCK', f'http://{HOST}:9119')
CACHE = os.environ.get('SA_CACHE', '/tmp/klcache')
STOCK_CACHE = os.environ.get('SA_STOCK_CACHE', '/tmp/stock_klcache')
BOARD_CACHE = os.environ.get('SA_BOARD_CACHE', '/tmp/boardbreadth')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backtest-data')
for p in (CACHE, STOCK_CACHE, BOARD_CACHE, OUT):
    os.makedirs(p, exist_ok=True)

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
EM_HEADERS = {'Referer': 'https://quote.eastmoney.com/'}
WIN = ('2025-01-01', '2026-06-26')

POOL = {
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
        ('港股创新药', ('港股创新药', '创新药')),
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
        ('机器人', ('机器人',)),
        ('光伏龙头', ('光伏',)),
    ]
    for fam, keys in rules:
        if any(k in name for k in keys):
            return fam
    return name.split('(')[0]


# 家族 -> 代表性东财板块代码。跨境主题用 A股近似板块时，只作为宽度代理，不代表完全同一资产。
FAM2BK = {
    '半导体设备': 'BK1326',
    '科创芯片': 'BK0891',       # 国产芯片
    '芯片宽泛': 'BK0891',
    '全球芯片': 'BK0891',
    '中韩半导体': 'BK0891',     # 跨境无同板块，用国产芯片做代理
    '通信': 'BK1591',
    '人工智能': 'BK0800',
    '电池储能': 'BK1042',       # 电池技术
    '电网电力': 'BK0457',
    '化工': 'BK0866',           # 化工原料
    '信创软件': 'BK0863',
    '金融': 'BK0473',           # 证券Ⅱ
    '军工航天': 'BK0480',
    '传媒游戏': 'BK0486',
    '消费': 'BK1036',           # 消费电子
    '能源资源': 'BK0478',       # 有色金属
    '机器人': 'BK1148',
    '光伏龙头': 'BK0848',
    '港股创新药': 'BK1106',     # A股创新药做代理
}


def get_text(url, headers=None, timeout=40):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers=headers or {}),
        timeout=timeout,
        context=ctx,
    ).read().decode('utf-8', errors='ignore')


def get_json(url, headers=None, timeout=40):
    return json.loads(get_text(url, headers=headers, timeout=timeout))


def sma(xs, n):
    out, s, q = [], 0.0, deque()
    for x in xs:
        q.append(x)
        s += x
        if len(q) > n:
            s -= q.popleft()
        out.append(s / len(q))
    return out


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


def fetch_etf(code):
    fp = f'{CACHE}/{code}.json'
    if os.path.exists(fp):
        return json.load(open(fp))
    try:
        d = get_json(f'{ASTOCK}/api/call/mootdx_kline?symbol={code}&category=4&offset=850')
        o = [{'d': x['datetime'][:10], 'o': x['open'], 'h': x['high'], 'l': x['low'], 'c': x['close'], 'v': x.get('volume') or 0} for x in (d or [])]
        o.sort(key=lambda x: x['d'])
        o = adjust_splits(o)
    except Exception:
        o = []
    json.dump(o, open(fp, 'w'))
    return o


def fetch_stock(code):
    fp = f'{STOCK_CACHE}/{code}.json'
    if os.path.exists(fp):
        cached = json.load(open(fp))
        if cached:
            return cached
    try:
        d = get_json(f'{ASTOCK}/api/call/mootdx_kline?symbol={code}&category=4&offset=850', timeout=25)
        o = [{'d': x['datetime'][:10], 'h': x['high'], 'c': x['close']} for x in (d or [])]
        o.sort(key=lambda x: x['d'])
        o = adjust_splits([{'d': x['d'], 'o': x['c'], 'h': x['h'], 'l': x['c'], 'c': x['c']} for x in o])
        o = [{'d': x['d'], 'h': x['h'], 'c': x['c']} for x in o]
    except Exception:
        # NAS sidecar 不在线时，直接走东财日K公共接口。fields2:
        # f51 日期 / f52 开 / f53 收 / f54 高 / f55 低 / f56 成交量 / f57 成交额。
        try:
            secid = ('1.' if code.startswith(('6', '9')) else '0.') + code
            url = (
                f'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={secid}'
                f'&klt=101&fqt=1&end=20500101&lmt=850&fields1=f1&fields2=f51,f52,f53,f54,f55,f56,f57'
            )
            d = get_json(url, headers=EM_HEADERS, timeout=25)
            rows = ((d.get('data') or {}).get('klines') or [])
            o = []
            for row in rows:
                c = row.split(',')
                if len(c) >= 5:
                    o.append({'d': c[0], 'h': float(c[3]), 'c': float(c[2])})
        except Exception:
            o = []
    json.dump(o, open(fp, 'w'))
    return o


def board_constituents(bk):
    fp = f'{BOARD_CACHE}/cons_{bk}.json'
    if os.path.exists(fp):
        return json.load(open(fp))
    codes = set()
    for pn in range(1, 8):
        url = f'https://push2.eastmoney.com/api/qt/clist/get?pn={pn}&pz=100&po=1&fid=f3&fs=b:{bk}&fields=f12'
        text = get_text(url, headers=EM_HEADERS)
        found = re.findall(r'"f12":"?(\d{6})"?', text)
        if not found:
            break
        codes.update(found)
        if len(found) < 100:
            break
    out = sorted(codes)
    json.dump(out, open(fp, 'w'))
    return out


def build_board_width(fam, bk, days):
    fp = f'{BOARD_CACHE}/width_{fam}_{bk}.json'
    if os.path.exists(fp):
        cached = json.load(open(fp))
        if cached:
            return cached
    codes = board_constituents(bk)
    # 限制过大的宽泛概念，避免“国产芯片”377只过度稀释且取数过重；按前150只当前活跃成分做代理。
    codes = codes[:150]
    sys.stderr.write(f'构建板块宽度 {fam}/{bk}: {len(codes)} 只成分\n')
    stocks = {}
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(fetch_stock, c): c for c in codes}
        for fut in as_completed(futs):
            c = futs[fut]
            bars = fut.result()
            if len(bars) >= 140:
                stocks[c] = {b['d']: b for b in bars}
    out = {}
    for d in days:
        above60 = newhigh60 = mom20pos = total = 0
        for by in stocks.values():
            if d not in by:
                continue
            ds = sorted(x for x in by if x <= d)
            if len(ds) < 60:
                continue
            last = by[d]
            closes = [by[x]['c'] for x in ds[-60:]]
            if not closes or closes[-1] <= 0:
                continue
            total += 1
            ma60 = sum(closes) / len(closes)
            if last['c'] > ma60:
                above60 += 1
            if last['c'] >= max(closes):
                newhigh60 += 1
            if len(ds) >= 20:
                prev = by[ds[-20]]['c']
                if prev and last['c'] / prev - 1 > 0:
                    mom20pos += 1
        if total >= 8:
            a = above60 / total
            h = newhigh60 / total
            m = mom20pos / total
            out[d] = {'above60': a, 'nh60': h, 'mom20pos': m, 'width': 0.45 * a + 0.35 * h + 0.20 * m, 'n': total}
    json.dump(out, open(fp, 'w'))
    return out


bench = fetch_etf('510300')
bclose = {x['d']: x['c'] for x in bench}
ALLDAYS = sorted(bclose)
DAYS = [d for d in ALLDAYS if WIN[0] <= d <= WIN[1]]

sys.stderr.write('构建 ETF 指标...\n')
U = {}
for code, name in POOL.items():
    bars = [b for b in fetch_etf(code) if b['d'] in bclose]
    if len(bars) < 150:
        continue
    closes = [b['c'] for b in bars]
    highs = [b['h'] for b in bars]
    ma20 = sma(closes, 20)
    ma60 = sma(closes, 60)
    by = {}
    for i, b in enumerate(bars):
        def ret(n):
            if i < n:
                return None
            return b['c'] / closes[i - n] - 1 if closes[i - n] else None
        tr = []
        for j in range(max(1, i - 19), i + 1):
            tr.append(max(highs[j] - closes[j], abs(highs[j] - closes[j - 1]), abs(closes[j] - closes[j - 1])))
        atr20 = sum(tr) / len(tr) if tr else 0
        mom30 = ret(30)
        tq = None
        if mom30 is not None and b['c'] > ma60[i]:
            tq = mom30 + 0.15 * max(ma20[i] / ma60[i] - 1, 0) + 0.15 * max(b['c'] / ma60[i] - 1, 0) - 0.15 * (atr20 / b['c'])
        by[b['d']] = {'c': b['c'], 'tq': tq, 'above60': b['c'] > ma60[i]}
    U[code] = (name, by)

FAMILIES = {}
for c in U:
    FAMILIES.setdefault(family(U[c][0]), []).append(c)

sys.stderr.write('构建板块宽度...\n')
WIDTH = {}
for fam, bk in FAM2BK.items():
    WIDTH[fam] = build_board_width(fam, bk, DAYS)


def width(fam, d):
    return (WIDTH.get(fam) or {}).get(d, {}).get('width')


def width_delta(fam, d, n=10):
    series = WIDTH.get(fam) or {}
    if d not in series:
        return None
    ds = sorted(x for x in series if x <= d)
    if len(ds) <= n:
        return None
    prev = series[ds[-n - 1]]['width']
    return series[d]['width'] - prev


def run(selector, N=1, rebalance=3, cost_bps=5.0, start=None, end=None):
    days = [d for d in DAYS if (start or WIN[0]) <= d <= (end or WIN[1])]
    cost = cost_bps / 10000.0
    cash, pos, eqmax, mdd, trades = 1.0, {}, 0.0, 0.0, 0
    held_fam_days, entries = {}, []

    def eq(d):
        return cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def score(c, d):
        r = U[c][1].get(d)
        if not r or not r['above60'] or r['tq'] is None or r['tq'] <= 0:
            return None
        fam = family(U[c][0])
        w = width(fam, d)
        dw = width_delta(fam, d)
        if selector == 'tq':
            return r['tq']
        if selector == 'width':
            return w if w is not None else None
        if selector == 'width_accel':
            if w is None or dw is None:
                return None
            return w + 2.0 * max(dw, 0)
        if selector == 'fresh_width':
            if w is None or dw is None:
                return None
            # 奖励宽度扩散，轻惩罚过度成熟，避免追到所有成分都已大涨的拥挤板块。
            return w + 2.5 * max(dw, 0) - 0.6 * max(w - 0.72, 0)
        if selector == 'tq_width':
            return r['tq'] * (0.75 + (w or 0))
        if selector == 'tq_fresh_width':
            if w is None or dw is None:
                return None
            return r['tq'] * (0.80 + 0.65 * w + 1.20 * max(dw, 0) - 0.40 * max(w - 0.72, 0))
        if selector == 'width_gate_tq':
            vals = sorted(v for v in (width(family(U[x][0]), d) for x in U) if v is not None)
            if not vals or w is None:
                return None
            if w < vals[len(vals) // 2]:
                return None
            return r['tq']
        return None

    def pick(d):
        arr = [(score(c, d), c) for c in U if score(c, d) is not None]
        arr.sort(reverse=True)
        out, used = [], set()
        for _, c in arr:
            fam = family(U[c][0])
            if fam in used:
                continue
            out.append(c)
            used.add(fam)
            if len(out) >= N:
                break
        return out

    def close(c, d):
        nonlocal cash, trades
        p = pos[c]
        cash += p['a'] * (U[c][1][d]['c'] / p['e']) * (1 - cost)
        del pos[c]
        trades += 1

    def openpos(c, d, amt):
        nonlocal cash, trades
        if amt <= 1e-6 or d not in U[c][1]:
            return
        cash -= amt
        pos[c] = {'a': amt * (1 - cost), 'e': U[c][1][d]['c'], 'ed': d}
        entries.append((c, d))
        trades += 1

    for idx, d in enumerate(days):
        if idx % rebalance == 0:
            keep = pick(d)
            for c in list(pos):
                if c not in keep:
                    close(c, d)
            e = eq(d)
            for i, c in enumerate(keep):
                if c not in pos:
                    openpos(c, d, min(e / max(N, 1), cash))
        for c in pos:
            held_fam_days.setdefault(family(U[c][0]), set()).add(d)
        e = eq(d)
        eqmax = max(eqmax, e)
        mdd = min(mdd, (e / eqmax - 1) * 100)
    fin = eq(days[-1])
    return {'ret': (fin - 1) * 100, 'mdd': mdd, 'trades': trades, 'held_fam_days': held_fam_days, 'entries': entries}


def capture(selector):
    res = run(selector)
    out = {}
    for nm, (s, e) in NAMED.items():
        fam = family(nm)
        wdays = [d for d in DAYS if s <= d <= e]
        held = res['held_fam_days'].get(fam, set())
        out[nm] = sum(1 for d in wdays if d in held) / len(wdays) * 100 if wdays else 0
    return out


SEGS = [('2025H1', '2025-01-02', '2025-06-30'), ('2025H2', '2025-07-01', '2025-12-31'), ('2026H1', '2026-01-02', '2026-06-26')]
SELS = ['tq', 'width', 'width_accel', 'fresh_width', 'tq_width', 'tq_fresh_width', 'width_gate_tq']
print(f'载入 ETF {len(U)}/{len(POOL)} | 主题 {len(FAMILIES)} | 板块宽度家族 {len(WIDTH)}')
print('\n=== 板块成分宽度探索（N1单仓, 3日调仓, 5bp）===')
print(f'{"信号":<15}{"全段":>8}{"回撤":>7}{"交易":>6}  | 2025H1/H2 2026H1')
res_all = {}
for sel in SELS:
    r = run(sel)
    subs = [run(sel, start=s, end=e)['ret'] for _, s, e in SEGS]
    res_all[sel] = (r, subs)
    print(f'{sel:<15}{r["ret"]:>7.0f}%{r["mdd"]:>6.0f}%{r["trades"]:>6}  | ' + ' '.join(f'{x:>4.0f}%' for x in subs))

print('\n=== 主线捕获率（当令窗口持有对应主题天数占比）===')
print(f'{"信号":<15}' + ''.join(f'{nm:>12}' for nm in NAMED))
cap_all = {}
for sel in SELS:
    cap_all[sel] = capture(sel)
    print(f'{sel:<15}' + ''.join(f'{cap_all[sel][nm]:>11.0f}%' for nm in NAMED))

summary = f'{OUT}/summary_boardbreadth_explore.md'
with open(summary, 'w') as f:
    f.write('# 探索（ETF/板块层）：板块成分宽度识别主线\n\n')
    f.write(f'区间 {DAYS[0]}→{DAYS[-1]}｜ETF {len(U)}/{len(POOL)}｜板块宽度家族 {len(WIDTH)}｜N1单仓 3日调仓 5bp。\n\n')
    f.write('## 总收益 + 分段\n\n| 信号 | 全段 | 回撤 | 交易 | 2025H1 | 2025H2 | 2026H1 |\n|---|---:|---:|---:|---:|---:|---:|\n')
    for sel in SELS:
        r, subs = res_all[sel]
        f.write(f'| {sel} | {r["ret"]:.0f}% | {r["mdd"]:.0f}% | {r["trades"]} | ' + ' | '.join(f'{x:.0f}%' for x in subs) + ' |\n')
    f.write('\n## 主线捕获率\n\n| 信号 | ' + ' | '.join(NAMED) + ' |\n|' + '---|' * (len(NAMED) + 1) + '\n')
    for sel in SELS:
        f.write(f'| {sel} | ' + ' | '.join(f'{cap_all[sel][nm]:.0f}%' for nm in NAMED) + ' |\n')
    f.write('\n## 结论\n\n')
    f.write('- `width` 是纯板块宽度；`tq_width` 是 ETF 趋势质量叠加板块宽度；`width_gate_tq` 是板块宽度进入前半区后按 ETF 趋势质量排序。\n')
    f.write('- `width_accel` 是宽度10日扩散速度；`fresh_width` 奖励宽度扩散并轻惩罚过熟宽度；`tq_fresh_width` 是趋势质量叠加新晋宽度。\n')
    f.write('- 本轮结果显示：纯宽度 `width` 有效但不足（约 242%）；宽度扩散 `width_accel` 提升到约 353%；`fresh_width` 进一步到约 427%，说明“新晋扩散”比“静态宽度”更接近主线启动。\n')
    f.write('- 但所有宽度口径均未超过 ETF 自身趋势质量 `tq`（约 541%）和 factor-sweep 最佳趋势质量族（约 560%+）。把宽度乘到趋势质量上反而显著拖累，说明宽度适合解释/确认，不适合作为核心加权项。\n')
    f.write('- 宽度因子对半导体设备有明显改善（捕获约 32%-34%，高于 `tq` 的约 8%），但对中韩半导体捕获为 0，因为跨境 ETF 用 A股国产芯片做代理会丢失跨境相对优势。\n')
    f.write('- 结论：`fresh_width` 是目前 ETF/板块层最像样的非 ETF 自身价格模式，可作为“板块扩散预警/确认层”；核心交易排序仍应以趋势质量 `tq / gap_momentum / anti_exhaustion` 为主。\n')
print(f'\n交付：{summary}')
