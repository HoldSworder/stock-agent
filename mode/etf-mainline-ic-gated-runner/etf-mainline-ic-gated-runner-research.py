#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""IC 过滤主线 Runner 回测。

复用 etf-mainline-factor-sweep 的 ETF 因子面板，但不覆盖其 backtest-data。
核心问题：IC 高的主题宽度/横截面排名是否能作为过滤项，改善三仓主线 Runner。
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
SUMMARY_LOG = OUT_DIR / 'summary_ic_gated_runner.md'
TRADE_LOG = OUT_DIR / 'trades_ic_gated_runner_best.md'
MAINLINE_TRADE_LOG = OUT_DIR / 'trades_ic_gated_mainline_best.md'
OUT_DIR.mkdir(parents=True, exist_ok=True)

_TMP_OUT = tempfile.mkdtemp(prefix='ic_gated_import_')
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


def zscores(date, key, invert=False):
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
        vals.append((code, -v if invert else v))
    if len(vals) < 5:
        return {}
    mean = sum(v for _, v in vals) / len(vals)
    var = sum((v - mean) ** 2 for _, v in vals) / len(vals)
    sd = math.sqrt(var) or 1e-9
    return {code: (v - mean) / sd for code, v in vals}


def install_composite_scores():
    specs = {
        # 趋势质量为核心，用高 IC 的横截面/主题宽度确认，惩罚拥挤和回撤痛苦度。
        'ic_tq_gate_score': [
            ('mom30_trend_quality_smooth', 0.42, False),
            ('rank_quality_score', 0.20, False),
            ('mom30_width_stable', 0.18, False),
            ('mainline_expansion_score', 0.12, False),
            ('ulcer30', 0.05, True),
            ('turnover_proxy', 0.03, True),
        ],
        # 更偏主题宽度/全场排序，检验高 IC 因子直接作为主排序是否有效。
        'ic_width_rank_score': [
            ('cross_rank_blend', 0.26, False),
            ('mom30_width_stable', 0.24, False),
            ('mom30_theme_leader', 0.18, False),
            ('theme_width', 0.16, False),
            ('mom30_trend_quality_smooth', 0.12, False),
            ('turnover_proxy', 0.04, True),
        ],
        # 主线扩散优先，避免只追单 ETF 自身动量。
        'ic_mainline_expand_score': [
            ('mainline_expansion_score', 0.28, False),
            ('theme_breadth_accel_score', 0.20, False),
            ('theme_money_rotation_score', 0.18, False),
            ('mom30_trend_quality_smooth', 0.18, False),
            ('rank_quality_score', 0.10, False),
            ('ulcer30', 0.06, True),
        ],
        # 保守版本：趋势质量 + IC确认 + 更重的拥挤惩罚。
        'ic_crowding_control_score': [
            ('mom30_trend_quality_smooth', 0.38, False),
            ('rank_quality_score', 0.18, False),
            ('theme_width', 0.16, False),
            ('fresh_mainline_score', 0.12, False),
            ('turnover_proxy', 0.08, True),
            ('ulcer30', 0.08, True),
        ],
    }
    for date in days:
        cache = {}
        for items in specs.values():
            for key, _, invert in items:
                cache[(key, invert)] = zscores(date, key, invert)
        for score_key, items in specs.items():
            by_code = {}
            for key, weight, invert in items:
                for code, z in cache[(key, invert)].items():
                    by_code[code] = by_code.get(code, 0.0) + weight * z
            for code, value in by_code.items():
                row = U[code][1].get(date)
                if row is not None:
                    row[score_key] = value
    return tuple(specs.keys())


def result_score(r):
    return r['flat_ret'] - abs(r['mdd']) * 0.65 - r['trades'] * 0.03


def mdcell(s):
    return str(s).replace('|', '\\|')


