#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探索（ETF/板块层）：用「板块主力资金净流入」识别主线。

这是研究里识别主线的头号因子（行业主力资金净流入），且是板块级、有完整历史——
东财 secid=90.BKxxxx 的 push2his fflow/daykline 返回每日主力净流入（实测可用）。

口径与约束：
  - 仅覆盖 A股板块。港股创新药/中韩半导体/恒生科技/纳指等跨境主线 A股无对应板块 → 拿不到，标 NA。
  - 把每个可覆盖 ETF 主题映射到一个代表性东财板块，取该板块每日主力净流入。
  - 因子：secmf = 板块主力净流入 20日均值(亿)；正且越大=资金越在涌入该板块。

测三件事，全部对齐 rs90 基线 + 主线捕获率：
  rs90       价格相对强弱90日（现行基线）
  secmf      纯按板块主力净流入MA20 选（资金最强板块）
  rs90+secmf 共振确认：rs90 领先腿中再要求板块主力净流入MA20>0（动量×资金双确认）

运行：python3 mode/etf-mainline-persistence/etf-mainline-sectorflow-explore.py
"""
import json, urllib.request, ssl, os, re, sys
from collections import deque

HOST = os.environ.get('SA_HOST', '192.168.31.144')
ASTOCK = os.environ.get('SA_ASTOCK', f'http://{HOST}:9119')
NAS = f'http://{HOST}:8787/api'
TOKEN = os.environ.get('SA_APP_TOKEN', '')
CACHE = os.environ.get('SA_CACHE', '/tmp/klcache')
BKCACHE = '/tmp/bkflow'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'backtest-data')
for p in (CACHE, BKCACHE, OUT):
    os.makedirs(p, exist_ok=True)
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
EM = {'Referer': 'https://quote.eastmoney.com/'}
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
NAMED = {'港股创新药': ('2025-01-02', '2025-06-30'), '通信': ('2025-07-01', '2025-12-31'),
         '中韩半导体': ('2026-01-02', '2026-06-26'), '半导体设备': ('2026-01-02', '2026-06-26')}


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


# 家族 → 代表性东财板块名（仅 A股可覆盖；跨境家族不在此=NA）
FAM2BOARD = {
    '半导体设备': '半导体设备', '科创芯片': '国产芯片', '芯片宽泛': '国产芯片',
    '通信': '通信网络设备及器件', '人工智能': '人工智能', '电池储能': '电池技术',
    '电网电力': '电网设备', '化工': '化工原料', '信创软件': '信创', '金融': '证券Ⅱ',
    '军工航天': '国防军工', '传媒游戏': '传媒', '消费': '消费电子', '能源资源': '有色金属',
    '机器人': '机器人概念', '光伏龙头': '光伏概念',
}


def get(url, token=False, headers=None):
    h = dict(headers or {})
    if token:
        h['x-app-token'] = TOKEN
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=40, context=ctx).read())


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


# 全量板块名→BK代码（缓存 /tmp/boards.json）
def board_codes():
    fp = '/tmp/boards.json'
    if os.path.exists(fp):
        m = json.load(open(fp))
    else:
        m = {'ind': {}, 'con': {}}
        for key, t in (('ind', 2), ('con', 3)):
            for pn in range(1, 7):
                url = f'https://push2.eastmoney.com/api/qt/clist/get?pn={pn}&pz=100&po=1&fid=f12&fs=m:90+t:{t}&fields=f12,f14'
                d = get(url, headers=EM)
                diff = (d.get('data') or {}).get('diff') or {}
                if not diff:
                    break
                for x in diff.values():
                    m[key][x['f14']] = x['f12']
        json.dump(m, open(fp, 'w'), ensure_ascii=False)
    out = {}
    out.update(m['con']); out.update(m['ind'])  # 行业优先覆盖同名
    return out


def fetch_board_flow(bk):
    """板块每日主力净流入(亿)序列 {date: netinflow亿}。缓存。"""
    fp = f'{BKCACHE}/{bk}.json'
    if os.path.exists(fp):
        return json.load(open(fp))
    url = (f'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=90.{bk}'
           f'&klt=101&lmt=800&fields1=f1,f2,f3,f7&fields2=f51,f52,f57')
    out = {}
    try:
        d = get(url, headers=EM)
        for row in ((d.get('data') or {}).get('klines') or []):
            c = row.split(','); out[c[0]] = float(c[1]) / 1e8
    except Exception as e:
        sys.stderr.write(f'板块{bk}取数失败 {e}\n')
    json.dump(out, open(fp, 'w')); return out


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
BCODE = board_codes()
sys.stderr.write(f'构建 {len(POOL)} 只指标 + 板块资金流...\n')

# 拉取所有用到的板块资金流，按家族存
FAM_FLOW = {}        # fam -> {date: mf_ma20(亿)}
FAM_COVER = {}       # fam -> board name or None
for fam, bname in FAM2BOARD.items():
    bk = BCODE.get(bname)
    FAM_COVER[fam] = bname if bk else None
    if not bk:
        sys.stderr.write(f'家族{fam}板块名"{bname}"未找到代码\n'); continue
    flow = fetch_board_flow(bk)
    days = sorted(flow)
    vals = [flow[d] for d in days]
    ma = sma(vals, 20)
    FAM_FLOW[fam] = {days[i]: ma[i] for i in range(len(days))}

U = {}
for code, name in POOL.items():
    bars = [b for b in fetch(code) if b['d'] in bclose]
    if len(bars) < 150:
        continue
    closes = [b['c'] for b in bars]
    ma60 = sma(closes, 60)
    rs_series = [b['c'] / bclose[b['d']] for b in bars]
    by = {}
    for i, b in enumerate(bars):
        d = b['d']; rs = rs_series[i]
        def rsret(n):
            if i < n:
                return None
            prev = rs_series[i - n]
            return rs / prev - 1 if prev else None
        by[d] = {'c': b['c'], 'rs90': rsret(90), 'ma60': ma60[i], 'above60': b['c'] > ma60[i]}
    U[code] = (name, by)

DAYS = [d for d in ALLDAYS if WIN[0] <= d <= WIN[1]]
FAMILIES = {}
for c in U:
    FAMILIES.setdefault(family(U[c][0]), []).append(c)


def secmf(fam, d):
    """家族对应板块主力净流入MA20(亿)；无覆盖返回 None。"""
    f = FAM_FLOW.get(fam)
    return f.get(d) if f else None


def run(selector, N=2, weights=None, rebalance=5, start=None, end=None, cost_bps=5.0):
    days = [d for d in DAYS if (start or WIN[0]) <= d <= (end or WIN[1])]
    cost = cost_bps / 10000.0
    weights = weights or tuple([1.0 / N] * N)
    cash = 1.0; pos = {}; eqmax = 0; mdd = 0; trades = 0
    held_fam_days = {}; entries = []
    eq = lambda d: cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])

    def score(c, d):
        r = U[c][1].get(d)
        if not r or not r['above60']:
            return None
        fam = family(U[c][0]); mf = secmf(fam, d)
        if selector == 'rs90':
            return r['rs90'] if (r['rs90'] is not None and r['rs90'] > 0) else None
        if selector == 'secmf':
            return mf if (mf is not None and mf > 0) else None
        if selector == 'rs90+secmf':
            if r['rs90'] is None or r['rs90'] <= 0 or mf is None or mf <= 0:
                return None
            return r['rs90']
        # 相对版：不要求>0，按横截面资金强弱（取当日有覆盖家族里资金 top50%）
        if selector in ('secmf_rel', 'rs90+secmf_rel'):
            if mf is None:
                return None
            covered_mf = sorted(v for v in (secmf(family(U[x][0]), d) for x in U) if v is not None)
            if not covered_mf:
                return None
            med = covered_mf[len(covered_mf) // 2]
            if mf < med:  # 资金弱于覆盖家族中位 → 不选
                return None
            if selector == 'secmf_rel':
                return mf
            return r['rs90'] if (r['rs90'] is not None and r['rs90'] > 0) else None
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

    def close(c, d):
        nonlocal cash, trades
        p = pos[c]; px = U[c][1][d]['c']; cash += p['a'] * (px / p['e']) * (1 - cost); del pos[c]; trades += 1

    def openpos(c, d, amt):
        nonlocal cash, trades
        if amt <= 1e-6 or d not in U[c][1]:
            return
        cash -= amt; pos[c] = {'a': amt * (1 - cost), 'e': U[c][1][d]['c'], 'ed': d}; trades += 1
        entries.append((c, d))

    for idx, d in enumerate(days):
        if idx % rebalance == 0:
            keep = pick(d)
            for c in list(pos):
                if c not in keep:
                    close(c, d)
            E = eq(d)
            for i, c in enumerate(keep):
                if c in pos:
                    continue
                openpos(c, d, min(E * weights[i], cash))
        for c in pos:
            held_fam_days.setdefault(family(U[c][0]), set()).add(d)
        e = eq(d); eqmax = max(eqmax, e); mdd = min(mdd, (e / eqmax - 1) * 100)
    last = days[-1]; fin = eq(last); n = len(days)
    return {'sel': selector, 'ret': (fin - 1) * 100, 'mdd': mdd, 'trades': trades,
            'held_fam_days': held_fam_days, 'entries': entries}


def capture_pct(selector, N=2):
    res = run(selector, N)
    out = {}
    for nm, (s, e) in NAMED.items():
        fam = family(nm)
        wdays = [d for d in DAYS if s <= d <= e]
        held = res['held_fam_days'].get(fam, set())
        hit = sum(1 for d in wdays if d in held)
        cover = FAM_COVER.get(fam)
        out[nm] = (hit / len(wdays) * 100 if wdays else 0, cover)
    return out


def entry_rise(selector):
    res = run(selector, 2)
    rises = []
    for c, ed in res['entries']:
        by = U[c][1]; ds = [d for d in DAYS if d <= ed and d in by]
        if len(ds) < 60:
            continue
        win = [by[d]['c'] for d in ds[-60:]]
        rises.append((by[ed]['c'] / min(win) - 1) * 100)
    rises.sort()
    return rises[len(rises) // 2] if rises else 0


SEGS = [('2025H1', '2025-01-02', '2025-06-30'), ('2025H2', '2025-07-01', '2025-12-31'),
        ('2026H1', '2026-01-02', '2026-06-26')]
SELS = ['rs90', 'secmf', 'rs90+secmf', 'secmf_rel', 'rs90+secmf_rel']
covered = [f for f in FAM2BOARD if FAM_COVER.get(f)]
print(f'载入 {len(U)}/{len(POOL)} | 主题 {len(FAMILIES)} | 板块资金流覆盖家族 {len(covered)}/{len(FAM2BOARD)}')
print('覆盖:', ' '.join(f'{f}→{FAM_COVER[f]}' for f in covered), '\n')

print('=== 总收益 + 分段（N2均权, 含5bp）===')
print(f'{"信号":<12}{"全段":>8}{"回撤":>7}{"交易":>6}  | 2025H1/H2 2026H1')
res_all = {}
for sel in SELS:
    r = run(sel, 2)
    subs = [run(sel, 2, start=s, end=e)['ret'] for _, s, e in SEGS]
    res_all[sel] = (r, subs)
    print(f'{sel:<12}{r["ret"]:>7.0f}%{r["mdd"]:>6.0f}%{r["trades"]:>6}  | ' + ' '.join(f'{x:>4.0f}%' for x in subs))

print('\n=== 主线捕获率（NA=A股无对应板块, 资金流盖不到）===')
print(f'{"信号":<12}' + ''.join(f'{nm:>12}' for nm in NAMED))
cap_all = {}
for sel in SELS:
    cap = capture_pct(sel, 2)
    cap_all[sel] = cap
    cells = []
    for nm in NAMED:
        v, cov = cap[nm]
        cells.append(('NA' if cov is None and sel == 'secmf' else f'{v:.0f}%').rjust(11))
    print(f'{sel:<12}' + ''.join(cells))

print('\n=== 上车早晚（相对60日低点已涨幅中位, 越小越早）===')
er = {}
for sel in SELS:
    er[sel] = entry_rise(sel)
    print(f'  {sel:<12} {er[sel]:.0f}%')

# 集中度对比：和 mode/ 下高收益模式同口径（单腿 / 85·15 重仓），消除"均权拉低收益"的错觉
print('\n=== 集中度对比（与老模式可比口径）===')
print(f'{"信号":<14}{"N2均权":>9}{"N1单腿":>9}{"N2(85/15)":>11}')
CONC = {}
for sel in ['rs90', 'secmf_rel', 'rs90+secmf_rel']:
    n2 = run(sel, 2)['ret']
    n1 = run(sel, 1, weights=(1.0,))['ret']
    w8515 = run(sel, 2, weights=(0.85, 0.15))['ret']
    CONC[sel] = (n2, n1, w8515)
    print(f'{sel:<14}{n2:>8.0f}%{n1:>8.0f}%{w8515:>10.0f}%')
print('对照 mode/ 老模式：profit-runner 302% / leader-runner 353-380% / early-breakout 420%(单腿运气尖峰,已证伪)')

with open(f'{OUT}/summary_sectorflow_explore.md', 'w') as f:
    f.write('# 探索（ETF/板块层）：板块主力资金净流入识别主线\n\n')
    f.write(f'区间 {DAYS[0]}→{DAYS[-1]}｜{len(U)}只池｜板块资金流覆盖 {len(covered)}/{len(FAM2BOARD)} 个 A股家族。\n\n')
    f.write('数据：东财 secid=90.BKxxxx 每日主力净流入(f52)，取20日均值(亿)。**仅 A股板块**——'
            '港股创新药/中韩半导体/恒生科技/纳指等跨境主线无对应板块，标 NA。\n\n')
    f.write('## 总收益 + 分段\n\n| 信号 | 全段 | 回撤 | 交易 | 2025H1 | 2025H2 | 2026H1 |\n|---|---:|---:|---:|---:|---:|---:|\n')
    for sel in SELS:
        r, subs = res_all[sel]
        f.write(f'| {sel} | {r["ret"]:.0f}% | {r["mdd"]:.0f}% | {r["trades"]} | ' + ' | '.join(f'{x:.0f}%' for x in subs) + ' |\n')
    f.write('\n## 主线捕获率\n\n| 信号 | ' + ' | '.join(NAMED) + ' |\n|' + '---|' * (len(NAMED) + 1) + '\n')
    for sel in SELS:
        cells = []
        for nm in NAMED:
            v, cov = cap_all[sel][nm]
            cells.append('NA' if (cov is None and sel == 'secmf') else f'{v:.0f}%')
        f.write(f'| {sel} | ' + ' | '.join(cells) + ' |\n')
    f.write('\n## 上车早晚\n\n| 信号 | 上车已涨中位 |\n|---|---:|\n')
    for sel in SELS:
        f.write(f'| {sel} | {er[sel]:.0f}% |\n')
    f.write('\n## 集中度对比（解释"为何比 mode/ 老模式收益低"）\n\n')
    f.write('本探索基线为 **N2 均权**（公平对比信号本身），故 rs90 仅 188%；'
            'mode/ 下老模式高收益靠"重仓集中度"。同口径补测：\n\n')
    f.write('| 信号 | N2均权 | N1单腿 | N2(85/15重仓) |\n|---|---:|---:|---:|\n')
    for sel in ['rs90', 'secmf_rel', 'rs90+secmf_rel']:
        n2, n1, w = CONC[sel]
        f.write(f'| {sel} | {n2:.0f}% | {n1:.0f}% | {w:.0f}% |\n')
    f.write('\n- **rs90 重仓(85/15) = 310%**，与 mode/ 老模式同梯队（profit-runner 302% / leader-runner 353-380%）'
            '——证明收益差距源于**仓位集中度**而非因子。\n')
    f.write('- 资金因子越集中越差（secmf_rel 73%→14%）：信号质量不足以重仓，错误被放大。\n')
    f.write('- 故 **ETF/板块层最优仍是 rs90 + 重仓集中度**，资金类因子不构成增量。\n')
    f.write('\n## 因子口径与覆盖\n\n')
    f.write('- **secmf** 板块主力净流入：家族→代表板块的每日主力净流入20日均值(亿)，>0 入选、越大越前。\n')
    f.write('- **rs90+secmf** 共振确认：rs90 领先腿再要求板块主力净流入MA20>0。\n')
    f.write('- 覆盖家族：' + '、'.join(f'{f}→{FAM_COVER[f]}' for f in covered) + '。\n')
    f.write('- 跨境主线（港股创新药/中韩半导体/恒生科技/纳指/港美互联网…）A股无板块，资金流口径天然盖不到。\n')
    f.write('\n## 结论（诚实定位）\n\n')
    f.write('1. **绝对口径几乎不触发**：A股板块"主力净流入"长期为负是常态（大单/超大单结构性净卖出、散户接盘），'
            '`MA20>0` 全段仅成交 11 次，rs90+secmf 把 188% 打到 33%——硬门槛过滤掉几乎所有机会。\n')
    f.write('2. **相对口径(横截面取资金最强)好转但仍远逊 rs90**：secmf_rel 73%、rs90+secmf_rel 64%（均 << rs90 188%）。\n')
    f.write('3. **唯一亮点是硬件/产能主线**：半导体设备 secmf_rel 捕获 72%、上车仅涨 17%（rs90 为 44%，且 rs90 对半导体设备捕获仅 2%）、'
            '2026H1 收益 70% ≈ rs90 66%——这类"扩产/资本开支"板块资金会提前点亮。\n')
    f.write('4. **但完全错过通信(2025H2主线，板块资金从未进 top 半区)与全部跨境主线(NA)**，故总收益被拖垮。\n\n')
    f.write('**结论：板块主力净流入在 A股结构性偏负、噪声大、且只覆盖 A股主题，不构成可回测的主线选择器或共振门槛。** '
            '它唯一有边际价值的用法是 **盘中对硬件/产能型 A股主题做"资金提前点亮"预警**（半导体设备类），'
            '应放在 agent 盘中确认层，而非回测选股引擎。至此，量能代理(上一轮)与板块真主力资金(本轮)两类资金因子均已证伪——'
            '**ETF/板块层最优主线选择器仍是价格相对强弱 rs90/rsturn**。\n')

print(f'\n交付：{OUT}/summary_sectorflow_explore.md')
