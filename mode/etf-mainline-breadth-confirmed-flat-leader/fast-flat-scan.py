#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fast flatReturn-focused continuation scan for the breadth confirmed leader."""
import heapq
import math
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SWEEP = REPO / 'mode' / 'etf-mainline-factor-sweep' / 'etf-mainline-factor-sweep-research.py'
OUT_DIR = HERE / 'backtest-data'
OUT = OUT_DIR / 'fast_flat_scan_2026-06-30.md'
OUT_DIR.mkdir(parents=True, exist_ok=True)

TMP = tempfile.mkdtemp(prefix='fast_flat_scan_')
os.environ.setdefault('SA_MODE_OUT_DIR', TMP)
for name in (
    'SA_RESEARCH_TRADE_LOG',
    'SA_RUNNER_TRADE_LOG',
    'SA_RUNNER_MAINLINE_TRADE_LOG',
    'SA_TQ_TRADE_LOG',
    'SA_RESEARCH_SUMMARY_LOG',
):
    os.environ[name] = f'{TMP}/{name}.md'


def load_research_prefix():
    ns = {'__file__': str(SWEEP), '__name__': 'fast_flat_scan_prefix'}
    prefix = SWEEP.read_text(encoding='utf-8').split('\ntests = []', 1)[0]
    old_stdout = sys.stdout
    try:
        sys.stdout = open(os.devnull, 'w')
        exec(compile(prefix, str(SWEEP), 'exec'), ns)
    finally:
        sys.stdout.close()
        sys.stdout = old_stdout
    return ns


research = load_research_prefix()
U = research['U']
days = research['days']
family = research['family']
flat_return = research['flat_return']