def write_records(path, records):
    rows = sorted(records, key=lambda r: (r['entry'], r['code']))
    with open(path, 'w', encoding='utf-8') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 细主题 | 主线大类 | 买入强度 | 买入90日涨幅 | 收益 | 组合贡献 | 原因 |\n')
        f.write('|---|---|---|---|---|---|---:|---:|---:|---:|---|\n')
        for r in rows:
            name = r['name']
            f.write(
                f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {name} | '
                f'{research.family(name)} | {research.mainline_group(name)} | '
                f'{r["entryScore"] * 100:+.1f}% | {r.get("entryMom90", 0) * 100:+.1f}% | '
                f'{r["pnl"]:+.1f}% | {r["contrib"] * 100:+.1f}% | {r["reason"]} |\n'
            )
    return rows


score_keys = install_composite_scores()
cfgs = (
    ('base', {
        'protect_gain': 0.30, 'protect_dd': 0.18,
        'trend_ma': 'ma60', 'trend_dd': 0.12,
        'weak_rank': 9, 'weak_ma': 'ma60',
        'switch': 0.06, 'min_hold': 10,
    }),
    ('loose', {
        'protect_gain': 0.35, 'protect_dd': 0.22,
        'trend_ma': 'ma60', 'trend_dd': 0.15,
        'weak_rank': 12, 'weak_ma': 'ma60',
        'switch': 0.04, 'min_hold': 15,
    }),
    ('tight', {
        'protect_gain': 0.25, 'protect_dd': 0.14,
        'trend_ma': 'ma30', 'trend_dd': 0.10,
        'weak_rank': 7, 'weak_ma': 'ma60',
        'switch': 0.06, 'min_hold': 8,
    }),
)

tests = []
for score_key in score_keys:
    for abs_key in ('above60', 'above120'):
        for rebalance in (3, 5, 10):
            for cfg_name, cfg in cfgs:
                label = f'ic-runner|{score_key}|{abs_key}|{rebalance}d|{cfg_name}'
                tests.append(research.run_runner(label, score_key, abs_key, rebalance, 0.0, True, cfg=cfg))
                ml = f'ic-mainline|{score_key}|{abs_key}|{rebalance}d|{cfg_name}'
                tests.append(research.run_runner(
                    ml, score_key, abs_key, rebalance, 0.0, True, cfg=cfg,
                    group_fn=research.mainline_group, group_mode='mainline',
                ))

tests.sort(key=result_score, reverse=True)
runner_rows = [r for r in tests if r['label'].startswith('ic-runner|')]
mainline_rows = [r for r in tests if r['label'].startswith('ic-mainline|')]
best_runner = runner_rows[0]
best_mainline = mainline_rows[0]


def rerun(r, label, log=False, px='close', cost_bps=0.0):
    group_mode = r.get('group_mode', 'family')
    return research.run_runner(
        label, r['score'], r['abs'], r.get('rebalance', 5), 0.0, True,
        log=log, px=px, cost_bps=cost_bps, cfg=r['cfg'],
        group_fn=research.mainline_group if group_mode == 'mainline' else research.family,
        group_mode=group_mode,
    )


runner_full = rerun(best_runner, 'IC过滤Runner最佳', log=True)
mainline_full = rerun(best_mainline, 'IC过滤主线大类Runner最佳', log=True)
runner_no = rerun(best_runner, 'IC过滤Runner-次开10bp', px='nextopen', cost_bps=10)
mainline_no = rerun(best_mainline, 'IC过滤主线大类Runner-次开10bp', px='nextopen', cost_bps=10)
runner_records = write_records(TRADE_LOG, runner_full['records'])
mainline_records = write_records(MAINLINE_TRADE_LOG, mainline_full['records'])

baseline_runner = 167.9
baseline_mainline = 156.0
single_baseline = 468.3

