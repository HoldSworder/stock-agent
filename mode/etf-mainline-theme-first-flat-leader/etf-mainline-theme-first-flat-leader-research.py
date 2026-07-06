#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Theme-first flatReturn leader exploration.

先选主线主题，再在主题内选代表 ETF，避免同主题 ETF 在策略逻辑上重复竞争。
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
SUMMARY_LOG = OUT_DIR / 'summary_theme_first_flat_leader.md'
TRADE_LOG = OUT_DIR / 'trades_theme_first_flat_leader.md'
OUT_DIR.mkdir(parents=True, exist_ok=True)

TMP = tempfile.mkdtemp(prefix='theme_first_flat_')
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
    ns = {'__file__': str(SWEEP), '__name__': 'theme_first_flat_prefix'}
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


def score_row(row, key):
    v = row.get(key) if row else None
    return v if valid(v) else None


def theme_score(rows, key):
    vals = [score_row(row, key) for _, row in rows]
    vals = [v for v in vals if v is not None]
    if not vals:
        return None
    vals.sort(reverse=True)
    top = vals[0]
    avg_top2 = sum(vals[:2]) / min(len(vals), 2)
    # 主题分数强调最强代表，但要求同主题第二梯队也别太弱。
    return 0.65 * top + 0.35 * avg_top2


def build_rank(theme_key, leader_key, confirm_min, breadth_min, amount_min, min_theme_members):
    by_day = {}
    for date in days:
        groups = {}
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
            fam = family(name)
            groups.setdefault(fam, []).append((code, row))

        theme_rows = []
        for fam, rows in groups.items():
            if len(rows) < min_theme_members:
                continue
            ts = theme_score(rows, theme_key)
            if ts is None:
                continue
            leaders = []
            for code, row in rows:
                ls = score_row(row, leader_key)
                if ls is not None:
                    leaders.append((ls, code))
            if not leaders:
                continue
            leaders.sort(reverse=True)
            leader_score, leader = leaders[0]
            theme_rows.append((ts, leader_score, fam, leader))
        theme_rows.sort(reverse=True)
        by_day[date] = theme_rows
    return by_day


