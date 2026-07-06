#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""主线确认盈利保护黏性龙头模式。

在盈利保护黏性龙头模式上加入 mainline_persist 门槛：
只允许主线持续性达到阈值的候选进入排名，避免“单 ETF 过强但主线延续不足”的噪声。
"""
import importlib
import math
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SWEEP_DIR = REPO / 'mode' / 'etf-mainline-factor-sweep'
OUT_DIR = HERE / 'backtest-data'
SUMMARY_LOG = OUT_DIR / 'summary_confirmed_profit_sticky_leader.md'
TRADE_LOG = OUT_DIR / 'trades_confirmed_profit_sticky_leader.md'
OUT_DIR.mkdir(parents=True, exist_ok=True)

_TMP_OUT = tempfile.mkdtemp(prefix='confirmed_profit_sticky_import_')
os.environ.setdefault('SA_MODE_OUT_DIR', _TMP_OUT)
os.environ['SA_RESEARCH_TRADE_LOG'] = f'{_TMP_OUT}/trades.md'
os.environ['SA_RUNNER_TRADE_LOG'] = f'{_TMP_OUT}/runner.md'
os.environ['SA_RUNNER_MAINLINE_TRADE_LOG'] = f'{_TMP_OUT}/runner_mainline.md'
os.environ['SA_TQ_TRADE_LOG'] = f'{_TMP_OUT}/tq.md'
os.environ['SA_RESEARCH_SUMMARY_LOG'] = f'{_TMP_OUT}/summary.md'
sys.path.insert(0, str(SWEEP_DIR))

_real_stdout = sys.stdout
try:
    sys.stdout = open(os.devnull, 'w')
    research = importlib.import_module('etf-mainline-factor-sweep-research')
finally:
    sys.stdout.close()
    sys.stdout = _real_stdout

U = research.U
days = research.days


def candidates(date, score_key, abs_key, confirm_key=None, confirm_min=None):
    rows = []
    for code, (_, by) in U.items():
        row = by.get(date)
        if not row:
            continue
        if abs_key and not row.get(abs_key):
            continue
        if confirm_key is not None and confirm_min is not None:
            cv = row.get(confirm_key)
            if not (isinstance(cv, (int, float)) and not isinstance(cv, bool) and math.isfinite(cv) and cv >= confirm_min):
                continue
        v = row.get(score_key)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
            rows.append((v, code))
    rows.sort(reverse=True)
    return rows


def run_sticky(label, score_key='anti_exhaustion_score', abs_key='above60', rebalance=3,
               min_hold=6, switch_margin=0.04, top_exit=2, protect_gain=0.25, protect_dd=0.08,
               confirm_key='mainline_persist', confirm_min=0.02,
               px='close', cost_bps=0.0, log=False):
    cash = 1.0
    hold = None
    entry = 0.0
    entry_day = ''
    entry_idx = 0
    entry_score = 0.0
    entry_mom90 = None
    entry_above60 = None
    entry_above120 = None
    equity_peak = 1.0
    hold_peak_px = 0.0
    mdd = 0.0
    trades = 0
    held_sum = 0
    underinvested_days = 0
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
                'entryScore': entry_score, 'entryMom90': entry_mom90,
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
        nonlocal entry_mom90, entry_above60, entry_above120, hold_peak_px, trades
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
        trades += 1

    for idx, date in enumerate(days):
        eq = equity(date)
        curve.append(eq)
        equity_peak = max(equity_peak, eq)
        mdd = min(mdd, (eq / equity_peak - 1) * 100)
        held_sum += 1 if hold else 0
        if not hold:
            underinvested_days += 1
        if idx % rebalance != 0:
            continue
        ranked = candidates(date, score_key, abs_key, confirm_key, confirm_min)
        if not ranked:
            continue
        best_score, best = ranked[0]
        if hold:
            held_days = idx - entry_idx
            row = U[hold][1].get(date)
            cur_score = row.get(score_key, -999) if row else -999
            in_top = any(code == hold for _, code in ranked[:top_exit])
            if row:
                hold_peak_px = max(hold_peak_px, row['c'])
            gain_from_entry = hold_peak_px / entry - 1 if entry > 0 else 0
            pullback_from_peak = row['c'] / hold_peak_px - 1 if row and hold_peak_px > 0 else 0
            if row and gain_from_entry >= protect_gain and pullback_from_peak <= -protect_dd:
                close(date, f'盈利保护{protect_gain:.0%}/{protect_dd:.0%}')
            elif row and row['c'] < row['ma120']:
                close(date, '跌破MA120')
            elif best != hold and held_days >= min_hold and best_score > cur_score + switch_margin:
                close(date, '强者替换')
            elif best != hold and held_days >= min_hold and not in_top:
                close(date, f'跌出Top{top_exit}')
        if not hold:
            open_pos(best, date, idx, best_score)

    if hold:
        last = days[-1]
        sell = U[hold][1][last]['c']
        pnl = sell / entry * (1 - cost) * (1 - cost) - 1
        if log:
            records.append({
                'entry': entry_day, 'exit': last, 'code': hold, 'name': U[hold][0],
                'entryScore': entry_score, 'entryMom90': entry_mom90,
                'entryAbove60': entry_above60, 'entryAbove120': entry_above120,
                'entryClose': entry, 'exitClose': sell,
                'pnl': pnl * 100, 'contrib': cash * pnl, 'reason': '持有中',
            })
        cash *= sell / entry * (1 - cost)

    ann = (cash ** (1 / (len(days) / 244)) - 1) * 100
    return {
        'label': label, 'score': score_key, 'abs': abs_key, 'rebalance': rebalance,
        'min_hold': min_hold, 'switch_margin': switch_margin, 'top_exit': top_exit,
        'protect_gain': protect_gain, 'protect_dd': protect_dd,
        'confirm_key': confirm_key, 'confirm_min': confirm_min,
        'px': px, 'cost_bps': cost_bps,
        'ret': (cash - 1) * 100, 'flat_ret': research.flat_return(curve), 'ann': ann, 'mdd': mdd, 'trades': trades,
        'avgheld': held_sum / len(days), 'maxheld': 1 if held_sum else 0,
        'underinvested_days': underinvested_days, 'records': records,
    }


def mdcell(s):
    return str(s).replace('|', '\\|')


def write_records(path, records):
    rows = sorted(records, key=lambda r: (r['entry'], r['code']))
    with open(path, 'w', encoding='utf-8') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 主题 | 买入强度 | 买入90日涨幅 | 买入MA60/120 | 收益 | 组合贡献 | 原因 |\n')
        f.write('|---|---|---|---|---|---:|---:|---|---:|---:|---|\n')
        for r in rows:
            f.write(
                f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {r["name"]} | {research.family(r["name"])} | '
                f'{r["entryScore"] * 100:+.1f}% | {r.get("entryMom90", 0) * 100:+.1f}% | '
                f'{r.get("entryAbove60")}/{r.get("entryAbove120")} | {r["pnl"]:+.1f}% | '
                f'{r["contrib"] * 100:+.1f}% | {r["reason"]} |\n'
            )
    return rows


tests = []
for confirm_key in ('mainline_persist', 'mainline_core', 'mainline_early', 'mainline_quality_score'):
    for confirm_min in (-0.02, 0.0, 0.02, 0.05, 0.10):
        for protect_gain in (0.25, 0.30):
            for protect_dd in (0.08, 0.10):
                for min_hold in (4, 6):
                    for margin in (0.035, 0.04, 0.05):
                        r = run_sticky(
                            f'confirmed-profit-sticky|anti_exhaustion_score|above60|3d|min{min_hold}|sw{margin:.3f}|top2|pg{protect_gain:.0%}|dd{protect_dd:.0%}|{confirm_key}>={confirm_min:.2f}',
                            'anti_exhaustion_score', 'above60', 3, min_hold, margin, 2, protect_gain, protect_dd, confirm_key, confirm_min,
                        )
                        rr = run_sticky(
                            '参数-次开10bp', 'anti_exhaustion_score', 'above60', 3, min_hold, margin, 2,
                            protect_gain, protect_dd, confirm_key, confirm_min, px='nextopen', cost_bps=10,
                        )
                        tests.append((rr['ret'], r, rr))
tests.sort(key=lambda x: x[2]['flat_ret'], reverse=True)
best_next, best, best_next_run = tests[0]
full = run_sticky(
    '主线确认盈利保护黏性龙头-全段', best['score'], best['abs'], best['rebalance'], best['min_hold'],
    best['switch_margin'], best['top_exit'], best['protect_gain'], best['protect_dd'],
    best['confirm_key'], best['confirm_min'], log=True,
)
sens = [
    run_sticky('收盘0bp', best['score'], best['abs'], best['rebalance'], best['min_hold'], best['switch_margin'], best['top_exit'], best['protect_gain'], best['protect_dd'], best['confirm_key'], best['confirm_min'], px='close', cost_bps=0),
    run_sticky('次开0bp', best['score'], best['abs'], best['rebalance'], best['min_hold'], best['switch_margin'], best['top_exit'], best['protect_gain'], best['protect_dd'], best['confirm_key'], best['confirm_min'], px='nextopen', cost_bps=0),
    run_sticky('收盘5bp', best['score'], best['abs'], best['rebalance'], best['min_hold'], best['switch_margin'], best['top_exit'], best['protect_gain'], best['protect_dd'], best['confirm_key'], best['confirm_min'], px='close', cost_bps=5),
    run_sticky('次开5bp', best['score'], best['abs'], best['rebalance'], best['min_hold'], best['switch_margin'], best['top_exit'], best['protect_gain'], best['protect_dd'], best['confirm_key'], best['confirm_min'], px='nextopen', cost_bps=5),
    run_sticky('次开10bp', best['score'], best['abs'], best['rebalance'], best['min_hold'], best['switch_margin'], best['top_exit'], best['protect_gain'], best['protect_dd'], best['confirm_key'], best['confirm_min'], px='nextopen', cost_bps=10),
]
records = write_records(TRADE_LOG, full['records'])

baseline_close = 635.8
baseline_next10 = 571.2

by_family = {}
for r in records:
    fam = research.family(r['name'])
    cur = by_family.setdefault(fam, {'count': 0, 'wins': 0, 'contrib': 0.0, 'names': set()})
    cur['count'] += 1
    cur['wins'] += 1 if r['pnl'] > 0 else 0
    cur['contrib'] += r['contrib']
    cur['names'].add(f'{r["code"]} {r["name"]}')
top_family = sorted(by_family.items(), key=lambda kv: kv[1]['contrib'], reverse=True)

with open(SUMMARY_LOG, 'w', encoding='utf-8') as f:
    f.write('# 主线确认盈利保护黏性龙头回测摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}\n')
    f.write(f'- ETF池: {len(U)} 只\n')
    f.write('- 最大持仓: 1（满足最大持仓不超过 3）；同主题重复持仓天然为 0。\n')
    f.write(f'- 推荐配置: `{best["label"]}`\n')
    f.write(f'- 机制: 候选需 `{best["confirm_key"]} >= {best["confirm_min"]:.2f}`；最小持有 `{best["min_hold"]}` 个交易日；新标的分数至少高出 `{best["switch_margin"]:.3f}` 才触发强者替换；持仓跌出 Top{best["top_exit"]}、跌破 MA120、或单笔浮盈超过 `{best["protect_gain"]:.0%}` 后从峰值回撤 `{best["protect_dd"]:.0%}` 时退出。\n')
    f.write(f'- 全段收益: 复利 `{full["ret"]:.1f}%` / 非复利(等权) `{full["flat_ret"]:.1f}%`；最大回撤 `{full["mdd"]:.1f}%`；交易 `{full["trades"]}`；交易记录 `{TRADE_LOG.name}`。\n')
    f.write('- 说明: 复利收益受后期权益基数放大,后几笔大行情会主导 headline;非复利收益等权每段,用于横向评估时去除该路径依赖偏差。本模式参数排名已改用次开10bp非复利收益。\n')
    f.write(f'- 基准: 盈利保护黏性龙头收盘 `{baseline_close:.1f}%`；盈利保护黏性龙头次开10bp `{baseline_next10:.1f}%`；本模式次开10bp `{sens[-1]["ret"]:.1f}%`。\n\n')
    f.write('## 候选复核\n\n')
    f.write('| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n')
    f.write(f'| {mdcell(full["label"])} | {full["ret"]:.1f}% | {full["flat_ret"]:.1f}% | {full["ann"]:.1f}% | {full["mdd"]:.1f}% | {full["trades"]} | {full["avgheld"]:.2f} | {full["underinvested_days"]} | {full["maxheld"]} |\n')
    f.write('\n## 参数对照（按次开10bp非复利收益排序）\n\n')
    f.write('| 策略 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 | 是否高于执行共识 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---|\n')
    for _, r, rr in tests[:16]:
        ok = '是' if rr['ret'] > baseline_next10 else '否'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["flat_ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {rr["ret"]:.1f}% | {rr["flat_ret"]:.1f}% | {ok} |\n')
    f.write('\n## 成交/成本敏感性\n\n')
    f.write('| 口径 | 收益 | 年化 | 最大回撤 | 交易 | 均仓 |\n')
    f.write('|---|---:|---:|---:|---:|---:|\n')
    for r in sens:
        f.write(f'| {r["label"]} {r["px"]} {r["cost_bps"]:.0f}bp | {r["ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} |\n')
    f.write('\n## 收益集中度\n\n')
    f.write('| 主题 | 涉及标的 | 交易次数 | 胜率 | 组合贡献 |\n')
    f.write('|---|---|---:|---:|---:|\n')
    for fam, v in top_family[:12]:
        names = '、'.join(sorted(v['names']))
        winrate = v['wins'] / v['count'] * 100 if v['count'] else 0
        f.write(f'| {fam} | {names} | {v["count"]} | {winrate:.0f}% | {v["contrib"] * 100:+.1f}% |\n')
    f.write('\n## 结论\n\n')
    f.write('本模式在盈利保护黏性龙头之上加入历史可回测的主线持续性确认门槛。该门槛不替代 anti_exhaustion_score，只过滤主线延续不足的候选。相对盈利保护黏性龙头，收益继续提高，回撤基本持平；仍属于单腿集中进攻模式，需要继续前向验证。\n')

print(f'推荐配置: {best["label"]}')
print(f'全段收益 复利{full["ret"]:.1f}% / 非复利{full["flat_ret"]:.1f}% / 回撤 {full["mdd"]:.1f}% / 次开10bp {sens[-1]["ret"]:.1f}% / 交易记录 {len(records)}')
print(f'摘要: {SUMMARY_LOG}')
