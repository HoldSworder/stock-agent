#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全A等权/平均股价 均线择时回测（用户想法：跌破10日线空仓、跌破5日线半仓）。

想法（用户多日观察后提出）：
  以「A股平均股价 / 全A等权指数」这类广度敏感指数为大盘温度计——
    · 指数收盘 < MA10       → 不开仓（0% 仓位）
    · MA10 <= 收盘 < MA5    → 半仓（50%）
    · 收盘 >= MA5           → 满仓（100%）
  据此调节对「大盘本身」的暴露，检验能否比始终满仓(buy&hold)更稳（降回撤/提风险收益比）。

口径与防未来函数：
  · 信号用「前一交易日收盘 vs 其 MA5/MA10」决定「当日」持仓，收益按当日指数涨跌兑现——
    即今日看盘后定明日仓位，无未来函数。
  · MA 用简单移动平均；MA10 需 10 根热身，回测从第 11 根起算。

数据源：
  · 主口径：a-stock-data sidecar 的 mootdx_index（通达信 880003 平均股价 / 880008 全A等权）。
  · 兜底（仅供口径不同的近似参考，SA_PROXY=1 时启用）：akshare 市值加权宽基（默认中证全指 000985）。

运行：
  python3 mode/breadth-ma-timing/breadth-ma-timing-backtest.py
环境变量：
  SA_HOST（默认 192.168.31.144）/ SA_ASTOCK / SA_AKSHARE / SA_PROXY / SA_OUT
