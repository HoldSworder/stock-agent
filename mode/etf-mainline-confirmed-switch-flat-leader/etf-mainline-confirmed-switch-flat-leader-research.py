#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Confirmed-switch flatReturn leader.

在 breadth-confirmed 冠军模式基础上，只修改强者替换：
新强者需要连续确认 2 次且强度领先 0.06 后才替换，减少单次排名跳动带来的误切。
"""
import collections
import math
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SWEEP = REPO / 'mode' / 'etf-mainline-factor-sweep' / 'etf-mainline-factor-sweep-research.py'
OUT_DIR = HERE / 'backtest-data'
SUMMARY_LOG = OUT_DIR / 'summary_confirmed_switch_flat_leader.md'
TRADE_LOG = OUT_DIR / 'trades_confirmed_switch_flat_leader.md'
OUT_DIR.mkdir(parents=True, exist_ok=True)

TMP = tempfile.mkdtemp(prefix='confirmed_switch_flat_')
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
    ns = {'__file__': str(SWEEP), '__name__': 'confirmed_switch_flat_prefix'}
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


def candidates(date, confirm_min=0.15, breadth_min=0.50, amount_min=0.10):
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
        score = get(row, 'anti_exhaustion_score', None)
        if score is None:
            continue
        rows.append((score, code))
    rows.sort(reverse=True)
    return rows


def run_mode(label, rebalance=4, min_hold=8, top_exit=1, protect_gain=0.15, protect_dd=0.06,
             confirm_min=0.15, breadth_min=0.50, amount_min=0.10, switch_margin=0.06,
             confirm_hits=2, lookback=2, need_topk=2, exit_ma='ma120',
             start=None, end=None, px='close', cost_bps=0.0, log=False):
    active_days = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    cash = 1.0
    hold = None
    entry = 0.0
    entry_day = ''
    entry_idx = 0
    entry_score = 0.0
    entry_mom90 = 0.0
    entry_breadth = 0.0
    peak = 0.0
    equity_peak = 1.0
    mdd = 0.0
    trades = 0
    held_sum = 0
    curve = []
    records = []
    pending = None
    pending_count = 0
    history = collections.deque(maxlen=max(lookback, 1))
    cost = cost_bps / 10000.0

    def price(code, date):
        row = U[code][1][date]
        return row['nopen'] if px == 'nextopen' else row['c']

    def equity(date):
        if hold and date in U[hold][1]:
            return cash * (U[hold][1][date]['c'] / entry)
        return cash

    def close(date, reason):
        nonlocal cash, hold, peak, trades
        sell = price(hold, date)
        pnl = sell / entry * (1 - cost) * (1 - cost) - 1
        if log:
            records.append({
                'entry': entry_day,
                'exit': date,
                'code': hold,
                'name': U[hold][0],
                'family': family(U[hold][0]),
                'entryScore': entry_score,
                'entryMom90': entry_mom90,
                'entryBreadth': entry_breadth,
                'entryClose': entry,
                'exitClose': sell,
                'pnl': pnl * 100,
                'contrib': cash * pnl,
                'reason': reason,
            })
        cash *= sell / entry * (1 - cost)
        hold = None
        peak = 0.0
        trades += 1

    def open_pos(code, date, idx, score):
        nonlocal cash, hold, entry, entry_day, entry_idx, entry_score, entry_mom90, entry_breadth, peak, trades
        row = U[code][1][date]
        cash *= (1 - cost)
        hold = code
        entry = price(code, date)
        entry_day = date
        entry_idx = idx
        entry_score = score
        entry_mom90 = get(row, 'mom90', 0.0)
        entry_breadth = get(row, 'theme_breadth_above120', 0.0)
        peak = entry
        trades += 1

    for idx, date in enumerate(active_days):
        eq = equity(date)
        curve.append(eq)
        equity_peak = max(equity_peak, eq)
        mdd = min(mdd, (eq / equity_peak - 1) * 100)
        held_sum += 1 if hold else 0
        if idx % rebalance != 0:
            continue

        ranked = candidates(date, confirm_min, breadth_min, amount_min)
        if not ranked:
            continue
        history.append(set(code for _, code in ranked[:max(need_topk, top_exit, 3)]))
        best_score, best = ranked[0]
        if hold:
            held_days = idx - entry_idx
            row = U[hold][1].get(date)
            cur_score = get(row, 'anti_exhaustion_score', -999.0) if row else -999.0
            in_top = any(code == hold for _, code in ranked[:top_exit])
            if row:
                peak = max(peak, row['c'])
            gain = peak / entry - 1 if entry else 0.0
            pullback = row['c'] / peak - 1 if row and peak else 0.0

            if row and gain >= protect_gain and pullback <= -protect_dd:
                close(date, f'盈利保护{protect_gain:.0%}/{protect_dd:.0%}')
                pending = None
                pending_count = 0
            elif row and exit_ma and row['c'] < row[exit_ma]:
                close(date, f'跌破{exit_ma.upper()}')
                pending = None
                pending_count = 0
            elif best != hold and held_days >= min_hold:
                eligible = True
                if lookback > 1 and len(history) >= lookback:
                    eligible = sum(1 for h in history if best in h) >= min(confirm_hits, lookback)
                if best_score > cur_score + switch_margin and eligible:
                    if pending == best:
                        pending_count += 1
                    else:
                        pending = best
                        pending_count = 1
                    if pending_count >= confirm_hits:
                        close(date, '连续确认强者替换')
                elif not in_top:
                    close(date, f'跌出Top{top_exit}')
                else:
                    pending = None
                    pending_count = 0

        if not hold:
            open_pos(best, date, idx, best_score)
            pending = None
            pending_count = 0

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
                'family': family(U[hold][0]),
                'entryScore': entry_score,
                'entryMom90': entry_mom90,
                'entryBreadth': entry_breadth,
                'entryClose': entry,
                'exitClose': sell,
                'pnl': pnl * 100,
                'contrib': cash * pnl,
                'reason': '持有中',
            })
        cash *= sell / entry * (1 - cost)
        trades += 1

    ann = (cash ** (1 / (len(active_days) / 244)) - 1) * 100 if active_days else 0.0
    return {
        'label': label,
        'ret': (cash - 1) * 100,
        'flat': flat_return(curve),
        'ann': ann,
        'mdd': mdd,
        'trades': trades,
        'held': held_sum / len(active_days) if active_days else 0.0,
        'underinvested_days': len(active_days) - held_sum,
        'maxheld': 1 if held_sum else 0,
        'records': records,
    }


def mdcell(s):
    return str(s).replace('|', '\\|')


def write_records(path, records):
    rows = sorted(records, key=lambda r: (r['entry'], r['code']))
    with open(path, 'w', encoding='utf-8') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 主题 | 买入强度 | 主题MA120宽度 | 买入90日涨幅 | 收益 | 组合贡献 | 原因 |\n')
        f.write('|---|---|---|---|---|---:|---:|---:|---:|---:|---|\n')
        for r in rows:
            f.write(
                f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {r["name"]} | {r["family"]} | '
                f'{r["entryScore"] * 100:+.1f}% | {r["entryBreadth"] * 100:.0f}% | {r["entryMom90"] * 100:+.1f}% | '
                f'{r["pnl"]:+.1f}% | {r["contrib"] * 100:+.1f}% | {r["reason"]} |\n'
            )
    return rows


RECOMMENDED = {
    'rebalance': 4,
    'min_hold': 8,
    'top_exit': 1,
    'protect_gain': 0.15,
    'protect_dd': 0.06,
    'confirm_min': 0.15,
    'breadth_min': 0.50,
    'amount_min': 0.10,
    'switch_margin': 0.06,
    'confirm_hits': 2,
    'lookback': 2,
    'need_topk': 2,
    'exit_ma': 'ma120',
}
CONFIG = 'confirmed-switch-flat|anti_exhaustion_score|above60|4d|min8|top1|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10|switch_margin=0.06|confirm2of2'

full = run_mode('连续确认强者替换非复利主线龙头-全段', **RECOMMENDED, log=True)
next10 = run_mode('次开10bp', **RECOMMENDED, px='nextopen', cost_bps=10)
records = write_records(TRADE_LOG, full['records'])
segments = []
for label, start, end in (
    ('2025H1', '2025-01-02', '2025-06-30'),
    ('2025H2', '2025-07-01', '2025-12-31'),
    ('2026H1', '2026-01-01', '2026-06-26'),
):
    close = run_mode(label, **RECOMMENDED, start=start, end=end)
    nxt = run_mode(label, **RECOMMENDED, start=start, end=end, px='nextopen', cost_bps=10)
    segments.append((label, close, nxt))

with open(SUMMARY_LOG, 'w', encoding='utf-8') as f:
    f.write('# 连续确认强者替换非复利主线龙头回测摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}\n')
    f.write(f'- ETF池: {len(U)} 只\n')
    f.write('- 最大持仓: 1；满足最大持仓不超过 3；同一时间不会重复持有同主题 ETF。\n')
    f.write(f'- 推荐候选: `{CONFIG}`\n')
    f.write('- 机制: 候选仍按 `anti_exhaustion_score` 排名；新强者需连续 2 次确认且领先当前持仓 0.06 才替换。\n')
    f.write(f'- 全段收益: 复利 `{full["ret"]:.1f}%` / 非复利 `{full["flat"]:.1f}%`；最大回撤 `{full["mdd"]:.1f}%`；交易 `{full["trades"]}`；持仓占比 `{full["held"]:.2f}`。\n')
    f.write(f'- 执行口径: 次开 10bp 复利 `{next10["ret"]:.1f}%` / 非复利 `{next10["flat"]:.1f}%`。\n')
    f.write(f'- 交易记录: `{TRADE_LOG.name}`\n\n')
    f.write('## 候选复核\n\n')
    f.write('| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n')
    f.write(
        f'| 连续确认强者替换非复利主线龙头-全段 | {full["ret"]:.1f}% | {full["flat"]:.1f}% | {full["ann"]:.1f}% | '
        f'{full["mdd"]:.1f}% | {full["trades"]} | {full["held"]:.2f} | {full["underinvested_days"]} | {full["maxheld"]} |\n\n'
    )
    f.write('## 分段复核\n\n')
    f.write('| 区间 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|\n')
    for label, close, nxt in segments:
        f.write(f'| {label} | {close["ret"]:.1f}% | {close["flat"]:.1f}% | {close["mdd"]:.1f}% | {close["trades"]} | {nxt["ret"]:.1f}% | {nxt["flat"]:.1f}% |\n')
    f.write('\n## 结论\n\n')
    f.write('该模式收盘 flatReturn 略高于当前 breadth-confirmed 基准，但优势只有约 0.1 个百分点，且次开 10bp 口径没有改善。因此暂作为实验候选保留，不直接替代推荐模式。\n')

print(
    f'flat={full["flat"]:.1f}% ret={full["ret"]:.1f}% next10_flat={next10["flat"]:.1f}% '
    f'mdd={full["mdd"]:.1f}% trades={full["trades"]}'
)
print(f'summary={SUMMARY_LOG}')
print(f'trades={TRADE_LOG}')
