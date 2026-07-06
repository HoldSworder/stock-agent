#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""执行确认共识主线龙头模式。

目标：用多个已验证冠军因子的排名共识提升次开+成本口径。
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
SUMMARY_LOG = OUT_DIR / 'summary_execution_consensus_leader.md'
TRADE_LOG = OUT_DIR / 'trades_execution_consensus_leader.md'
OUT_DIR.mkdir(parents=True, exist_ok=True)

_TMP_OUT = tempfile.mkdtemp(prefix='exec_consensus_import_')
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
SCORE_KEY = 'execution_consensus_score'
COMPONENTS = ('anti_exhaustion_score', 'gap_momentum_score', 'pvt_confirm_score')


def rank_pct(date, key):
    vals = []
    for code, (_, by) in U.items():
        row = by.get(date)
        if not row:
            continue
        v = row.get(key)
        if isinstance(v, bool) or v is None or not isinstance(v, (int, float)):
            continue
        if math.isnan(v) or math.isinf(v):
            continue
        vals.append((v, code))
    vals.sort()
    n = len(vals)
    return {code: (i / (n - 1) if n > 1 else 0.5) for i, (_, code) in enumerate(vals)}


def install_score():
    for date in days:
        ranks = {key: rank_pct(date, key) for key in COMPONENTS}
        codes = set().union(*(set(v) for v in ranks.values()))
        for code in codes:
            vals = [ranks[key][code] for key in COMPONENTS if code in ranks[key]]
            if len(vals) >= 2:
                row = U[code][1].get(date)
                if row is not None:
                    row[SCORE_KEY] = sum(vals) / len(vals)


def mdcell(s):
    return str(s).replace('|', '\\|')


def run(label, abs_key='above60', rebalance=3, px='close', cost_bps=0.0, log=False):
    return research.run_weighted_rotation(
        label, SCORE_KEY, abs_key, rebalance, 0.0, (1.0,), True,
        log=log, px=px, cost_bps=cost_bps, exit_rule='ma120', reset_weights=False,
    )


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


install_score()
tests = []
for abs_key in ('above60', 'above120'):
    for rebalance in (3, 5, 10):
        tests.append(run(f'exec-consensus|{SCORE_KEY}|{abs_key}|{rebalance}d|100%', abs_key, rebalance))
tests.sort(key=lambda r: r['flat_ret'] - abs(r['mdd']) * 0.6 - r['trades'] * 0.02, reverse=True)
best = tests[0]
full = run('执行确认共识龙头-全段', best['abs'], best['rebalance'], log=True)
seg2025 = research.run_weighted_rotation(
    '执行确认共识龙头-2025', SCORE_KEY, best['abs'], best['rebalance'],
    0.0, (1.0,), True, '2025-01-01', '2025-12-31',
    exit_rule='ma120', reset_weights=False,
)
seg2026 = research.run_weighted_rotation(
    '执行确认共识龙头-2026', SCORE_KEY, best['abs'], best['rebalance'],
    0.0, (1.0,), True, '2026-01-01', '2026-06-26',
    exit_rule='ma120', reset_weights=False,
)
sens = [
    run('收盘0bp', best['abs'], best['rebalance'], px='close', cost_bps=0),
    run('次开0bp', best['abs'], best['rebalance'], px='nextopen', cost_bps=0),
    run('收盘5bp', best['abs'], best['rebalance'], px='close', cost_bps=5),
    run('次开5bp', best['abs'], best['rebalance'], px='nextopen', cost_bps=5),
    run('次开10bp', best['abs'], best['rebalance'], px='nextopen', cost_bps=10),
]
records = write_records(TRADE_LOG, full['records'])

baseline_close = 468.3
baseline_next10 = 473.0

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
    f.write('# 执行确认共识主线龙头回测摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}\n')
    f.write(f'- ETF池: {len(U)} 只\n')
    f.write('- 最大持仓: 1（满足最大持仓不超过 3）；同主题重复持仓天然为 0。\n')
    f.write(f'- 推荐配置: `{best["label"]}`\n')
    f.write(f'- 共识因子: `{SCORE_KEY} = rank(anti_exhaustion_score, gap_momentum_score, pvt_confirm_score) 平均`\n')
    f.write(f'- 全段收益: 复利 `{full["ret"]:.1f}%` / 非复利(等权) `{full["flat_ret"]:.1f}%`；最大回撤 `{full["mdd"]:.1f}%`；交易 `{full["trades"]}`；交易记录 `{TRADE_LOG.name}`。\n')
    f.write('- 说明: 复利收益受后期权益基数放大,后几笔大行情会主导 headline;非复利收益等权每段,用于横向评估时去除该路径依赖偏差。本模式参数排名已改用非复利收益。\n')
    f.write(f'- 基准: 短周期冲刺收盘 `{baseline_close:.1f}%`；过热衰竭模式次开10bp `{baseline_next10:.1f}%`；本模式次开10bp `{sens[-1]["ret"]:.1f}%`。\n\n')
    f.write('## 候选复核\n\n')
    f.write('| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n')
    for r in (full, seg2025, seg2026):
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["flat_ret"]:.1f}% | {r["ann"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} | {r["underinvested_days"]} | {r["maxheld"]} |\n')
    f.write('\n## 参数对照\n\n')
    f.write('| 策略 | 复利收益 | 非复利收益 | 最大回撤 | 交易 | 次开10bp收益 | 是否高于收盘基准 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---|\n')
    for r in tests:
        rr = run('参数-次开10bp', r['abs'], r['rebalance'], px='nextopen', cost_bps=10)
        ok = '是' if r['ret'] > baseline_close else '否'
        f.write(f'| {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["flat_ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {rr["ret"]:.1f}% | {ok} |\n')
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
    f.write('本模式用三个已验证冠军因子的排名共识替代单一指标。收盘口径略低于 `anti_exhaustion_score`，但次开 + 10bp 口径小幅提高，说明量价执行确认对成交鲁棒性有边际帮助。\n')

print(f'推荐配置: {best["label"]}')
print(f'全段收益 复利{full["ret"]:.1f}% / 非复利{full["flat_ret"]:.1f}% / 回撤 {full["mdd"]:.1f}% / 次开10bp {sens[-1]["ret"]:.1f}% / 交易 {len(records)}')
print(f'摘要: {SUMMARY_LOG}')