def valid(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def get(row, key, default=0.0):
    v = row.get(key) if row else None
    return v if valid(v) else default


def score_value(row, score_key):
    v = row.get(score_key) if row else None
    return v if valid(v) else None


def build_rank(score_key, confirm_min, breadth_min, entry_min, risk_on_min, risk_off_max, amount_min):
    ranked_by_day = {}
    for date in days:
        rows = []
        for code, (_, by_date) in U.items():
            row = by_date.get(date)
            if not row or not row.get('above60'):
                continue
            if get(row, 'mainline_persist', -999.0) < confirm_min:
                continue
            if get(row, 'theme_breadth_above120', -999.0) < breadth_min:
                continue
            if get(row, 'theme_amount_power', -999.0) < amount_min:
                continue
            if get(row, 'benchmark_risk_on', 0.0) < risk_on_min:
                continue
            if get(row, 'benchmark_risk_off', 0.0) > risk_off_max:
                continue
            score = score_value(row, score_key)
            if score is None or score < entry_min:
                continue
            rows.append((score, code))
        rows.sort(reverse=True)
        ranked_by_day[date] = rows
    return ranked_by_day


def run(rank, cfg, start=None, end=None, px='close', cost_bps=0.0, log=False):
    rebalance, min_hold, top_exit, protect_gain, protect_dd, exit_min, close_on_no_signal = cfg
    active_days = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    cash = 1.0
    hold = None
    entry = 0.0
    entry_day = ''
    entry_idx = 0
    entry_score = 0.0
    entry_breadth = 0.0
    entry_mom90 = 0.0
    peak_px = 0.0
    equity_peak = 1.0
    mdd = 0.0
    trades = 0
    held_sum = 0
    curve = []
    records = []
    cost = cost_bps / 10000.0

    def price(code, date):
        row = U[code][1][date]
        return row['nopen'] if px == 'nextopen' else row['c']

    def close(date, reason):
        nonlocal cash, hold, peak_px, trades
        sell = price(hold, date)
        pnl = sell / entry * (1 - cost) * (1 - cost) - 1
        if log:
            records.append({
                'entry': entry_day,
                'exit': date,
                'code': hold,
                'name': U[hold][0],
                'entryScore': entry_score,
                'entryBreadth': entry_breadth,
                'entryMom90': entry_mom90,
                'entryClose': entry,
                'exitClose': sell,
                'pnl': pnl * 100,
                'contrib': cash * pnl,
                'reason': reason,
            })
        cash *= sell / entry * (1 - cost)
        hold = None
        peak_px = 0.0
        trades += 1

    for idx, date in enumerate(active_days):
        eq = cash * (U[hold][1][date]['c'] / entry) if hold and date in U[hold][1] else cash
        curve.append(eq)
        equity_peak = max(equity_peak, eq)
        mdd = min(mdd, (eq / equity_peak - 1) * 100)
        held_sum += 1 if hold else 0
        if idx % rebalance != 0:
            continue

        ranked = rank[date]
        best_score, best = ranked[0] if ranked else (None, None)
        if hold:
            row = U[hold][1].get(date)
            cur_score = score_value(row, rank['__score_key__']) if row else None
            cur_score = cur_score if cur_score is not None else -999.0
            in_top = any(code == hold for _, code in ranked[:top_exit]) if ranked else False
            if row:
                peak_px = max(peak_px, row['c'])
            gain = peak_px / entry - 1 if entry else 0.0
            pullback = row['c'] / peak_px - 1 if row and peak_px else 0.0
            if row and gain >= protect_gain and pullback <= -protect_dd:
                close(date, f'盈利保护{protect_gain:.0%}/{protect_dd:.0%}')
            elif row and row['c'] < row['ma120']:
                close(date, '跌破MA120')
            elif row and cur_score < exit_min and idx - entry_idx >= min_hold:
                close(date, f'强度低于{exit_min:.0%}')
            elif close_on_no_signal and not ranked and idx - entry_idx >= min_hold:
                close(date, '候选断档')
            elif ranked and row and best != hold and idx - entry_idx >= min_hold and best_score > cur_score:
                close(date, '强者替换')
            elif ranked and best != hold and idx - entry_idx >= min_hold and not in_top:
                close(date, f'跌出Top{top_exit}')

        if not hold and ranked:
            row = U[best][1][date]
            hold = best
            entry = price(best, date)
            entry_day = date
            entry_idx = idx
            entry_score = best_score
            entry_breadth = get(row, 'theme_breadth_above120', 0.0)
            entry_mom90 = get(row, 'mom90', 0.0)
            peak_px = entry
            cash *= (1 - cost)
            trades += 1

    if hold and active_days:
        last = active_days[-1]
        sell = U[hold][1][last]['c']
        pnl = sell / entry * (1 - cost) * (1 - cost) - 1
        if log:
            records.append({
                'entry': entry_day,
                'exit': last,
                'code': hold,
                'name': U[hold][0],
                'entryScore': entry_score,
                'entryBreadth': entry_breadth,
                'entryMom90': entry_mom90,
                'entryClose': entry,
                'exitClose': sell,
                'pnl': pnl * 100,
                'contrib': cash * pnl,
                'reason': '持有中',
            })
        cash *= sell / entry * (1 - cost)
        trades += 1

    return {
        'ret': (cash - 1) * 100,
        'flat': flat_return(curve),
        'mdd': mdd,
        'trades': trades,
        'held': held_sum / len(active_days) if active_days else 0.0,
        'records': records,
    }


def describe_outer(outer):
    score_key, confirm_min, breadth_min, entry_min, risk_on_min, risk_off_max, amount_min = outer
    return (
        f'{score_key}|mainline_persist>={confirm_min:.2f}|theme_breadth_above120>={breadth_min:.2f}|'
        f'entry_score>={entry_min:.2f}|risk_on>={risk_on_min:.3f}|risk_off<={risk_off_max:.2f}|'
        f'theme_amount_power>={amount_min:.2f}'
    )


def describe_inner(inner):
    rebalance, min_hold, top_exit, protect_gain, protect_dd, exit_min, close_on_no_signal = inner
    gap = 'closeNoSignal' if close_on_no_signal else 'keepNoSignal'
    return f'{rebalance}d|min{min_hold}|top{top_exit}|pg{protect_gain:.0%}|dd{protect_dd:.0%}|exitScore>={exit_min:.2f}|{gap}'


def write_records(path, records):
    rows = sorted(records, key=lambda r: (r['entry'], r['code']))
    with open(path, 'w', encoding='utf-8') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 主题 | 买入强度 | 主题MA120宽度 | 买入90日涨幅 | 收益 | 组合贡献 | 原因 |\n')
        f.write('|---|---|---|---|---|---:|---:|---:|---:|---:|---|\n')
        for r in rows:
            f.write(
                f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {r["name"]} | {family(r["name"])} | '
                f'{r["entryScore"] * 100:+.1f}% | {r["entryBreadth"] * 100:.0f}% | {r["entryMom90"] * 100:+.1f}% | '
                f'{r["pnl"]:+.1f}% | {r["contrib"] * 100:+.1f}% | {r["reason"]} |\n'
            )


score_keys = (
    'anti_exhaustion_score',
    'mom30_trend_quality_smooth',
    'mom30_width_stable',
    'mainline_quality_score',
)
outer_space = [
    (score_key, confirm_min, breadth_min, entry_min, risk_on_min, risk_off_max, amount_min)
    for score_key in score_keys
    for confirm_min in (0.12, 0.15, 0.18)
    for breadth_min in (0.30, 0.40, 0.50)
    for entry_min in (-0.05, 0.00, 0.05, 0.10, 0.15)
    for risk_on_min, risk_off_max in ((0.0, 9.0), (0.0, 0.14), (0.01, 0.10))
    for amount_min in (-9.0, 0.10)
]
inner_space = [
    (4, min_hold, top_exit, protect_gain, protect_dd, exit_min, close_on_no_signal)
    for min_hold in (4, 6, 8)
    for top_exit in (1, 2, 3)
    for protect_gain, protect_dd in ((0.15, 0.06), (0.20, 0.08))
    for exit_min in (-0.05, 0.0)
    for close_on_no_signal in (False, True)
]

best = []
counter = 0
for outer in outer_space:
    score_key = outer[0]
    rank = build_rank(*outer)
    rank['__score_key__'] = score_key
    for inner in inner_space:
        result = run(rank, inner)
        counter += 1
        if result['trades'] < 12 or result['mdd'] < -28 or result['held'] < 0.45:
            continue
        item = (result['flat'], result['ret'], result['mdd'], result['held'], -result['trades'], counter, outer, inner, result)
        if len(best) < 80:
            heapq.heappush(best, item)
        else:
            heapq.heappushpop(best, item)

top = sorted(best, reverse=True)[:30]
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('# fast flatReturn scan 2026-06-30\n\n')
    f.write(f'- ETF池: {len(U)}\n')
    f.write(f'- 交易日: {days[0]} 至 {days[-1]}，共 {len(days)} 日\n')
    f.write(f'- 扫描组合: {counter}\n')
    f.write('- 过滤: 最大持仓 1；交易次数 >= 12；最大回撤不低于 -28%；持仓占比 >= 45%。\n')
    f.write('- 目标: 优先 `flatReturn`，复利收益仅作参考。\n\n')
    f.write('| 排名 | flatReturn | 次开10bp flatReturn | 复利收益 | 最大回撤 | 持仓占比 | 交易 | 分段flatReturn | 外层规则 | 回放规则 |\n')
    f.write('|---:|---:|---:|---:|---:|---:|---:|---|---|---|\n')
    for idx, item in enumerate(top, 1):
        flat, ret, mdd, held, neg_trades, _, outer, inner, _ = item
        rank = build_rank(*outer)
        rank['__score_key__'] = outer[0]
        next10 = run(rank, inner, px='nextopen', cost_bps=10)
        segs = [
            run(rank, inner, '2025-01-02', '2025-06-30')['flat'],
            run(rank, inner, '2025-07-01', '2025-12-31')['flat'],
            run(rank, inner, '2026-01-01', '2026-06-26')['flat'],
        ]
        f.write(
            f'| {idx} | {flat:.1f}% | {next10["flat"]:.1f}% | {ret:.1f}% | {mdd:.1f}% | '
            f'{held:.2f} | {-neg_trades} | '
            f'2025H1 {segs[0]:.1f}% / 2025H2 {segs[1]:.1f}% / 2026H1 {segs[2]:.1f}% | '
            f'`{describe_outer(outer)}` | `{describe_inner(inner)}` |\n'
        )

if top:
    _, _, _, _, _, _, best_outer, best_inner, _ = top[0]
    rank = build_rank(*best_outer)
    rank['__score_key__'] = best_outer[0]
    full = run(rank, best_inner, log=True)
    write_records(OUT_DIR / 'fast_flat_scan_top_trades_2026-06-30.md', full['records'])
    print(
        f'best flat={full["flat"]:.1f}% ret={full["ret"]:.1f}% mdd={full["mdd"]:.1f}% '
        f'trades={full["trades"]} outer={describe_outer(best_outer)} inner={describe_inner(best_inner)}'
    )
print(f'wrote {OUT}')
