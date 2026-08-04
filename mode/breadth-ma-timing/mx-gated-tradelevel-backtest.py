#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""妙想东财模拟盘 × 883994首板赚钱效应择时——交易级重放（结合战法实际买卖单，非收益缩放）。

信号（无未来函数）：883994「昨日打首板表现」收盘，用截至前一交易日的数据算 MA5/MA10：
  <MA10 空仓 / MA10~MA5 半仓 / ≥MA5 满仓。用前一日信号决定当日动作。

门槛只作用在【买入】上，卖出永远按战法真实卖单执行（只卖手上实际持有的量，不卖空）：
  · 满仓：当天买入照常；
  · 半仓：当天每笔新买入的股数砍一半（用户口径）；
  · 空仓：当天不新开仓（跳过当天买入）。

「翻空时已有持仓怎么办」两种口径对比：
  · gate_only：只拦新买入，已有持仓继续按战法真实卖点了结（最贴合"不应该开仓"原话）；
  · force_open：翻空当天用【次日开盘价】把已有持仓也砍到目标仓位（空清空/半减到50%），更硬风控。

执行价：门槛驱动的强制卖出用次日开盘价；战法自身买卖沿用真实成交价（保真）。
数据：/tmp/mxcache/{mx_trades.json, stocks/*.json, 883994.json, 880008.json}
运行：python3 mode/breadth-ma-timing/mx-gated-tradelevel-backtest.py
"""
import json
import math
import os

CACHE = os.environ.get('SA_CACHE', '/tmp/mxcache')
INIT = 1_000_000.0
ANN = 244


def load(fp):
    with open(os.path.join(CACHE, fp)) as f:
        return json.load(f)


def stock_bars(code):
    """{date: {'o':open,'c':close}}"""
    out = {}
    for x in load(f'stocks/{code}.json') or []:
        d = str(x.get('datetime') or '')[:10]
        c = x.get('close')
        if d and c is not None:
            out[d] = {'o': float(x.get('open') or c), 'c': float(c)}
    return out


def index_series(sym):
    o = [(str(x['datetime'])[:10], float(x['close'])) for x in load(f'{sym}.json')]
    o.sort()
    return o


def max_dd(eq):
    pk = eq[0]
    m = 0.0
    for v in eq:
        pk = max(pk, v)
        m = min(m, v / pk - 1)
    return m * 100


def sharpe(rets):
    if len(rets) < 2:
        return float('nan')
    mu = sum(rets) / len(rets)
    sd = math.sqrt(sum((x - mu) ** 2 for x in rets) / (len(rets) - 1))
    return mu * ANN / (sd * math.sqrt(ANN)) if sd else float('nan')


def build_signal(sym='883994'):
    """→ {date: 目标仓位}，用截至前一日的 883994 收盘算 MA5/MA10（无未来函数）。"""
    S = index_series(sym)
    cl = [c for _, c in S]
    pos = {}
    for i in range(1, len(S)):
        prev = cl[:i]  # 截至前一日
        ma5 = sum(prev[-5:]) / len(prev[-5:])
        ma10 = sum(prev[-10:]) / len(prev[-10:])
        c = cl[i - 1]
        pos[S[i][0]] = 0.0 if c < ma10 else (0.5 if c < ma5 else 1.0)
    return pos


def simulate(trades, calendar, bars, signal, mode='gate_only', half_rule='halve'):
    """交易级重放，返回每日收盘净值 [(date, equity)]。

    mode: baseline(照跑) / gate_only(只拦买) / force_open(翻空砍已有持仓)
    half_rule: 半仓时 halve=每笔买入砍半
    """
    # 逐笔应用「成交日期 <= 当前交易日」的未处理成交，避免成交日不在指数日历里被整单丢弃
    ordered = sorted(trades, key=lambda x: (x['date'], x.get('ts', 0)))
    ti = 0
    cash = INIT
    hold = {}
    lastc = {}
    ser = []
    for d in calendar:
        tgt = 1.0 if mode == 'baseline' else signal.get(d, 1.0)
        # force_open：开盘先把【昨日及更早持有】的仓位砍到目标（T+1 安全：今日买入尚未发生）
        if mode == 'force_open' and tgt < 1.0:
            eq_open = cash + sum(q * (bars.get(c, {}).get(d, {}).get('o') or lastc.get(c, 0)) for c, q in hold.items() if q)
            for c in list(hold.keys()):
                q = hold[c]
                if q <= 0:
                    continue
                op = bars.get(c, {}).get(d, {}).get('o') or lastc.get(c)
                if not op:
                    continue
                if tgt == 0.0:
                    sell = q
                else:  # 半仓：按当前持仓市值超出 50%*净值 的比例等比减
                    cur_mv = sum(qq * (bars.get(cc, {}).get(d, {}).get('o') or lastc.get(cc, 0)) for cc, qq in hold.items() if qq)
                    over = cur_mv - 0.5 * eq_open
                    if over <= 0:
                        sell = 0
                    else:
                        sell = min(q, (over / cur_mv) * q) if cur_mv > 0 else 0
                sell = int(sell)
                if sell > 0:
                    cash += sell * op
                    hold[c] = q - sell
        # 当日战法真实成交（买入受门槛约束；卖出只卖持有量）
        while ti < len(ordered) and ordered[ti]['date'] <= d:
            t = ordered[ti]
            ti += 1
            if t['side'] == 'buy':
                sig_t = 1.0 if mode == 'baseline' else signal.get(t['date'], 1.0)  # 按成交单自身日期的信号
                if sig_t == 0.0:
                    qeff = 0
                elif sig_t == 0.5:
                    qeff = t['qty'] * 0.5 if half_rule == 'halve' else t['qty']
                else:
                    qeff = t['qty']
                if qeff > 0:
                    cash -= qeff * t['px']
                    hold[t['code']] = hold.get(t['code'], 0) + qeff
            else:
                qeff = min(t['qty'], hold.get(t['code'], 0))  # 只卖手上有的
                if qeff > 0:
                    cash += qeff * t['px']
                    hold[t['code']] = hold.get(t['code'], 0) - qeff
        # 收盘 MTM
        mv = 0.0
        for c, q in hold.items():
            if q <= 0:
                continue
            px = bars.get(c, {}).get(d, {}).get('c') or lastc.get(c)
            if bars.get(c, {}).get(d, {}).get('c'):
                lastc[c] = bars[c][d]['c']
            if px:
                mv += q * px
        ser.append((d, cash + mv))
    return ser


def metrics(ser):
    eq = [v for _, v in ser]
    rets = [eq[i] / eq[i - 1] - 1 for i in range(1, len(eq))]
    return {'total': (eq[-1] / INIT - 1) * 100, 'mdd': max_dd(eq),
            'sharpe': sharpe(rets), 'final': eq[-1]}


def main():
    trades = json.load(open(os.path.join(CACHE, 'mx_trades.json')))
    codes = sorted({t['code'] for t in trades})
    bars = {c: stock_bars(c) for c in codes}
    i8 = index_series('880008')
    first = min(t['date'] for t in trades)
    last = max(t['date'] for t in trades)
    calendar = [d for d, _ in i8 if first <= d <= last]
    signal = build_signal('883994')

    rows = []
    rows.append(('战法原样(基准)', simulate(trades, calendar, bars, signal, 'baseline')))
    rows.append(('gate_only 只拦买入(半仓砍半)', simulate(trades, calendar, bars, signal, 'gate_only')))
    rows.append(('force_open 翻空砍已有(次日开盘)', simulate(trades, calendar, bars, signal, 'force_open')))

    print('%-30s %9s %9s %7s %10s' % ('口径(883994·0/50/100·MA5/10)', '总收益', '最大回撤', '夏普', '终值(万)'))
    out = []
    for name, ser in rows:
        m = metrics(ser)
        out.append((name, m))
        print('%-30s %+8.1f%% %+8.1f%% %6.2f %9.1f' % (name, m['total'], m['mdd'], m['sharpe'], m['final'] / 1e4))
    # 校验：baseline 终值应≈实际 125.8 万
    print('\n[校验] 基准重放终值 %.1f 万（妙想实际 125.8 万，差异为手续费/口径）' % (out[0][1]['final'] / 1e4))
    return out


if __name__ == '__main__':
    main()