with open(SUMMARY_LOG, 'w', encoding='utf-8') as f:
    f.write('# IC 过滤主线 Runner 回测摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}\n')
    f.write(f'- ETF池: {len(U)} 只\n')
    f.write('- 最大持仓: 3；Runner 同细主题最多 1 只；主线大类 Runner 同一大主线最多 1 只。\n')
    f.write(f'- 组合 Runner 基准: 原 `multi_mom_quality_score` Runner `+{baseline_runner:.1f}%`；主线大类 Runner 基准 `+{baseline_mainline:.1f}%`；单仓短周期冲刺基准 `+{single_baseline:.1f}%`。\n')
    f.write(f'- IC过滤 Runner 最佳: `{best_runner["label"]}`，收益 复利 `{runner_full["ret"]:.1f}%` / 非复利 `{runner_full["flat_ret"]:.1f}%`，次开10bp `{runner_no["ret"]:.1f}%`，交易记录 `{TRADE_LOG.name}`。\n')
    f.write(f'- IC过滤主线大类 Runner 最佳: `{best_mainline["label"]}`，收益 复利 `{mainline_full["ret"]:.1f}%` / 非复利 `{mainline_full["flat_ret"]:.1f}%`，次开10bp `{mainline_no["ret"]:.1f}%`，交易记录 `{MAINLINE_TRADE_LOG.name}`。\n')
    f.write('- 说明: 复利收益受后期权益基数放大,后几笔大行情会主导 headline;非复利收益等权每段,用于横向评估时去除该路径依赖偏差。本模式 Top 排名已改用非复利收益。\n\n')
    f.write('## Top20\n\n')
    f.write('| 模式 | 策略 | 复利收益 | 非复利收益 | 最大回撤 | 交易 | 最大持仓 | 均仓 | 次开10bp收益 | 对组合基准 |\n')
    f.write('|---|---|---:|---:|---:|---:|---:|---:|---:|---|\n')
    for r in tests[:20]:
        rr = rerun(r, 'Top20-次开10bp', px='nextopen', cost_bps=10)
        base = baseline_mainline if r.get('group_mode') == 'mainline' else baseline_runner
        note = '高于基准' if r['ret'] > base else '低于基准'
        mode = '主线大类' if r.get('group_mode') == 'mainline' else '细主题'
        f.write(f'| {mode} | {mdcell(r["label"])} | {r["ret"]:.1f}% | {r["flat_ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["maxheld"]} | {r["avgheld"]:.2f} | {rr["ret"]:.1f}% | {note} |\n')
    f.write('\n## 成交/成本敏感性\n\n')
    f.write('| 策略 | 成交口径 | 单边成本 | 收益 | 最大回撤 | 交易 | 均仓 |\n')
    f.write('|---|---|---:|---:|---:|---:|---:|\n')
    for r in (
        rerun(best_runner, 'IC过滤Runner-收盘0bp', px='close', cost_bps=0),
        rerun(best_runner, 'IC过滤Runner-次开10bp', px='nextopen', cost_bps=10),
        rerun(best_mainline, 'IC过滤主线-收盘0bp', px='close', cost_bps=0),
        rerun(best_mainline, 'IC过滤主线-次开10bp', px='nextopen', cost_bps=10),
    ):
        f.write(f'| {mdcell(r["label"])} | {r["px"]} | {r["cost_bps"]:.0f}bp | {r["ret"]:.1f}% | {r["mdd"]:.1f}% | {r["trades"]} | {r["avgheld"]:.2f} |\n')
    f.write('\n## 结论\n\n')
    if runner_full['ret'] > baseline_runner or mainline_full['ret'] > baseline_mainline:
        f.write('本轮至少有一个 IC 过滤 Runner 高于对应组合基准，可进入模式库候选。\n')
    else:
        f.write('本轮 IC 过滤 Runner 未高于对应组合基准，说明高 IC 因子更适合作为解释/过滤项，暂不替代原 Runner。\n')
    f.write('所有结果均保留次开 + 10bp 口径，避免只看收盘理想成交。\n')

print(f'IC过滤Runner: {best_runner["label"]} ret={runner_full["ret"]:.1f}% nextopen10={runner_no["ret"]:.1f}% trades={len(runner_records)}')
print(f'IC过滤主线大类Runner: {best_mainline["label"]} ret={mainline_full["ret"]:.1f}% nextopen10={mainline_no["ret"]:.1f}% trades={len(mainline_records)}')
print(f'摘要: {SUMMARY_LOG}')
