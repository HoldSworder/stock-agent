#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ETF 主线轮动策略回测（配套 docs/etf-mainline-rotation-strategy.md）。

口径：基准池=ETF模块完整跟踪池 | 横向排名=RS动量20日 | 入场门禁=收盘>MA60 且 RS守领先
      且 RS动量20日≥0.03 | 入场触发=日线MACD金叉 或 追涨 | 出场=Supertrend(10,3)翻空 | 含主线轮换。
数据：a-stock-data sidecar 的 mootdx_kline 端点（通达信本地 TCP，不封 IP，~0.3s/只），
      取数时对 ETF 份额折算做前复权（单日|涨跌|>35% 视为折算）。首次抓取落盘缓存，重跑秒回。

环境变量（均有默认，无需 token 即可跑——K线源不需鉴权）：
  SA_HOST        NAS 局域网 IP（默认 192.168.31.144），用于 a-stock-data:9119 与可选的 /api/etf/pool
  SA_ASTOCK      a-stock-data 基址（默认 http://$SA_HOST:9119）
  SA_APP_TOKEN   NAS 后端 app-token；填了则实时拉取「我的跟踪池」，否则用下方内置清单兜底
  SA_CACHE       K线缓存目录（默认 /tmp/klcache）；删掉即可强制重抓

