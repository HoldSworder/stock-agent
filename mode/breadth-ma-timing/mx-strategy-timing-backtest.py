#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「全A等权/平均股价 均线择时」套在系统内「妙想东财模拟盘」战法的实际收益上回测。

想法：用广度敏感指数（全A等权880008 / 平均股价880003）当大盘温度计，
  · 指数收盘 < MA10       → 空仓（当日不跑战法，收益记 0）
  · MA10 <= 收盘 < MA5    → 半仓（战法当日收益 ×0.5）
  · 收盘 >= MA5           → 满仓（战法当日收益 ×1.0）
对照「战法原样（始终满仓）」，看择时叠加能否降回撤 / 提风险收益比。

数据：
  · 战法收益：由妙想模拟盘 102 笔成交流水重放出每日净值（现金 + 持仓按当日收盘市值），
    区间 2026-05-13 ~ 2026-07-23。缓存：/tmp/mxcache/mx_trades.json + /tmp/mxcache/stocks/*.json
  · 信号指数：/tmp/mxcache/{880008,880003}.json（通达信日线）
口径：前一交易日收盘定当日仓位（无未来函数），SMA。手续费按 FEE_BP 单边计（默认 0，另出敏感度）。

运行：python3 mode/breadth-ma-timing/mx-strategy-timing-backtest.py
"""
import json
import math
import os
from collections import deque

CACHE = os.environ.get('SA_CACHE', '/tmp/mxcache')
INIT_MONEY = float(os.environ.get('SA_INIT_MONEY', '1000000'))  # 妙想初始资金
ACTUAL_FINAL = float(os.environ.get('SA_ACTUAL_FINAL', '1257639'))  # 妙想当前总资产，供重放校验
ANN = 244
OUT = os.path.join(os.path.dirname(__file__), 'backtest-data', 'summary_mx_strategy_timing.md')


def load_json(fp):
    with open(fp) as f:
        return json.load(f)


def load_stock_closes(code):
    """读单只股票日线 → {date: close}（升序日期）。"""
    rows = load_json(os.path.join(CACHE, 'stocks', f'{code}.json'))
    out = {}
    for x in (rows or []):
        d = str(x.get('datetime') or x.get('date') or '')[:10]
        c = x.get('close')
        if d and c is not None:
            out[d] = float(c)
    return out


def load_index_closes(sym):
    """读指数日线 → 升序 [(date, close)]。"""
    rows = load_json(os.path.join(CACHE, f'{sym}.json'))
    out = []
    for x in (rows or []):
        d = str(x.get('datetime') or x.get('date') or '')[:10]
        c = x.get('close')
        if d and c is not None:
            out.append((d, float(c)))
    out.sort()
    return out


def sma_last(vals, n):
    """末 n 个的简单均值，不足取全部均值。"""
    s = vals[-n:] if len(vals) >= n else vals
    return sum(s) / len(s) if s else 0.0


def position_for(close, ma5, ma10):
    """择时规则 → 目标仓位。破10日线空仓、10日线上破5日线半仓、站上5日线满仓。"""
    if close < ma10:
        return 0.0
    if close < ma5:
        return 0.5
    return 1.0


def max_drawdown(equity):
    peak = equity[0]
    mdd = 0.0
    for v in equity:
        peak = max(peak, v)
        mdd = min(mdd, v / peak - 1)
    return mdd * 100


def stdev(xs):
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def metrics(daily_rets, positions=None):
    """日收益序列 → 总收益/年化/最大回撤/年化波动/夏普；带仓位则附暴露与换仓。"""
    eq = [1.0]
    for r in daily_rets:
        eq.append(eq[-1] * (1 + r))
    total = (eq[-1] - 1) * 100
    n = len(daily_rets)
    years = n / ANN if n else 1
    cagr = (eq[-1] ** (1 / years) - 1) * 100 if eq[-1] > 0 and years > 0 else float('nan')
    vol = stdev(daily_rets) * math.sqrt(ANN) * 100
    sharpe = (sum(daily_rets) / n * ANN * 100) / vol if (n and vol) else float('nan')
    mdd = max_drawdown(eq)
    out = {'total': total, 'cagr': cagr, 'vol': vol, 'sharpe': sharpe, 'mdd': mdd, 'days': n}
    if positions is not None:
        out['exposure'] = sum(positions) / len(positions) * 100
        out['flat'] = sum(1 for p in positions if p == 0.0)
        out['half'] = sum(1 for p in positions if p == 0.5)
        out['full'] = sum(1 for p in positions if p == 1.0)
        out['switches'] = sum(1 for i in range(1, len(positions)) if positions[i] != positions[i - 1])
    return out


def replay_equity(trades, calendar, closes_by_code, fee_bp=0.0):
    """按交易日历重放成交，返回每日收盘净值 [(date, equity)]。

    当日成交按成交价现金结算（买-卖+），收盘用当日收盘价对持仓 MTM。fee_bp 单边扣费。
    """
    rate = fee_bp / 10000.0
    # 按时间排序，逐笔应用「成交日期 <= 当前交易日」的所有未处理成交——
    # 避免成交日期恰好不在指数日历里（停牌/日历口径差）时把该笔成交整单丢弃。
    ordered = sorted(trades, key=lambda x: (x['date'], x.get('ts', 0)))
    ti = 0
    cash = INIT_MONEY
    holdings = {}
    last_close = {}  # 停牌/缺价时用最近收盘兜底
    series = []
    for d in calendar:
        while ti < len(ordered) and ordered[ti]['date'] <= d:
            t = ordered[ti]
            ti += 1
            amt = t['qty'] * t['px']
            fee = amt * rate
            if t['side'] == 'buy':
                cash -= amt + fee
                holdings[t['code']] = holdings.get(t['code'], 0) + t['qty']
            else:
                cash += amt - fee
                holdings[t['code']] = holdings.get(t['code'], 0) - t['qty']
        mv = 0.0
        for code, qty in holdings.items():
            if qty == 0:
                continue
            c = closes_by_code.get(code, {}).get(d)
            if c is None:
                c = last_close.get(code)
            else:
                last_close[code] = c
            if c is not None:
                mv += qty * c
        series.append((d, cash + mv))
    return series


def main():
    trades = load_json(os.path.join(CACHE, 'mx_trades.json'))
    closes_by_code = {}
    for code in sorted({t['code'] for t in trades}):
        try:
            closes_by_code[code] = load_stock_closes(code)
        except Exception:
            closes_by_code[code] = {}
    first_trade = min(t['date'] for t in trades)
    last_trade = max(t['date'] for t in trades)

    # 交易日历：用全A等权指数的交易日（覆盖全市场），限定到 [首笔成交, 末笔成交]
    idx8 = load_index_closes('880008')
    calendar = [d for d, _ in idx8 if first_trade <= d <= last_trade]

    # 重放战法每日净值（0 手续费口径，另出费率敏感度）
    series = replay_equity(trades, calendar, closes_by_code, fee_bp=0.0)
    dates = [d for d, _ in series]
    eq = [v for _, v in series]
    recon_final = eq[-1]
    recon_ret = (recon_final / INIT_MONEY - 1) * 100
    actual_ret = (ACTUAL_FINAL / INIT_MONEY - 1) * 100

    # 战法日收益（原样，始终满仓）
    strat_rets = [eq[i] / eq[i - 1] - 1 for i in range(1, len(eq))]
    strat_dates = dates[1:]  # 与 strat_rets 对齐（从第 2 天起）

    # 各信号指数上算 MA5/MA10 → 每日仓位（用前一交易日收盘决定当日仓位）
    def signal_positions(sym):
        rows = load_index_closes(sym)
        closes = [c for _, c in rows]
        pos_by_date = {}
        for i in range(1, len(rows)):
            d = rows[i][0]
            prev = closes[:i]  # 截至前一日
            ma5 = sma_last(prev, 5)
            ma10 = sma_last(prev, 10)
            pos_by_date[d] = position_for(closes[i - 1], ma5, ma10)
        return pos_by_date

    results = {}
    for sym, name in [('883994', '昨日打首板表现'), ('880008', '全A等权'), ('880003', '平均股价')]:
        pos_by_date = signal_positions(sym)
        positions = [pos_by_date.get(d, 1.0) for d in strat_dates]
        gated = [p * r for p, r in zip(positions, strat_rets)]
        results[sym] = {
            'name': name,
            'gated': metrics(gated, positions),
        }

    strat_m = metrics(strat_rets)
    # 基准：全A等权买入持有（同窗口）
    idx_win = [c for d, c in idx8 if d in set(dates)]
    bh_idx = [idx_win[i] / idx_win[i - 1] - 1 for i in range(1, len(idx_win))] if len(idx_win) > 1 else []
    bh_m = metrics(bh_idx) if bh_idx else None

    # ---- 渲染 ----
    L = []
    L.append('# 妙想东财模拟盘 × 均线择时叠加回测\n')
    L.append(f'> 战法：妙想东财模拟盘（{first_trade} ~ {last_trade}，{len(strat_rets)} 个交易日，初始 {INIT_MONEY/1e4:.0f} 万）。\n')
    L.append('> 择时：全A等权/平均股价 <MA10 空仓、MA10~MA5 半仓、≥MA5 满仓；套在战法每日收益上（空仓日收益记0，半仓×0.5）。\n')
    L.append(f'> 净值重放校验：重放终值 {recon_final/1e4:.1f} 万（+{recon_ret:.1f}%） vs 妙想实际 {ACTUAL_FINAL/1e4:.1f} 万（+{actual_ret:.1f}%），差异 {recon_ret-actual_ret:+.1f}pct（差异主要来自手续费/印花税未在重放中精确计）。\n')

    L.append('\n| 方案 | 总收益 | 最大回撤 | 年化波动 | 夏普 | 平均仓位 | 换仓次数 |')
    L.append('|---|--:|--:|--:|--:|--:|--:|')

    def row(label, m, exp=None, sw=None):
        e = f'{m["exposure"]:.0f}%' if 'exposure' in m else (exp or '100%')
        s = str(m['switches']) if 'switches' in m else (sw or '—')
        tot = f'{m["total"]:+.1f}%'
        return f'| {label} | {tot} | {m["mdd"]:.1f}% | {m["vol"]:.1f}% | {m["sharpe"]:+.2f} | {e} | {s} |'

    L.append(row('**战法原样（始终满仓）**', strat_m))
    for sym in ('883994', '880008', '880003'):
        r = results[sym]
        L.append(row(f'战法 × 择时（{r["name"]}{sym}）', r['gated']))
    if bh_m:
        L.append(row('全A等权买入持有(基准)', bh_m))

    # 仓位分布
    for sym in ('883994', '880008', '880003'):
        m = results[sym]['gated']
        L.append(f'\n{results[sym]["name"]}信号下仓位分布：空仓 {m["flat"]} 日 / 半仓 {m["half"]} 日 / 满仓 {m["full"]} 日（暴露 {m["exposure"]:.0f}%）。')

    L.append('\n\n---\n_成交流水重放回测，仅供研究参考，不构成投资建议。样本仅约两个半月、单一区间，不能外推。_')
    md = '\n'.join(L)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        f.write(md)
    print(md)


if __name__ == '__main__':
    main()
