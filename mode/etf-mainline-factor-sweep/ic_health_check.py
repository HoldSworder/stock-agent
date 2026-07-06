#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""因子 IC 体检（只读）。

复用 etf-mainline-factor-sweep-research.py 已算好的因子面板 U，对每个因子做
横截面 Rank IC（Spearman）体检，输出可靠性排行榜。

- 不修改原脚本、不写入 backtest-data，原脚本日志重定向到临时目录。
- IC 定义：每个交易日，跨全部 ETF，计算「当日因子值」与「未来 N 日收益」的
  斯皮尔曼秩相关；对时间序列求均值得到 mean_IC，求稳健性得到 ICIR。

运行：
  python3 mode/etf-mainline-factor-sweep/ic_health_check.py
"""
import os
import sys
import math
import tempfile

# 把原脚本的输出全部重定向到临时目录，避免覆盖真实 backtest-data
_TMP_OUT = tempfile.mkdtemp(prefix='ic_tmp_out_')
os.environ.setdefault('SA_MODE_OUT_DIR', _TMP_OUT)
os.environ['SA_RESEARCH_TRADE_LOG'] = f'{_TMP_OUT}/t.md'
os.environ['SA_RUNNER_TRADE_LOG'] = f'{_TMP_OUT}/r.md'
os.environ['SA_RESEARCH_SUMMARY_LOG'] = f'{_TMP_OUT}/s.md'

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# import 原脚本会触发全量计算+回测（复用 /tmp/klcache 缓存），把它的 stdout 吞掉
_real_stdout = sys.stdout
try:
    sys.stdout = open(os.devnull, 'w')
    import importlib
    research = importlib.import_module('etf-mainline-factor-sweep-research')
finally:
    sys.stdout.close()
    sys.stdout = _real_stdout

U = research.U  # {code: (name, {date: {factor: value, ...}})}

# ---- 配置 ----
FWD_HORIZONS = [5, 10]          # 未来 N 日收益
MIN_NAMES_PER_DAY = 8           # 当日有效横截面样本下限
# 非因子的原始字段/中间量，不参与体检
EXCLUDE = {
    'o', 'h', 'l', 'c', 'amount', 'nopen',
    'ma20', 'ma30', 'ma60', 'ma120', 'atr20', 'atr60',
    'low10prev', 'low20prev', 'hi20prev', 'hi60prev', 'hi120prev',
    'above60', 'above120', 'theme_member_count',
}


def rankdata(xs):
    """平均秩（处理并列）。"""
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(xs):
        j = i
        while j + 1 < len(xs) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def pearson(a, b):
    n = len(a)
    if n < 3:
        return None
    ma = sum(a) / n
    mb = sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((x - mb) ** 2 for x in b)
    if va <= 0 or vb <= 0:
        return None
    cov = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    return cov / math.sqrt(va * vb)


def spearman(a, b):
    return pearson(rankdata(a), rankdata(b))


# ---- 构建未来收益（按收盘价） ----
# fwd[code][date][h] = 未来 h 日收益
fwd = {}
all_dates = set()
for code, (name, by) in U.items():
    dates = sorted(by.keys())
    closes = [by[d]['c'] for d in dates]
    fmap = {}
    for i, d in enumerate(dates):
        all_dates.add(d)
        hh = {}
        for h in FWD_HORIZONS:
            if i + h < len(dates) and closes[i] > 0:
                hh[h] = closes[i + h] / closes[i] - 1.0
            else:
                hh[h] = None
        fmap[d] = hh
    fwd[code] = fmap

trading_days = sorted(all_dates)

# ---- 收集全部候选因子名 ----
factor_names = set()
for code, (name, by) in U.items():
    for d, row in by.items():
        for k, v in row.items():
            if k in EXCLUDE:
                continue
            if isinstance(v, bool):
                continue
            if isinstance(v, (int, float)):
                factor_names.add(k)
factor_names = sorted(factor_names)

# ---- 逐因子逐日算横截面 Rank IC ----
results = []
for fac in factor_names:
    for h in FWD_HORIZONS:
        daily_ic = []
        for d in trading_days:
            xs, ys = [], []
            for code, (name, by) in U.items():
                row = by.get(d)
                if not row or fac not in row:
                    continue
                fv = row[fac]
                if fv is None or isinstance(fv, bool) or not isinstance(fv, (int, float)):
                    continue
                if math.isnan(fv) or math.isinf(fv):
                    continue
                fr = fwd[code][d][h]
                if fr is None:
                    continue
                xs.append(fv)
                ys.append(fr)
            if len(xs) >= MIN_NAMES_PER_DAY:
                ic = spearman(xs, ys)
                if ic is not None:
                    daily_ic.append(ic)
        if len(daily_ic) < 30:
            continue
        n = len(daily_ic)
        mean_ic = sum(daily_ic) / n
        std_ic = math.sqrt(sum((x - mean_ic) ** 2 for x in daily_ic) / n) or 1e-9
        icir = mean_ic / std_ic
        t_stat = icir * math.sqrt(n)
        pos_rate = sum(1 for x in daily_ic if x > 0) / n
        results.append({
            'factor': fac, 'h': h, 'n': n,
            'mean_ic': mean_ic, 'icir': icir, 't': t_stat,
            'pos_rate': pos_rate,
        })

# ---- 输出 ----
print(f'\n样本: {len(U)} 只 ETF | {len(trading_days)} 个交易日 | '
      f'{len(factor_names)} 个候选因子 | 未来收益视角 {FWD_HORIZONS} 日\n')

for h in FWD_HORIZONS:
    rows = [r for r in results if r['h'] == h]
    rows.sort(key=lambda r: r['mean_ic'], reverse=True)
    print('=' * 86)
    print(f'未来 {h} 日收益 —— 因子 Rank IC 排行（mean_IC 降序，正向预测力 Top/Bottom）')
    print('=' * 86)
    print(f"{'排名':>3} {'因子':<32}{'mean_IC':>9}{'ICIR':>8}{'t值':>8}{'正向天数%':>9}")
    print('-' * 86)

    def show(rs, start):
        for idx, r in enumerate(rs, start):
            flag = ''
            if abs(r['t']) >= 3 and abs(r['mean_ic']) >= 0.03:
                flag = ' *强*'
            elif abs(r['t']) >= 2 and abs(r['mean_ic']) >= 0.02:
                flag = ' (有效)'
            print(f"{idx:>3} {r['factor']:<32}{r['mean_ic']:>9.4f}{r['icir']:>8.3f}"
                  f"{r['t']:>8.2f}{r['pos_rate'] * 100:>8.1f}%{flag}")

    show(rows[:25], 1)
    print('   ' + '.' * 40 + '  (中间略)')
    show(rows[-10:], len(rows) - 9)
    print()

# 你回测里的关注因子，在 IC 榜里排第几
WATCH = [
    'mom30_trend_quality_smooth', 'gap_momentum_score', 'anti_exhaustion_score',
    'pvt_confirm_score', 'mom30', 'rs90', 'rs30_trend_quality', 'mom_rs_quality',
    'mom30_trend_quality', 'ensemble_risk_adjusted_score',
]
for h in FWD_HORIZONS:
    rows = [r for r in results if r['h'] == h]
    rows.sort(key=lambda r: r['mean_ic'], reverse=True)
    rank_of = {r['factor']: i for i, r in enumerate(rows, 1)}
    by_name = {r['factor']: r for r in rows}
    total = len(rows)
    print('=' * 86)
    print(f'你的回测冠军因子在「未来{h}日 IC 榜」里的位置（共 {total} 个）')
    print('=' * 86)
    print(f"{'因子':<34}{'IC排名':>8}{'mean_IC':>9}{'t值':>8}{'正向%':>8}")
    print('-' * 86)
    for w in WATCH:
        if w in by_name:
            r = by_name[w]
            print(f"{w:<34}{rank_of[w]:>6}/{total}{r['mean_ic']:>9.4f}"
                  f"{r['t']:>8.2f}{r['pos_rate'] * 100:>7.1f}%")
        else:
            print(f"{w:<34}{'未参与(样本不足)':>20}")
    print()

# 汇总：以 5 日为准，统计达标因子数
base = [r for r in results if r['h'] == 5]
strong = [r for r in base if abs(r['t']) >= 3 and abs(r['mean_ic']) >= 0.03]
ok = [r for r in base if abs(r['t']) >= 2 and abs(r['mean_ic']) >= 0.02]
print('=' * 86)
print('体检小结（未来5日口径）')
print('=' * 86)
print(f'参与体检因子数: {len(base)}')
print(f'强信号 (|t|>=3 且 |mean_IC|>=0.03): {len(strong)} 个')
print(f'有效   (|t|>=2 且 |mean_IC|>=0.02): {len(ok)} 个')
print(f'其余多数为弱/噪声因子。')