运行：python3 mode/etf-mainline-rotation/etf-rotation-backtest.py
"""
import json, urllib.request, ssl, math, os, sys, re
from collections import deque, Counter

HOST = os.environ.get('SA_HOST', '192.168.31.144')
ASTOCK = os.environ.get('SA_ASTOCK', f'http://{HOST}:9119')
NAS = f'http://{HOST}:8787/api'
TOKEN = os.environ.get('SA_APP_TOKEN', '')
CACHE = os.environ.get('SA_CACHE', '/tmp/klcache')
os.makedirs(CACHE, exist_ok=True)
WIN = ('2025-01-01', '2026-06-26')
DEFAULT_RANK = 'rsmom20'
DEFAULT_RANK_LABEL = 'RS动量20日'
RS_PERIODS = (20, 40, 60, 90, 120)
MOM = 0.03  # 默认 RS 排名口径入场门槛
MIN_HOLD = 5  # 轮换前最短持有期（交易日），与 docs/etf-mainline-rotation-strategy.md §1.4 一致
TRADE_LOG = os.environ.get('SA_TRADE_LOG', '/tmp/trades_pool.md')
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

# 内置跟踪池兜底（截至 2026-06；填 SA_APP_TOKEN 则改为实时拉取 /api/etf/pool）
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
    # 结构性去重用：把同一赛道的重复 ETF 聚合，减少“同族一起被洗”。
    rules = [
        ('通信', ('通信',)),
        ('芯片半导体', ('芯片', '半导体')),
        ('人工智能', ('人工智能',)),
        ('电池储能', ('电池', '储能')),
        ('电网电力', ('电网', '电力')),
        ('港股创新药', ('港股创新药',)),
        ('港股科技', ('恒生科技', '港股通科技', '港美互联网')),
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
    # 份额折算前复权：单日比值<0.65 或 >1.5（ETF 正常日不可能）判为折算日，折算前 OHLC 整体按比例缩放成连续序列。
    n = len(o)
    if n < 2:
        return o
    factor = [1.0] * n
    for i in range(1, n):
        if o[i - 1]['c'] > 0:
            r = o[i]['c'] / o[i - 1]['c']
            if r < 0.65 or r > 1.5:
                for j in range(i):
                    factor[j] *= r
    for i in range(n):
        if factor[i] != 1.0:
            for k in ('o', 'h', 'l', 'c'):
                o[i][k] *= factor[i]
            o[i]['v'] = o[i]['v'] / factor[i] if factor[i] else o[i]['v']
    return o


def fetch(c):
    fp = f'{CACHE}/{c}.json'
    if os.path.exists(fp):
        return json.load(open(fp))
    try:
        d = get(f'{ASTOCK}/api/call/mootdx_kline?symbol={c}&category=4&offset=800')
        o = [{'d': x['datetime'][:10], 'o': x['open'], 'h': x['high'], 'l': x['low'], 'c': x['close'], 'v': x.get('volume') or 0} for x in (d or [])]
        o.sort(key=lambda x: x['d'])
        o = adjust_splits(o)
    except Exception as e:
        sys.stderr.write(f'fetch fail {c}: {e}\n'); o = []
    json.dump(o, open(fp, 'w')); return o


def ema(v, n):
    k = 2 / (n + 1); o = [v[0]]
    for i in range(1, len(v)):
        o.append(o[-1] + k * (v[i] - o[-1]))
    return o


def sma(v, n):
    o = []; s = 0; q = deque()
    for x in v:
        q.append(x); s += x
        if len(q) > n:
            s -= q.popleft()
        o.append(s / len(q))
    return o


def linreg(ys):
    n = len(ys); xs = list(range(n)); mx = (n - 1) / 2; my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs); sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    if sxx == 0:
        return 0.0, 0.0
    b = sxy / sxx; a = my - b * mx
    sst = sum((y - my) ** 2 for y in ys); ssr = sum((ys[i] - (a + b * xs[i])) ** 2 for i in range(n))
    return b, (1 - ssr / sst if sst > 0 else 0.0)


POOL = load_pool()
bench = fetch('510300')
bclose = {x['d']: x['c'] for x in bench}


def prep(bars):
    c = [b['c'] for b in bars]; h = [b['h'] for b in bars]; l = [b['l'] for b in bars]; v = [b['v'] for b in bars]; n = len(c)
    dif = [ema(c, 12)[i] - ema(c, 26)[i] for i in range(n)]; dea = ema(dif, 9)
    gold = [i > 0 and dif[i] > dea[i] and dif[i - 1] <= dea[i - 1] for i in range(n)]
    ma20 = sma(c, 20); ma60 = sma(c, 60); vma5 = sma(v, 5)
    tr = [h[0] - l[0]]
    for i in range(1, n):
        tr.append(max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))
    atr = sma(tr, 10); fu = [0] * n; fl = [0] * n; d = [1] * n
    for i in range(n):
        hl2 = (h[i] + l[i]) / 2; bu = hl2 + 3 * atr[i]; bl = hl2 - 3 * atr[i]
        if i == 0:
            fu[i], fl[i], d[i] = bu, bl, 1; continue
        fu[i] = bu if (bu < fu[i - 1] or c[i - 1] > fu[i - 1]) else fu[i - 1]
        fl[i] = bl if (bl > fl[i - 1] or c[i - 1] < fl[i - 1]) else fl[i - 1]
        d[i] = 1 if c[i] > fu[i - 1] else (-1 if c[i] < fl[i - 1] else d[i - 1])
    hh20 = [max(c[max(0, i - 19):i + 1]) for i in range(n)]
    slope = [0.0] * n; r2 = [0.0] * n
    for i in range(n):
        seg = [math.log(x) for x in c[max(0, i - 19):i + 1]]
        if len(seg) >= 10:
            b, rr = linreg(seg); slope[i] = b * 252; r2[i] = rr
    o = [b['o'] for b in bars]
    rs = [c[i] / bclose[bars[i]['d']] if bars[i]['d'] in bclose else 1 for i in range(n)]
    rshi = [max(rs[max(0, i - 59):i + 1]) for i in range(n)]
    rsmom = {
        p: [(rs[i] / rs[i - p] - 1) if i >= p and rs[i - p] else 0.0 for i in range(n)]
        for p in RS_PERIODS
    }
    by = {}
    for i, b in enumerate(bars):
        ext = (c[i] - ma20[i]) / ma20[i] if ma20[i] else 0
        chase = (slope[i] >= 0.6 and r2[i] >= 0.55 and ext <= 0.15) or \
                (c[i] >= hh20[i] and (i > 0 and c[i - 1] < hh20[i - 1]) and v[i] > 1.3 * vma5[i] and ext <= 0.15)
        entry = gold[i] or chase
        lead = c[i] > ma60[i] and rs[i] >= rshi[i] * 0.97
        nopen = o[i + 1] if i + 1 < n else c[i]
        moms = {f'rsmom{p}': rsmom[p][i] for p in RS_PERIODS}
        by[b['d']] = dict(c=c[i], entry=entry, st=d[i], lead=lead, nopen=nopen, **moms)
    return by


sys.stderr.write(f'抓取/缓存 {len(POOL)} 只（缓存目录 {CACHE}）...\n')
U = {}
for c in POOL:
    bars = fetch(c)
    if bars and len(bars) > 60:
        U[c] = (POOL[c], prep(bars))
days = [d for d in sorted(bclose) if WIN[0] <= d <= WIN[1]]
di = {d: i for i, d in enumerate(days)}


def run(maxpos, slotw=None, px='close', log=False, rank=DEFAULT_RANK, mom=MOM, switch=0.05, min_hold=MIN_HOLD, family_cap=False):
    if slotw is None:
        slotw = 1.0 / maxpos
    cash = 1.0; pos = {}; tr = 0; sw = 0; eqmax = 0; mdd = 0; rec = []; maxheld = 0
    eq = lambda d: cash + sum(p['a'] * (U[c][1][d]['c'] / p['e']) for c, p in pos.items() if d in U[c][1])
    tx = lambda c, d: U[c][1][d]['nopen'] if px == 'nextopen' else U[c][1][d]['c']
    for d in days:
        for c in list(pos):  # 出场：ST 翻空
            if d in U[c][1] and U[c][1][d]['st'] == -1:
                p = tx(c, d); cash += pos[c]['a'] * (p / pos[c]['e'])
                if log:
                    rec.append((pos[c]['ed'], d, U[c][0], (p / pos[c]['e'] - 1) * 100, 'ST翻空'))
                del pos[c]; tr += 1
        def family_ok(c, replace=None):
            if not family_cap:
                return True
            fam = family(U[c][0])
            return all(family(U[h][0]) != fam for h in pos if h != replace)
        cand = sorted([(U[c][1][d][rank], c) for c in U if c not in pos and d in U[c][1]
                       and U[c][1][d]['entry'] and U[c][1][d]['lead'] and U[c][1][d][rank] >= mom
                       and family_ok(c)], reverse=True)
        if len(pos) >= maxpos and cand:  # 主线轮换：砍最弱换最强
            held = sorted([(U[c][1][d][rank], c) for c in pos if d in U[c][1]])
            if held:
                wrs, wc = held[0]
                repl = [(r, c) for r, c in cand if family_ok(c, replace=wc)]
                brs, bc = repl[0] if repl else (None, None)
                if bc and brs > wrs + switch and (di[d] - pos[wc]['di']) >= min_hold:
                    p = tx(wc, d); cash += pos[wc]['a'] * (p / pos[wc]['e'])
                    if log:
                        rec.append((pos[wc]['ed'], d, U[wc][0], (p / pos[wc]['e'] - 1) * 100, '轮换→' + U[bc][0]))
                    del pos[wc]
                    a = min(eq(d) * slotw, cash); cash -= a
                    pos[bc] = {'a': a, 'e': tx(bc, d), 'di': di[d], 'ed': d}; tr += 2; sw += 1
        if len(pos) < maxpos:  # 补空位：RS动量最强；无合格候选则留现金
            for _, c in cand:
                if len(pos) >= maxpos:
                    break
                if c in pos:
                    continue
                if not family_ok(c):
                    continue
                a = min(eq(d) * slotw, cash)
                if a <= 1e-6:
                    break
                cash -= a; pos[c] = {'a': a, 'e': tx(c, d), 'di': di[d], 'ed': d}; tr += 1
        maxheld = max(maxheld, len(pos))
        e = eq(d); eqmax = max(eqmax, e); mdd = min(mdd, (e / eqmax - 1) * 100)
    last = days[-1]
    for c, p in pos.items():
        if log and last in U[c][1]:
            rec.append((p['ed'], last, U[c][0], (U[c][1][last]['c'] / p['e'] - 1) * 100, '持有中'))
    fin = cash + sum(p['a'] * (U[c][1][last]['c'] / p['e']) for c, p in pos.items() if last in U[c][1])
    years = len(days) / 244; ann = (fin ** (1 / years) - 1) * 100
    return (fin - 1) * 100, ann, mdd, tr, sw, maxheld, rec


def write_trade_log(rec):
    with open(TRADE_LOG, 'w') as f:
        f.write('| 买入日 | 卖出/统计日 | 标的 | 收益 | 原因 |\n')
        f.write('|---|---|---|---:|---|\n')
        for ed, xd, name, pnl, reason in rec:
            f.write(f'| {ed} | {xd} | {name} | {pnl:+.1f}% | {reason} |\n')


def sweep():
    rows = []
    for p in RS_PERIODS:
        for mom in (0.00, 0.02, 0.03, 0.05, 0.08):
            for switch in (0.03, 0.05, 0.08):
                for min_hold in (5, 10, 15):
                    for family_cap in (False, True):
                        t, a, m, trn, swn, mh, _ = run(
                            3, rank=f'rsmom{p}', mom=mom, switch=switch, min_hold=min_hold, family_cap=family_cap,
                        )
                        score = t / max(1, abs(m)) - trn * 0.01
                        rows.append((score, t, m, trn, swn, mh, p, mom, switch, min_hold, family_cap))
    rows.sort(reverse=True)
    print('参数扫描Top20(满仓3只，score=收益/回撤-交易惩罚，仅用于找稳健候选):')
    print(f'{"score":>6}{"收益":>7}{"回撤":>7}{"交易":>6}{"换仓":>6}{"持仓":>6}{"RS":>5}{"门槛":>7}{"轮换":>7}{"持有":>6}{"同族":>6}')
    for score, t, m, trn, swn, mh, p, mom, switch, min_hold, family_cap in rows[:20]:
        print(f'{score:>6.2f}{t:>6.0f}%{m:>6.0f}%{trn:>6}{swn:>6}{mh:>6}{p:>5}{mom:>7.2f}{switch:>7.2f}{min_hold:>6}{str(family_cap):>6}')
    return rows


print(f'载入 {len(U)}/{len(POOL)} | 区间 {days[0]}→{days[-1]} | 默认{DEFAULT_RANK_LABEL}门槛≥{MOM}')
print(f'{"配置":<14}{"总收益":>8}{"年化":>7}{"回撤":>7}{"交易":>6}{"换仓":>6}')
for nm, mp, sw in [('满仓1只', 1, 1.0), ('满仓2只', 2, 0.5), ('满仓3只', 3, 1 / 3),
                   ('3只各28%留16%', 3, 0.28), ('3只各25%留25%', 3, 0.25), ('3只各22%留34%', 3, 0.22),
                   ('2只各40%留20%', 2, 0.40)]:
    t, a, m, trn, swn, mh, _ = run(mp, sw)
    print(f'{nm:<14}{t:>7.0f}%{a:>6.0f}%{m:>6.0f}%{trn:>6}{swn:>6}')
print('次日开盘成交:')
for mp in (2, 3):
    t, a, m, trn, swn, mh, _ = run(mp, None, 'nextopen')
    print(f'  满仓{mp}只 {t:.0f}% / 回撤{m:.0f}%')
print('稳健性频谱(满仓3只，非择优，仅看邻近口径是否同向):')
print(f'{"口径":<16}{"总收益":>8}{"回撤":>7}{"交易":>6}{"最大持仓":>8}')
for label, rank, mom in [('20日门槛0', 'rsmom20', 0.00), ('20日门槛3%', 'rsmom20', 0.03),
                         ('20日门槛5%', 'rsmom20', 0.05), ('60日门槛0', 'rsmom60', 0.00),
                         ('60日门槛3%', 'rsmom60', 0.03)]:
    t, a, m, trn, swn, mh, _ = run(3, rank=rank, mom=mom)
    print(f'{label:<16}{t:>7.0f}%{m:>6.0f}%{trn:>6}{mh:>8}')
if os.environ.get('SA_SWEEP') == '1':
    sweep()
print('同期宽基(躺平):')
for code, nm in [('510300', '沪深300'), ('510500', '中证500'), ('159915', '创业板指'), ('588000', '科创50')]:
    seg = [b for b in fetch(code) if WIN[0] <= b['d'] <= WIN[1]]
    if len(seg) >= 2:
        peak = seg[0]['c']; dd = 0
        for b in seg:
            peak = max(peak, b['c']); dd = min(dd, (b['c'] / peak - 1) * 100)
        print(f'  {nm:<8}{(seg[-1]["c"] / seg[0]["c"] - 1) * 100:>6.0f}% / 回撤{dd:.0f}%')

_, _, _, _, _, mh, rec = run(3, log=True); rec.sort()
write_trade_log(rec)
w = [e for e in rec if e[3] > 0]
print(f'满仓3只交易: {len(rec)}笔 胜率{len(w) / len(rec) * 100:.0f}% 最大盈利{max(e[3] for e in rec):+.0f}% 最大亏损{min(e[3] for e in rec):+.0f}% 最大持仓{mh}只')
prof = Counter()
for e in rec:
    prof[e[2]] += e[3]
print('累计贡献:', ' '.join(f'{n}{v:+.0f}' for n, v in sorted(prof.items(), key=lambda x: -x[1])))
print(f'完整交易记录: {TRADE_LOG}')
