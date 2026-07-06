#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Family-stable flatReturn leader.

在 breadth-confirmed 冠军模式基础上，只修改“同主题内是否切换代表 ETF”。
主题外继续强者替换；主题内需要额外强度优势，减少港股创新药/广发这类同主题来回切换。
"""
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
SUMMARY_LOG = OUT_DIR / 'summary_family_stable_flat_leader.md'
TRADE_LOG = OUT_DIR / 'trades_family_stable_flat_leader.md'
OUT_DIR.mkdir(parents=True, exist_ok=True)

TMP = tempfile.mkdtemp(prefix='family_stable_flat_')
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
    ns = {'__file__': str(SWEEP), '__name__': 'family_stable_flat_prefix'}
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


def candidates(date, score_key, confirm_min, breadth_min, amount_min):
    rows = []
    for code, (name, by_date) in U.items():
        row = by_date.get(date)
        if not row or not row.get('above60'):
            continue
        if get(row, 'mainline_persist', -999.0) < confirm_min:
            continue
        if get(row, 'theme_breadth_above120', -999.0) < breadth_min:
            continue
        if get(row, 'theme_amount_power', -999.0) < amount_min:
            continue
        score = get(row, score_key, None)
        if score is None:
            continue
        rows.append((score, code, family(name)))
    rows.sort(reverse=True)
    return rows


def run_mode(label, score_key='anti_exhaustion_score', rebalance=4, min_hold=6,
             switch_margin=0.0, family_switch_margin=0.08, top_exit=2,
             family_top_exit=3, protect_gain=0.15, protect_dd=0.06,
             confirm_min=0.15, breadth_min=0.30, amount_min=-9.0,
             exit_ma='ma120', start=None, end=None, px='close', cost_bps=0.0, log=False):
    active_days = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    cash = 1.0
    hold = None
    hold_family = ''
    entry = 0.0
    entry_day = ''
    entry_idx = 0
    entry_score = 0.0
    entry_mom90 = 0.0
    entry_breadth = 0.0
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

    def equity(date):
        if hold and date in U[hold][1]:
            return cash * (U[hold][1][date]['c'] / entry)
        return cash

    def close(date, reason):
        nonlocal cash, hold, hold_family, peak_px, trades
        sell = price(hold, date)
        pnl = sell / entry * (1 - cost) * (1 - cost) - 1
        if log:
            records.append({
                'entry': entry_day,
                'exit': date,
                'code': hold,
                'name': U[hold][0],
                'family': hold_family,
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
        hold_family = ''
        peak_px = 0.0
        trades += 1

    def open_pos(code, fam, date, idx, score):
        nonlocal cash, hold, hold_family, entry, entry_day, entry_idx, entry_score
        nonlocal entry_mom90, entry_breadth, peak_px, trades
        row = U[code][1][date]
        cash *= (1 - cost)
        hold = code
        hold_family = fam
        entry = price(code, date)
        entry_day = date
        entry_idx = idx
        entry_score = score
        entry_mom90 = get(row, 'mom90', 0.0)
        entry_breadth = get(row, 'theme_breadth_above120', 0.0)
        peak_px = entry
        trades += 1

    for idx, date in enumerate(active_days):
        eq = equity(date)
        curve.append(eq)
        equity_peak = max(equity_peak, eq)
        mdd = min(mdd, (eq / equity_peak - 1) * 100)
        held_sum += 1 if hold else 0
        if idx % rebalance != 0:
            continue
        ranked = candidates(date, score_key, confirm_min, breadth_min, amount_min)
        if not ranked:
            continue
        best_score, best, best_family = ranked[0]
        if hold:
            held_days = idx - entry_idx
            row = U[hold][1].get(date)
            cur_score = get(row, score_key, -999.0) if row else -999.0
            in_top = any(code == hold for _, code, _ in ranked[:top_exit])
            family_rank = next((i for i, (_, _, fam) in enumerate(ranked) if fam == hold_family), None)
            if row:
                peak_px = max(peak_px, row['c'])
            gain = peak_px / entry - 1 if entry else 0.0
            pullback = row['c'] / peak_px - 1 if row and peak_px else 0.0
            if row and gain >= protect_gain and pullback <= -protect_dd:
                close(date, f'盈利保护{protect_gain:.0%}/{protect_dd:.0%}')
            elif row and exit_ma and row['c'] < row[exit_ma]:
                close(date, f'跌破{exit_ma.upper()}')
            elif best != hold and held_days >= min_hold:
                if best_family == hold_family:
                    if best_score > cur_score + family_switch_margin:
                        close(date, '同主题代表显著增强')
                    elif family_rank is not None and family_rank >= family_top_exit:
                        close(date, f'主题跌出Top{family_top_exit}')
                elif best_score > cur_score + switch_margin:
                    close(date, '跨主题强者替换')
                elif not in_top:
                    close(date, f'跌出Top{top_exit}')
        if not hold:
            open_pos(best, best_family, date, idx, best_score)

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
                'family': hold_family,
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


def describe(cfg):
    score_key, rebalance, min_hold, switch_margin, family_switch_margin, top_exit, family_top_exit, protect_gain, protect_dd, confirm_min, breadth_min, amount_min = cfg
    return (
        f'family-stable|{score_key}|{rebalance}d|min{min_hold}|sw{switch_margin:.2f}|'
        f'famSw{family_switch_margin:.2f}|top{top_exit}|famTop{family_top_exit}|'
        f'pg{protect_gain:.0%}|dd{protect_dd:.0%}|mainline_persist>={confirm_min:.2f}|'
        f'theme_breadth_above120>={breadth_min:.2f}|theme_amount_power>={amount_min:.2f}'
    )


cfgs = [
    (score_key, 4, min_hold, switch_margin, family_switch_margin, top_exit, family_top_exit, protect_gain, protect_dd, confirm_min, breadth_min, amount_min)
    for score_key in ('anti_exhaustion_score', 'mainline_quality_score', 'mom30_width_stable')
    for min_hold in (4, 6, 8)
    for switch_margin in (0.0, 0.02)
    for family_switch_margin in (0.04, 0.08, 0.12, 0.16)
    for top_exit in (1, 2, 3)
    for family_top_exit in (2, 3, 4)
    for protect_gain, protect_dd in ((0.15, 0.06), (0.20, 0.08), (0.25, 0.08))
    for confirm_min in (0.12, 0.15, 0.18)
    for breadth_min in (0.30, 0.40, 0.50)
    for amount_min in (-9.0, 0.10)
]

best = []
for idx, cfg in enumerate(cfgs, 1):
    result = run_mode(describe(cfg), *cfg)
    if result['trades'] < 12 or result['mdd'] < -30 or result['held'] < 0.45:
        continue
    item = (result['flat'], result['ret'], result['mdd'], result['held'], -result['trades'], idx, cfg, result)
    if len(best) < 80:
        heapq.heappush(best, item)
    else:
        heapq.heappushpop(best, item)

top = sorted(best, reverse=True)
best_cfg = top[0][6]
full = run_mode('同主题代表稳定非复利主线龙头-全段', *best_cfg, log=True)
next10 = run_mode('次开10bp', *best_cfg, px='nextopen', cost_bps=10)
records = write_records(TRADE_LOG, full['records'])

segments = []
for label, start, end in (
    ('2025H1', '2025-01-02', '2025-06-30'),
    ('2025H2', '2025-07-01', '2025-12-31'),
    ('2026H1', '2026-01-01', '2026-06-26'),
):
    close = run_mode(label, *best_cfg, start=start, end=end)
    nxt = run_mode(label, *best_cfg, start=start, end=end, px='nextopen', cost_bps=10)
    segments.append((label, close, nxt))

with open(SUMMARY_LOG, 'w', encoding='utf-8') as f:
    f.write('# 同主题代表稳定非复利主线龙头回测摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}\n')
    f.write(f'- ETF池: {len(U)} 只\n')
    f.write(f'- 扫描组合: {len(cfgs)}\n')
    f.write('- 最大持仓: 1；同一时间不会重复持有同主题 ETF。\n')
    f.write(f'- 推荐候选: `{describe(best_cfg)}`\n')
    f.write('- 机制: 跨主题仍按强者替换；同主题内只有新代表强度显著高于当前持仓时才切换。\n')
    f.write(f'- 全段收益: 复利 `{full["ret"]:.1f}%` / 非复利 `{full["flat"]:.1f}%`；最大回撤 `{full["mdd"]:.1f}%`；交易 `{full["trades"]}`；持仓占比 `{full["held"]:.2f}`。\n')
    f.write(f'- 执行口径: 次开 10bp 复利 `{next10["ret"]:.1f}%` / 非复利 `{next10["flat"]:.1f}%`。\n')
    f.write(f'- 交易记录: `{TRADE_LOG.name}`\n\n')
    f.write('## 候选复核\n\n')
    f.write('| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n')
    f.write(
        f'| 同主题代表稳定非复利主线龙头-全段 | {full["ret"]:.1f}% | {full["flat"]:.1f}% | {full["ann"]:.1f}% | '
        f'{full["mdd"]:.1f}% | {full["trades"]} | {full["held"]:.2f} | {full["underinvested_days"]} | {full["maxheld"]} |\n\n'
    )
    f.write('## Top 候选\n\n')
    f.write('| 排名 | flatReturn | 次开10bp flatReturn | 复利收益 | 最大回撤 | 持仓占比 | 交易 | 分段flatReturn | 配置 |\n')
    f.write('|---:|---:|---:|---:|---:|---:|---:|---|---|\n')
    for rank_idx, item in enumerate(top[:30], 1):
        flat, ret, mdd, held, neg_trades, _, cfg, _ = item
        nxt = run_mode('次开10bp', *cfg, px='nextopen', cost_bps=10)
        segs = [
            run_mode('2025H1', *cfg, start='2025-01-02', end='2025-06-30')['flat'],
            run_mode('2025H2', *cfg, start='2025-07-01', end='2025-12-31')['flat'],
            run_mode('2026H1', *cfg, start='2026-01-01', end='2026-06-26')['flat'],
        ]
        f.write(
            f'| {rank_idx} | {flat:.1f}% | {nxt["flat"]:.1f}% | {ret:.1f}% | {mdd:.1f}% | {held:.2f} | {-neg_trades} | '
            f'2025H1 {segs[0]:.1f}% / 2025H2 {segs[1]:.1f}% / 2026H1 {segs[2]:.1f}% | `{describe(cfg)}` |\n'
        )
    f.write('\n## 分段复核\n\n')
    f.write('| 区间 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|\n')
    for label, close, nxt in segments:
        f.write(f'| {label} | {close["ret"]:.1f}% | {close["flat"]:.1f}% | {close["mdd"]:.1f}% | {close["trades"]} | {nxt["ret"]:.1f}% | {nxt["flat"]:.1f}% |\n')
    f.write('\n## 结论\n\n')
    if full['flat'] > 248.1:
        f.write('同主题代表稳定规则在 flatReturn 上超过当前 breadth-confirmed 基准，值得作为推荐候选入库。\n')
    else:
        f.write('同主题代表稳定规则未超过当前 breadth-confirmed 基准。它减少同主题内切换噪音，但牺牲了部分单 ETF 龙头敏捷性。\n')

print(
    f'best flat={full["flat"]:.1f}% ret={full["ret"]:.1f}% next10_flat={next10["flat"]:.1f}% '
    f'mdd={full["mdd"]:.1f}% trades={full["trades"]} cfg={describe(best_cfg)}'
)
print(f'summary={SUMMARY_LOG}')
print(f'trades={TRADE_LOG}')