def run(rank, cfg, start=None, end=None, px='close', cost_bps=0.0, log=False):
    rebalance, min_hold, top_exit, protect_gain, protect_dd, exit_ma = cfg
    active_days = [d for d in days if (start is None or d >= start) and (end is None or d <= end)]
    cash = 1.0
    hold = None
    hold_family = ''
    entry = 0.0
    entry_day = ''
    entry_idx = 0
    entry_theme_score = 0.0
    entry_leader_score = 0.0
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

    def current_theme_rank(date):
        if not hold:
            return None, None
        rows = rank[date]
        for idx, item in enumerate(rows):
            _, leader_score, fam, leader = item
            if fam == hold_family:
                return idx, (leader_score, leader)
        return None, None

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
                'entryThemeScore': entry_theme_score,
                'entryLeaderScore': entry_leader_score,
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
        hold_family = ''
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

        rows = rank[date]
        best = rows[0] if rows else None
        if hold:
            held_days = idx - entry_idx
            row = U[hold][1].get(date)
            if row:
                peak_px = max(peak_px, row['c'])
            gain = peak_px / entry - 1 if entry else 0.0
            pullback = row['c'] / peak_px - 1 if row and peak_px else 0.0
            fam_rank, fam_best = current_theme_rank(date)
            if row and gain >= protect_gain and pullback <= -protect_dd:
                close(date, f'盈利保护{protect_gain:.0%}/{protect_dd:.0%}')
            elif row and exit_ma and row['c'] < row[exit_ma]:
                close(date, f'跌破{exit_ma.upper()}')
            elif fam_rank is None and held_days >= min_hold:
                close(date, '主题失效')
            elif fam_rank is not None and fam_rank >= top_exit and held_days >= min_hold:
                close(date, f'主题跌出Top{top_exit}')
            elif best and best[2] != hold_family and held_days >= min_hold:
                close(date, '主线主题替换')

        if not hold and best:
            theme_s, leader_s, fam, leader = best
            row = U[leader][1][date]
            hold = leader
            hold_family = fam
            entry = price(leader, date)
            entry_day = date
            entry_idx = idx
            entry_theme_score = theme_s
            entry_leader_score = leader_s
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
                'family': hold_family,
                'entryThemeScore': entry_theme_score,
                'entryLeaderScore': entry_leader_score,
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

    ann = (cash ** (1 / (len(active_days) / 244)) - 1) * 100 if active_days else 0.0
    return {
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


def describe_outer(outer):
    theme_key, leader_key, confirm_min, breadth_min, amount_min, min_theme_members = outer
    return (
        f'theme={theme_key}|leader={leader_key}|mainline_persist>={confirm_min:.2f}|'
        f'theme_breadth_above120>={breadth_min:.2f}|theme_amount_power>={amount_min:.2f}|'
        f'members>={min_theme_members}'
    )


def describe_cfg(cfg):
    rebalance, min_hold, top_exit, protect_gain, protect_dd, exit_ma = cfg
    return f'{rebalance}d|min{min_hold}|themeTop{top_exit}|pg{protect_gain:.0%}|dd{protect_dd:.0%}|exit={exit_ma}'


def write_records(path, records):
    rows = sorted(records, key=lambda r: (r['entry'], r['code']))
    with open(path, 'w', encoding='utf-8') as f:
        f.write('| 买入日 | 卖出/统计日 | 代码 | 标的 | 主题 | 主题强度 | 龙头强度 | 主题MA120宽度 | 买入90日涨幅 | 收益 | 组合贡献 | 原因 |\n')
        f.write('|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|\n')
        for r in rows:
            f.write(
                f'| {r["entry"]} | {r["exit"]} | {r["code"]} | {r["name"]} | {r["family"]} | '
                f'{r["entryThemeScore"] * 100:+.1f}% | {r["entryLeaderScore"] * 100:+.1f}% | '
                f'{r["entryBreadth"] * 100:.0f}% | {r["entryMom90"] * 100:+.1f}% | '
                f'{r["pnl"]:+.1f}% | {r["contrib"] * 100:+.1f}% | {r["reason"]} |\n'
            )
    return rows


theme_keys = (
    'anti_exhaustion_score',
    'mom30_theme_power',
    'mom30_width_stable',
    'mainline_quality_score',
    'theme_continuity_score',
)
leader_keys = (
    'anti_exhaustion_score',
    'mom30_trend_quality_smooth',
    'mainline_quality_score',
)
outers = [
    (theme_key, leader_key, confirm_min, breadth_min, amount_min, min_theme_members)
    for theme_key in theme_keys
    for leader_key in leader_keys
    for confirm_min in (0.12, 0.15, 0.18)
    for breadth_min in (0.30, 0.40, 0.50)
    for amount_min in (-9.0, 0.10)
    for min_theme_members in (1, 2)
]
cfgs = [
    (4, min_hold, top_exit, protect_gain, protect_dd, 'ma120')
    for min_hold in (4, 6, 8)
    for top_exit in (1, 2, 3)
    for protect_gain, protect_dd in ((0.15, 0.06), (0.20, 0.08), (0.25, 0.08))
]

best = []
counter = 0
for outer in outers:
    rank = build_rank(*outer)
    for cfg in cfgs:
        result = run(rank, cfg)
        counter += 1
        if result['trades'] < 12 or result['mdd'] < -30 or result['held'] < 0.45:
            continue
        item = (result['flat'], result['ret'], result['mdd'], result['held'], -result['trades'], counter, outer, cfg, result)
        if len(best) < 80:
            heapq.heappush(best, item)
        else:
            heapq.heappushpop(best, item)

top = sorted(best, reverse=True)
best_flat, _, _, _, _, _, best_outer, best_cfg, _ = top[0]
best_rank = build_rank(*best_outer)
full = run(best_rank, best_cfg, log=True)
next10 = run(best_rank, best_cfg, px='nextopen', cost_bps=10)
records = write_records(TRADE_LOG, full['records'])

segments = []
for label, start, end in (
    ('2025H1', '2025-01-02', '2025-06-30'),
    ('2025H2', '2025-07-01', '2025-12-31'),
    ('2026H1', '2026-01-01', '2026-06-26'),
):
    close = run(best_rank, best_cfg, start=start, end=end)
    nxt = run(best_rank, best_cfg, start=start, end=end, px='nextopen', cost_bps=10)
    segments.append((label, close, nxt))

with open(SUMMARY_LOG, 'w', encoding='utf-8') as f:
    f.write('# 主题优先非复利主线龙头探索摘要\n\n')
    f.write(f'- 回测区间: {days[0]} 至 {days[-1]}\n')
    f.write(f'- ETF池: {len(U)} 只\n')
    f.write(f'- 扫描组合: {counter}\n')
    f.write('- 最大持仓: 1；先选主题，再选主题内代表 ETF，同主题重复持仓天然为 0。\n')
    f.write(f'- 推荐候选: `{describe_outer(best_outer)}|{describe_cfg(best_cfg)}`\n')
    f.write(f'- 全段收益: 复利 `{full["ret"]:.1f}%` / 非复利 `{full["flat"]:.1f}%`；最大回撤 `{full["mdd"]:.1f}%`；交易 `{full["trades"]}`；持仓占比 `{full["held"]:.2f}`。\n')
    f.write(f'- 执行口径: 次开 10bp 复利 `{next10["ret"]:.1f}%` / 非复利 `{next10["flat"]:.1f}%`。\n')
    f.write(f'- 交易记录: `{TRADE_LOG.name}`\n\n')
    f.write('## 候选复核\n\n')
    f.write('| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n')
    f.write(
        f'| 主题优先非复利主线龙头-全段 | {full["ret"]:.1f}% | {full["flat"]:.1f}% | {full["ann"]:.1f}% | '
        f'{full["mdd"]:.1f}% | {full["trades"]} | {full["held"]:.2f} | {full["underinvested_days"]} | {full["maxheld"]} |\n\n'
    )
    f.write('## Top 候选\n\n')
    f.write('| 排名 | flatReturn | 次开10bp flatReturn | 复利收益 | 最大回撤 | 持仓占比 | 交易 | 分段flatReturn | 主题规则 | 回放规则 |\n')
    f.write('|---:|---:|---:|---:|---:|---:|---:|---|---|---|\n')
    for idx, item in enumerate(top[:30], 1):
        flat, ret, mdd, held, neg_trades, _, outer, cfg, _ = item
        rank = build_rank(*outer)
        nxt = run(rank, cfg, px='nextopen', cost_bps=10)
        segs = [
            run(rank, cfg, '2025-01-02', '2025-06-30')['flat'],
            run(rank, cfg, '2025-07-01', '2025-12-31')['flat'],
            run(rank, cfg, '2026-01-01', '2026-06-26')['flat'],
        ]
        f.write(
            f'| {idx} | {flat:.1f}% | {nxt["flat"]:.1f}% | {ret:.1f}% | {mdd:.1f}% | {held:.2f} | {-neg_trades} | '
            f'2025H1 {segs[0]:.1f}% / 2025H2 {segs[1]:.1f}% / 2026H1 {segs[2]:.1f}% | '
            f'`{describe_outer(outer)}` | `{describe_cfg(cfg)}` |\n'
        )
    f.write('\n## 分段复核\n\n')
    f.write('| 区间 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 |\n')
    f.write('|---|---:|---:|---:|---:|---:|---:|\n')
    for label, close, nxt in segments:
        f.write(f'| {label} | {close["ret"]:.1f}% | {close["flat"]:.1f}% | {close["mdd"]:.1f}% | {close["trades"]} | {nxt["ret"]:.1f}% | {nxt["flat"]:.1f}% |\n')
    f.write('\n## 结论\n\n')
    if full['flat'] > 248.1:
        f.write('主题优先模式在 flatReturn 上超过当前 breadth-confirmed 基准，值得进一步入库验证。\n')
    else:
        f.write('主题优先模式未超过当前 breadth-confirmed 基准。它解决了主题先行和同主题代表 ETF 的表达问题，但收益路径仍低于单 ETF 价格强度优先模式。\n')

print(
    f'best flat={full["flat"]:.1f}% ret={full["ret"]:.1f}% next10_flat={next10["flat"]:.1f}% '
    f'mdd={full["mdd"]:.1f}% trades={full["trades"]} outer={describe_outer(best_outer)} cfg={describe_cfg(best_cfg)}'
)
print(f'summary={SUMMARY_LOG}')
print(f'trades={TRADE_LOG}')
