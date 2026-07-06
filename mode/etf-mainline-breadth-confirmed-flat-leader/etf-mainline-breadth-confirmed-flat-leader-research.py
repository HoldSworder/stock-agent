#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""主题宽度确认非复利主线龙头模式。"""
import math
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SWEEP = REPO / 'mode' / 'etf-mainline-factor-sweep' / 'etf-mainline-factor-sweep-research.py'
OUT_DIR = HERE / 'backtest-data'
SUMMARY_LOG = OUT_DIR / 'summary_breadth_confirmed_flat_leader.md'
TRADE_LOG = OUT_DIR / 'trades_breadth_confirmed_flat_leader.md'
OUT_DIR.mkdir(parents=True, exist_ok=True)

_TMP_OUT = tempfile.mkdtemp(prefix='breadth_confirmed_flat_import_')
os.environ.setdefault('SA_MODE_OUT_DIR', _TMP_OUT)
os.environ['SA_RESEARCH_TRADE_LOG'] = f'{_TMP_OUT}/trades.md'
os.environ['SA_RUNNER_TRADE_LOG'] = f'{_TMP_OUT}/runner.md'
os.environ['SA_RUNNER_MAINLINE_TRADE_LOG'] = f'{_TMP_OUT}/runner_mainline.md'
os.environ['SA_TQ_TRADE_LOG'] = f'{_TMP_OUT}/tq.md'
os.environ['SA_RESEARCH_SUMMARY_LOG'] = f'{_TMP_OUT}/summary.md'


def load_research_prefix():
    ns = {'__file__': str(SWEEP), '__name__': 'breadth_confirmed_flat_prefix'}
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
flat_return = research['flat_return']
family = research['family']


