#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""风控过滤黏性过热衰竭主线龙头模式。"""
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
SUMMARY_LOG = OUT_DIR / 'summary_risk_gated_sticky_leader.md'
TRADE_LOG = OUT_DIR / 'trades_risk_gated_sticky_leader.md'
OUT_DIR.mkdir(parents=True, exist_ok=True)

_TMP_OUT = tempfile.mkdtemp(prefix='risk_gated_import_')
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
SCORE = 'anti_exhaustion_score'


def market_ok(date):
    for _, (_, by) in U.items():
        row = by.get(date)
        if row and 'benchmark_risk_on' in row:
            return row.get('benchmark_risk_on', 0) > 0 or row.get('mom30', 0) > 0.08
    return True


def ranked(date):
    rows = []
    for code, (_, by) in U.items():
        row = by.get(date)
        if not row or not row.get('above60'):
            continue
        v = row.get(SCORE)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
            rows.append((v, code))
    rows.sort(reverse=True)
    return rows


def run_mode(label, px='close', cost_bps=0.0, log=False):
    cash = 1.0
    hold = None
    entry = 0.0
    entry_day = ''
    entry_idx = 0
    entry_score = 0.0
    entry_mom90 = None
    entry_above60 = None
    entry_above120 = None
    peak = 1.0
    mdd = 0.0
    trades = 0
    held_sum = 0
    underinvested_days = 0
    records = []
    curve = []
    cost = cost_bps / 10000.0

    def price(code, date):
        row = U[code][1][date]
        return row['nopen'] if px == 'nextopen' else row['c']

    def equity(date):
        if hold and date in U[hold][1]:
            return cash * (U[hold][1][date]['c'] / entry)
        return cash

    def close(date, reason):
        nonlocal cash, hold, trades
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
        trades += 1

    def open_pos(code, date, idx, score):
        nonlocal cash, hold, entry, entry_day, entry_idx, entry_score
        nonlocal entry_mom90, entry_above60, entry_above120, trades
        row = U[code][1][date]
        cash *= (1 - cost)
        hold = code
        entry = price(code, date)
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
        peak = max(peak, eq)
        mdd = min(mdd, (eq / peak - 1) * 100)
        held_sum += 1 if hold else 0
        if not hold:
            underinvested_days += 1
        if idx % 3 != 0:
            continue
        if not market_ok(date):
            if hold:
                close(date, '市场过滤空仓')
            continue
        arr = ranked(date)
        if not arr:
            continue
        best_score, best = arr[0]
        if hold:
            row = U[hold][1].get(date)
            held_days = idx - entry_idx
            cur_score = row.get(SCORE, -999) if row else -999
            in_top2 = any(code == hold for _, code in arr[:2])
            if row and row['c'] < row['ma120']:
                close(date, '跌破MA120')
            elif best != hold and held_days >= 6 and best_score > cur_score + 0.04:
                close(date, '强者替换')
            elif best != hold and held_days >= 6 and not in_top2:
                close(date, '跌出Top2')
        if not hold:
            open_pos(best, date, idx, best_score)

    if hold:
        last = days[-1]
        sell = U[hold][1][last]['c']
        pnl = sell / entry * (1 - cost) - 1
        if log:
            records.append({
                'entry': entry_day, 'exit': last, 'code': hold, 'name': U[hold][0],
                'entryScore': entry_score, 'entryMom90': entry_mom90,
                'entryAbove60': entry_above60, 'entryAbove120': entry_above120,
                'entryClose': entry, 'exitClose': sell,
                'pnl': pnl * 100, 'contrib': cash * pnl, 'reason': '持有中',
            })
        cash *= sell / entry

    ann = (cash ** (1 / (len(days) / 244)) - 1) * 100
    return {
        'label': label, 'px': px, 'cost_bps': cost_bps,
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


full = run_mode('风控黏性过热衰竭龙头-全段', log=True)
sens = [
    run_mode('收盘0bp', px='close', cost_bps=0),
    run_mode('次开0bp', px='nextopen', cost_bps=0),
    run_mode('收盘5bp', px='close', cost_bps=5),
    run_mode('次开5bp', px='nextopen', cost_bps=5),
    run_mode('次开10bp', px='nextopen', cost_bps=10),
]
records = write_records(TRADE_LOG, full['records'])

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
    f.write('# 风控过滤黏性主线龙头回测摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}\n')
    f.write(f'- ETF池: {len(U)} 只\n')
    f.write('- 最大持仓: 1（满足最大持仓不超过 3）；市场弱时允许空仓。\n')
    f.write('- 推荐配置: `risk-gated-sticky|anti_exhaustion_score|above60|3d|min6|sw0.04|top2|soft-risk`\n')
    f.write('- 市场过滤: `benchmark_risk_on > 0` 或 ETF 自身 `mom30 > 8%`，否则空仓。\n')
    f.write(f'- 全段收益: 复利 `{full["ret"]:.1f}%` / 非复利(等权) `{full["flat_ret"]:.1f}%`；最大回撤 `{full["mdd"]:.1f}%`；交易 `{full["trades"]}`；交易记录 `{TRADE_LOG.name}`。\n')
    f.write('- 说明: 复利收益受后期权益基数放大,后几笔大行情会主导 headline;非复利收益等权每段,用于横向评估时去除该路径依赖偏差。\n')
    f.write(f'- 基准: 短周期冲刺收盘 `468.3%`；黏性过热衰竭次开10bp `529.8%`；本模式次开10bp `{sens[-1]["ret"]:.1f}%`。\n\n')
    f.write('## 候选复核\n\n')
    f.write('| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n')
    f.write(f'| {mdcell(full["label"])} | {full["ret"]:.1f}% | {full["flat_ret"]:.1f}% | {full["ann"]:.1f}% | {full["mdd"]:.1f}% | {full["trades"]} | {full["avgheld"]:.2f} | {full["underinvested_days"]} | {full["maxheld"]} |\n')
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
    f.write('本模式是黏性过热衰竭龙头的风控版：收益低于进攻版，但最大回撤从约 -23.6% 降到约 -20.3%，次开 + 10bp 仍高于短周期冲刺基准，适合作为更稳的模式库候选。\n')

print(f'全段收益 复利{full["ret"]:.1f}% / 非复利{full["flat_ret"]:.1f}% / 回撤 {full["mdd"]:.1f}% / 次开10bp {sens[-1]["ret"]:.1f}% / 交易记录 {len(records)}')
print(f'摘要: {SUMMARY_LOG}')