"""
import json
import math
import os
import ssl
import sys
import urllib.request

HOST = os.environ.get('SA_HOST', '192.168.31.144')
ASTOCK = os.environ.get('SA_ASTOCK', f'http://{HOST}:9119')
AKSHARE = os.environ.get('SA_AKSHARE', 'https://router.qzran.cn:8091')
USE_PROXY = os.environ.get('SA_PROXY', '') == '1'
OUT = os.environ.get('SA_OUT', os.path.join(os.path.dirname(__file__), 'backtest-data', 'summary_breadth_ma_timing.md'))
ANN = 244  # A股年化交易日近似

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# 目标指数：平均股价 + 全A等权（两条都跑，横向对照）
TARGETS = [
    {'symbol': '880003', 'name': 'A股平均股价'},
    {'symbol': '880008', 'name': '全A等权'},
]


def http_get_json(url):
    """GET 返回 JSON（数组/对象），失败抛异常。"""
    req = urllib.request.Request(url, headers={'User-Agent': 'sa-backtest'})
    with urllib.request.urlopen(req, timeout=45, context=ctx) as resp:
        return json.loads(resp.read())


CACHE = os.environ.get('SA_CACHE', '/tmp/mxcache')  # 本地预取 JSON 缓存目录


def _parse_index_rows(d):
    """把 mootdx_index 原始记录数组解析为升序 [{d,o,h,l,c}]。"""
    bars = []
    for x in (d or []):
        day = str(x.get('datetime') or x.get('date') or '')[:10]
        c = x.get('close')
        if not day or c is None:
            continue
        bars.append({'d': day, 'o': x.get('open') or c, 'h': x.get('high') or c,
                     'l': x.get('low') or c, 'c': float(c)})
    bars.sort(key=lambda b: b['d'])
    return bars


def fetch_index_astock(symbol, offset=1500):
    """取通达信自建指数日线：优先读本地缓存 {SA_CACHE}/{symbol}.json（NAS 本机预取），否则直连 sidecar。"""
    fp = os.path.join(CACHE, f'{symbol}.json')
    if os.path.exists(fp):
        with open(fp) as f:
            return _parse_index_rows(json.load(f))
    d = http_get_json(f'{ASTOCK}/api/call/mootdx_index?symbol={symbol}&frequency=9&offset={offset}')
    return _parse_index_rows(d)


def fetch_index_akshare(symbol='000985', start='20180101', end='20991231'):
    """兜底：akshare 市值加权宽基日线（口径与等权不同，仅供近似方向参考）。"""
    url = (f'{AKSHARE}/api/public/index_zh_a_hist?symbol={symbol}'
           f'&period=daily&start_date={start}&end_date={end}')
    d = http_get_json(url)
    bars = []
    for x in (d or []):
        day = str(x.get('日期') or '')[:10]
        c = x.get('收盘')
        if not day or c is None:
            continue
        bars.append({'d': day, 'o': x.get('开盘') or c, 'h': x.get('最高') or c,
                     'l': x.get('最低') or c, 'c': float(c)})
    bars.sort(key=lambda b: b['d'])
    return bars


def sma(xs, n):
    """简单移动平均序列（前 n-1 项用已有数据均值，供热身对齐）。"""
    out = []
    s = 0.0
    from collections import deque
    q = deque()
    for x in xs:
        q.append(x)
        s += x
        if len(q) > n:
            s -= q.popleft()
        out.append(s / len(q))
    return out


def position_for(close, ma5, ma10):
    """用户择时规则 → 目标仓位。跌破10日线空仓、10日线上但破5日线半仓、站上5日线满仓。"""
    if close < ma10:
        return 0.0
    if close < ma5:
        return 0.5
    return 1.0


def max_drawdown(equity):
    """最大回撤（负数，%）。"""
    peak = equity[0]
    mdd = 0.0
    for v in equity:
        if v > peak:
            peak = v
        dd = v / peak - 1
        if dd < mdd:
            mdd = dd
    return mdd * 100


def stdev(xs):
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def stats(daily_rets, positions=None):
    """由日收益序列算：总收益/年化/最大回撤/年化波动/夏普；带仓位则附暴露与状态占比。"""
    equity = [1.0]
    for r in daily_rets:
        equity.append(equity[-1] * (1 + r))
    total = (equity[-1] - 1) * 100
    n = len(daily_rets)
    years = n / ANN if n else 1
    cagr = ((equity[-1]) ** (1 / years) - 1) * 100 if equity[-1] > 0 and years > 0 else float('nan')
    vol = stdev(daily_rets) * math.sqrt(ANN) * 100
    mean_ann = (sum(daily_rets) / n) * ANN * 100 if n else 0.0
    sharpe = mean_ann / vol if vol else float('nan')
    mdd = max_drawdown(equity)
    calmar = (cagr / abs(mdd)) if mdd else float('nan')
    out = {'total': total, 'cagr': cagr, 'vol': vol, 'sharpe': sharpe,
           'mdd': mdd, 'calmar': calmar, 'days': n, 'equity': equity}
    if positions is not None:
        out['exposure'] = sum(positions) / len(positions) * 100
        out['flat_days'] = sum(1 for p in positions if p == 0.0)
        out['half_days'] = sum(1 for p in positions if p == 0.5)
        out['full_days'] = sum(1 for p in positions if p == 1.0)
        switches = sum(1 for i in range(1, len(positions)) if positions[i] != positions[i - 1])
        out['switches'] = switches
    return out


def cost_scan(idx_rets, positions, bps=(0, 5, 10, 20)):
    """成本敏感度：每日按换手 |Δ仓位| 扣 bp 费用，返回各档 {bp, total, mdd, sharpe}。

    换仓频繁的择时对成本敏感，这一步决定结论是否成立。bp=万分之几（5bp=0.05%）。
    """
    out = []
    for bp in bps:
        rate = bp / 10000.0
        net = []
        prev_p = 0.0
        for r, p in zip(idx_rets, positions):
            turnover = abs(p - prev_p)   # 当日调仓换手（0~1）
            net.append(p * r - turnover * rate)
            prev_p = p
        s = stats(net)
        out.append({'bp': bp, 'total': s['total'], 'mdd': s['mdd'], 'sharpe': s['sharpe']})
    return out


def run_one(bars):
    """在单条指数上跑：用户规则择时 vs 买入持有 vs MA10单线(满/空) vs MA5单线(满/空)。"""
    closes = [b['c'] for b in bars]
    ma5 = sma(closes, 5)
    ma10 = sma(closes, 10)
    # 从第 11 根（idx>=10，前一日 idx>=9 已有 MA10）起算，防热身失真
    strat_rets, strat_pos = [], []
    idx_rets = []  # 指数当日涨跌（供成本敏感度按换手扣费）
    bh_rets = []
    ma10_rets, ma10_pos = [], []
    ma5_rets, ma5_pos = [], []
    seg_year = {}  # 年份 -> [strat_rets], [bh_rets]
    for i in range(11, len(bars)):
        prev = i - 1
        r = closes[i] / closes[prev] - 1  # 当日指数涨跌
        p = position_for(closes[prev], ma5[prev], ma10[prev])
        p10 = 1.0 if closes[prev] >= ma10[prev] else 0.0
        p5 = 1.0 if closes[prev] >= ma5[prev] else 0.0
        strat_rets.append(p * r); strat_pos.append(p)
        idx_rets.append(r)
        ma10_rets.append(p10 * r); ma10_pos.append(p10)
        ma5_rets.append(p5 * r); ma5_pos.append(p5)
        bh_rets.append(r)
        y = bars[i]['d'][:4]
        seg_year.setdefault(y, {'s': [], 'b': [], 'p': []})
        seg_year[y]['s'].append(p * r)
        seg_year[y]['b'].append(r)
        seg_year[y]['p'].append(p)
    return {
        'range': (bars[11]['d'], bars[-1]['d']),
        'user': stats(strat_rets, strat_pos),
        'bh': stats(bh_rets),
        'ma10': stats(ma10_rets, ma10_pos),
        'ma5': stats(ma5_rets, ma5_pos),
        'cost': cost_scan(idx_rets, strat_pos),
        'seg': {y: {'user': stats(v['s'], v['p']), 'bh': stats(v['b'])} for y, v in sorted(seg_year.items())},
    }


def fnum(x, p=1):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return '—'
    return f'{x:+.{p}f}' if p and x is not None else f'{x:.{p}f}'


def render(results):
    """拼 Markdown 汇总。results: [(target, res)]"""
    lines = []
    lines.append('# 全A等权/平均股价 均线择时回测（跌破10日线空仓·跌破5日线半仓）\n')
    lines.append('> 想法：指数<MA10 空仓、MA10~MA5 之间半仓、≥MA5 满仓；标的即持有该指数本身，对照买入持有。\n')
    lines.append('> 口径：前日收盘定当日仓位（无未来函数），SMA，MA10 热身后起算。收益/回撤/波动均为百分比。\n')
    for tgt, res in results:
        a, b = res['range']
        lines.append(f'\n## {tgt["name"]}（{tgt["symbol"]}）　{a} ~ {b}　共 {res["user"]["days"]} 交易日\n')
        lines.append('| 方案 | 总收益 | 年化 | 最大回撤 | 年化波动 | 夏普 | Calmar | 平均仓位 | 换仓次数 |')
        lines.append('|---|--:|--:|--:|--:|--:|--:|--:|--:|')

        def row(label, s, show_exp=True):
            exp = f'{s["exposure"]:.0f}%' if show_exp and 'exposure' in s else '100%'
            sw = str(s['switches']) if 'switches' in s else '—'
            return (f'| {label} | {fnum(s["total"])}% | {fnum(s["cagr"])}% | {fnum(s["mdd"])}% | '
                    f'{s["vol"]:.1f}% | {fnum(s["sharpe"],2)} | {fnum(s["calmar"],2)} | {exp} | {sw} |')

        lines.append(row('**用户规则(0/50/100)**', res['user']))
        lines.append(row('买入持有(基准)', res['bh'], show_exp=False))
        lines.append(row('MA10单线(满/空)', res['ma10']))
        lines.append(row('MA5单线(满/空)', res['ma5']))
        u = res['user']
        lines.append(f'\n仓位分布：空仓 {u["flat_days"]} 日 / 半仓 {u["half_days"]} 日 / 满仓 {u["full_days"]} 日'
                     f'（暴露 {u["exposure"]:.0f}%）。\n')
        # 成本敏感度（用户规则换仓频繁，这一步决定结论成色）
        lines.append('成本敏感度（用户规则，按每次换手 |Δ仓位| 扣费）：\n')
        lines.append('| 单边费率 | 总收益 | 最大回撤 | 夏普 |')
        lines.append('|---|--:|--:|--:|')
        for c in res['cost']:
            lines.append(f'| {c["bp"]}bp | {fnum(c["total"])}% | {fnum(c["mdd"])}% | {fnum(c["sharpe"],2)} |')
        lines.append('')
        # 分年
        lines.append('分年（用户规则 vs 买入持有，总收益% / 最大回撤%）：\n')
        lines.append('| 年份 | 用户规则 收益 | 用户规则 回撤 | 买入持有 收益 | 买入持有 回撤 |')
        lines.append('|---|--:|--:|--:|--:|')
        for y, sv in res['seg'].items():
            lines.append(f'| {y} | {fnum(sv["user"]["total"])}% | {fnum(sv["user"]["mdd"])}% | '
                         f'{fnum(sv["bh"]["total"])}% | {fnum(sv["bh"]["mdd"])}% |')
    lines.append('\n---\n_确定性回测，仅供研究参考，不构成投资建议。手续费/滑点未计（择时换仓频率见换仓次数，可据此估成本敏感度）。_')
    return '\n'.join(lines)


def main():
    results = []
    for tgt in TARGETS:
        try:
            bars = fetch_index_astock(tgt['symbol'])
        except Exception as e:
            sys.stderr.write(f'[sidecar] 取 {tgt["symbol"]} 失败：{e}\n')
            bars = []
        if len(bars) < 60 and USE_PROXY:
            sys.stderr.write(f'[proxy] {tgt["symbol"]} 主源不足，改用 akshare 000985 近似（口径不同！）\n')
            bars = fetch_index_akshare('000985')
            tgt = {'symbol': '000985', 'name': f'{tgt["name"]}→中证全指近似'}
        if len(bars) < 60:
            sys.stderr.write(f'[skip] {tgt["symbol"]} 数据不足（{len(bars)} 根），跳过。\n')
            continue
        res = run_one(bars)
        results.append((tgt, res))
        u, b = res['user'], res['bh']
        sys.stderr.write(f'{tgt["name"]}({tgt["symbol"]}) {res["range"][0]}~{res["range"][1]}: '
                         f'用户规则 总{u["total"]:+.0f}% 回撤{u["mdd"]:.0f}% 夏普{u["sharpe"]:.2f} 暴露{u["exposure"]:.0f}% | '
                         f'买入持有 总{b["total"]:+.0f}% 回撤{b["mdd"]:.0f}% 夏普{b["sharpe"]:.2f}\n')
    if not results:
        sys.stderr.write('无可用数据，未生成报告。请确认 a-stock-data sidecar 已就绪（/health 返回 ok）。\n')
        sys.exit(1)
    md = render(results)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        f.write(md)
    sys.stderr.write(f'\n报告已写入 {OUT}\n')
    print(md)


if __name__ == '__main__':
    main()