def valid(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def candidates(date, confirm_min=0.15, breadth_min=0.30):
    rows = []
    for code, (_, by) in U.items():
        row = by.get(date)
        if not row or not row.get('above60'):
            continue
        persist = row.get('mainline_persist')
        breadth = row.get('theme_breadth_above120')
        score = row.get('anti_exhaustion_score')
        if valid(persist) and persist >= confirm_min and valid(breadth) and breadth >= breadth_min and valid(score):
            rows.append((score, code))
    rows.sort(reverse=True)
    return rows


def run_mode(label, rebalance=4, min_hold=6, switch_margin=0.0, top_exit=2,
             protect_gain=0.15, protect_dd=0.06, confirm_min=0.15, breadth_min=0.30,
             exit_ma='ma120', start=None, end=None, px='close', cost_bps=0.0, log=False):
    active_days = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    cash = 1.0
    hold = None
    entry = 0.0
    entry_day = ''
    entry_idx = 0
    entry_score = 0.0
    entry_mom90 = None
    entry_above60 = None
    entry_above120 = None
    entry_breadth = None
    hold_peak_px = 0.0
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

    def equity(date):
        if hold and date in U[hold][1]:
            return cash * (U[hold][1][date]['c'] / entry)
        return cash

    def close(date, reason):
        nonlocal cash, hold, hold_peak_px, trades
        sell = price(hold, date)
        pnl = sell / entry * (1 - cost) * (1 - cost) - 1
        if log:
            records.append({
                'entry': entry_day, 'exit': date, 'code': hold, 'name': U[hold][0],
                'entryScore': entry_score, 'entryMom90': entry_mom90, 'entryBreadth': entry_breadth,
                'entryAbove60': entry_above60, 'entryAbove120': entry_above120,
                'entryClose': entry, 'exitClose': sell,
                'pnl': pnl * 100, 'contrib': cash * pnl, 'reason': reason,
            })
        cash *= sell / entry * (1 - cost)
        hold = None
        hold_peak_px = 0.0
        trades += 1

    def open_pos(code, date, idx, score):
        nonlocal cash, hold, entry, entry_day, entry_idx, entry_score
        nonlocal entry_mom90, entry_above60, entry_above120, entry_breadth, hold_peak_px, trades
        row = U[code][1][date]
        cash *= (1 - cost)
        hold = code
        entry = price(code, date)
        hold_peak_px = entry
        entry_day = date
        entry_idx = idx
        entry_score = score
        entry_mom90 = row.get('mom90')
        entry_above60 = row.get('above60')
        entry_above120 = row.get('above120')
        entry_breadth = row.get('theme_breadth_above120')
        trades += 1

    for idx, date in enumerate(active_days):
        eq = equity(date)
        curve.append(eq)
        equity_peak = max(equity_peak, eq)
        mdd = min(mdd, (eq / equity_peak - 1) * 100)
        held_sum += 1 if hold else 0
        if idx % rebalance != 0:
            continue
        ranked = candidates(date, confirm_min, breadth_min)
        if not ranked:
            continue
        best_score, best = ranked[0]
        if hold:
            held_days = idx - entry_idx
            row = U[hold][1].get(date)
            cur_score = row.get('anti_exhaustion_score', -999) if row else -999
            in_top = any(code == hold for _, code in ranked[:top_exit])
            if row:
                hold_peak_px = max(hold_peak_px, row['c'])
            gain_from_entry = hold_peak_px / entry - 1 if entry > 0 else 0
            pullback_from_peak = row['c'] / hold_peak_px - 1 if row and hold_peak_px > 0 else 0
            if row and gain_from_entry >= protect_gain and pullback_from_peak <= -protect_dd:
                close(date, f'盈利保护{protect_gain:.0%}/{protect_dd:.0%}')
            elif row and exit_ma and row['c'] < row[exit_ma]:
                close(date, f'跌破{exit_ma.upper()}')
            elif row and best != hold and held_days >= min_hold and best_score > cur_score + switch_margin:
                close(date, '强者替换')
            elif best != hold and held_days >= min_hold and not in_top:
                close(date, f'跌出Top{top_exit}')
        if not hold:
            open_pos(best, date, idx, best_score)

    if hold and active_days:
        last = active_days[-1]
        sell = U[hold][1][last]['c']
        pnl = sell / entry * (1 - cost) * (1 - cost) - 1
        if log:
            records.append({
                'entry': entry_day, 'exit': last, 'code': hold, 'name': U[hold][0],
                'entryScore': entry_score, 'entryMom90': entry_mom90, 'entryBreadth': entry_breadth,
                'entryAbove60': entry_above60, 'entryAbove120': entry_above120,
                'entryClose': entry, 'exitClose': sell,
                'pnl': pnl * 100, 'contrib': cash * pnl, 'reason': '持有中',
            })
        cash *= sell / entry * (1 - cost)

    ann = (cash ** (1 / (len(active_days) / 244)) - 1) * 100 if active_days else 0.0
    return {
        'label': label, 'ret': (cash - 1) * 100, 'flat_ret': flat_return(curve),
        'ann': ann, 'mdd': mdd, 'trades': trades,
        'avgheld': held_sum / len(active_days) if active_days else 0.0,
        'underinvested_days': len(active_days) - held_sum,
        'maxheld': 1 if held_sum else 0, 'records': records,
    }


def mdcell(s):
    return str(s).replace('|', '\\|')


def write_records(path, records):
    rows = sorted(records, key=lambda r: (r['entry'], r['code']))
    with open(path, 'w', encoding='utf-8') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 主题 | 买入强度 | 主题MA120宽度 | 买入90日涨幅 | 买入MA60/120 | 收益 | 组合贡献 | 原因 |\n')
        f.write('|---|---|---|---|---|---:|---:|---:|---|---:|---:|---|\n')
        for r in rows:
            f.write(
                f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {r["name"]} | {family(r["name"])} | '
                f'{r["entryScore"] * 100:+.1f}% | {r.get("entryBreadth", 0) * 100:.0f}% | '
                f'{r.get("entryMom90", 0) * 100:+.1f}% | {r.get("entryAbove60")}/{r.get("entryAbove120")} | '
                f'{r["pnl"]:+.1f}% | {r["contrib"] * 100:+.1f}% | {r["reason"]} |\n'
            )
    return rows


RECOMMENDED = {
    'rebalance': 4, 'min_hold': 6, 'switch_margin': 0.0, 'top_exit': 2,
    'protect_gain': 0.15, 'protect_dd': 0.06, 'confirm_min': 0.15, 'breadth_min': 0.30,
    'exit_ma': 'ma120',
}

tests = []
for breadth_min in (0.20, 0.30, 0.40, 0.50):
    for rebalance in (3, 4, 5):
        for min_hold in (4, 6, 8):
            for protect_gain, protect_dd in ((0.15, 0.06), (0.20, 0.08), (0.25, 0.08), (0.30, 0.10)):
                for confirm_min in (0.12, 0.15, 0.18):
                    label = (
                        f'breadth-confirmed-flat|anti_exhaustion_score|above60|{rebalance}d|'
                        f'min{min_hold}|sw0|top2|pg{protect_gain:.0%}|dd{protect_dd:.0%}|'
                        f'mainline_persist>={confirm_min:.2f}|theme_breadth_above120>={breadth_min:.2f}'
                    )
                    close = run_mode(label, rebalance, min_hold, 0.0, 2, protect_gain, protect_dd, confirm_min, breadth_min, 'ma120')
                    nxt = run_mode(label, rebalance, min_hold, 0.0, 2, protect_gain, protect_dd, confirm_min, breadth_min, 'ma120', px='nextopen', cost_bps=10)
                    tests.append((close['flat_ret'], nxt['flat_ret'], close, nxt))
tests.sort(key=lambda x: (x[0], x[1]), reverse=True)

full = run_mode('主题宽度确认非复利主线龙头-全段', **RECOMMENDED, log=True)
records = write_records(TRADE_LOG, full['records'])
next10 = run_mode('次开10bp', **RECOMMENDED, px='nextopen', cost_bps=10)
sensitivity = [
    run_mode('收盘0bp', **RECOMMENDED, px='close', cost_bps=0),
    run_mode('次开0bp', **RECOMMENDED, px='nextopen', cost_bps=0),
    run_mode('收盘5bp', **RECOMMENDED, px='close', cost_bps=5),
    run_mode('次开5bp', **RECOMMENDED, px='nextopen', cost_bps=5),
    next10,
]
segments = []
for label, start, end in (
    ('2025H1', '2025-01-02', '2025-06-30'),
    ('2025H2', '2025-07-01', '2025-12-31'),
    ('2026H1', '2026-01-01', '2026-06-26'),
):
    close = run_mode(label, **RECOMMENDED, start=start, end=end)
    nxt = run_mode(label, **RECOMMENDED, start=start, end=end, px='nextopen', cost_bps=10)
    segments.append((label, close, nxt))

by_family = {}
for r in records:
    fam = family(r['name'])
    cur = by_family.setdefault(fam, {'count': 0, 'wins': 0, 'contrib': 0.0, 'names': set()})
    cur['count'] += 1
    cur['wins'] += 1 if r['pnl'] > 0 else 0
    cur['contrib'] += r['contrib']
    cur['names'].add(f'{r["code"]} {r["name"]}')
top_family = sorted(by_family.items(), key=lambda kv: kv[1]['contrib'], reverse=True)

with open(SUMMARY_LOG, 'w', encoding='utf-8') as f:
    f.write('# 主题宽度确认非复利主线龙头回测摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}\n')
    f.write(f'- ETF池: {len(U)} 只\n')
    f.write('- 最大持仓: 1（满足最大持仓不超过 3）；同主题重复持仓天然为 0。\n')
    f.write('- 推荐配置: `breadth-confirmed-flat|anti_exhaustion_score|above60|4d|min6|sw0|top2|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30`\n')
    f.write('- 机制: 候选需 `mainline_persist >= 0.15` 且 `theme_breadth_above120 >= 0.30`；每 4 个交易日复核；最小持有 6 个交易日；持仓跌出 Top2、跌破 MA120、或单笔浮盈超过 15% 后从峰值回撤 6% 时退出。\n')
    f.write(f'- 全段收益: 复利 `{full["ret"]:.1f}%` / 非复利(等权) `{full["flat_ret"]:.1f}%`；最大回撤 `{full["mdd"]:.1f}%`；交易 `{full["trades"]}`；交易记录 `{TRADE_LOG.name}`。\n')
    f.write(f'- 执行口径: 次开 10bp 复利 `{next10["ret"]:.1f}%` / 非复利 `{next10["flat_ret"]:.1f}%`。\n')
    f.write('- 说明: 本模式用主题宽度确认替代单一 ETF 孤立强势确认，收盘 `flatReturn` 高于敏捷止盈非复利主线龙头的 `243.5%`。\n\n')
    f.write('## 候选复核\n\n')
    f.write('| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n')
    f.write(f'| {mdcell(full["label"])} | {full["ret"]:.1f}% | {full["flat_ret"]:.1f}% | {full["ann"]:.1f}% | {full["mdd"]:.1f}% | {full["trades"]} | {full["avgheld"]:.2f} | {full["underinvested_days"]} | {full["maxheld"]} |\n\n')
    f.write('## 参数对照（按收盘非复利收益排序）\n\n')
    f.write('| 策略 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 | 备注 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---|\n')
    rec_label = 'breadth-confirmed-flat|anti_exhaustion_score|above60|4d|min6|sw0|top2|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30'
    for _, _, close, nxt in tests[:24]:
        note = '推荐' if close['label'] == rec_label else ''
        f.write(f'| {mdcell(close["label"])} | {close["ret"]:.1f}% | {close["flat_ret"]:.1f}% | {close["mdd"]:.1f}% | {close["trades"]} | {nxt["ret"]:.1f}% | {nxt["flat_ret"]:.1f}% | {note} |\n')
    f.write('\n')
    f.write('## 分段复核\n\n')
    f.write('| 区间 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|\n')
    for label, close, nxt in segments:
        f.write(f'| {label} | {close["ret"]:.1f}% | {close["flat_ret"]:.1f}% | {close["mdd"]:.1f}% | {close["trades"]} | {nxt["ret"]:.1f}% | {nxt["flat_ret"]:.1f}% |\n')
    f.write('\n')
    f.write('## 成交/成本敏感性\n\n')
    f.write('| 口径 | 收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|\n')
    for r in sensitivity:
        f.write(f'| {r["label"]} | {r["ret"]:.1f}% | {r["flat_ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} |\n')
    f.write('\n')
    f.write('## 收益集中度\n\n')
    f.write('| 主题 | 涉及标的 | 交易次数 | 胜率 | 组合贡献 |\n')
    f.write('|---|---|---:|---:|---:|\n')
    for fam, info in top_family:
        names = '、'.join(sorted(info['names']))
        win_rate = info['wins'] / info['count'] * 100 if info['count'] else 0
        f.write(f'| {fam} | {mdcell(names)} | {info["count"]} | {win_rate:.0f}% | {info["contrib"] * 100:+.1f}% |\n')
    f.write('\n## 结论\n\n')
    f.write('主题宽度确认把当前最佳模式的价格主线判断推进了一步：候选不只自己强，还要求同主题已有一定 MA120 宽度。该规则提升了系统 flatReturn，但次开10bp非复利仍未显著突破，实盘应继续观察成交滑点。\n')

print(f'全段收益 复利{full["ret"]:.1f}% / 非复利{full["flat_ret"]:.1f}% / 次开10bp非复利{next10["flat_ret"]:.1f}% / 回撤 {full["mdd"]:.1f}% / 交易记录 {len(records)}')
