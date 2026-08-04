#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""妙想模拟盘·买点日级回测（只出结论，不改任何现有功能）。

问题：复盘发现「近期标的买点近乎日内最高点」（如行云科技 30.68 买、随后回落）。
用历史日线 + 实际买入样本，量化两件事：
  1) 实际买点在当日振幅中的位置（是否系统性买在高位）；
  2) 若改用几种日级买点规则，后续 N 日收益是否更好。

数据：
  - 样本：backend/data/stock-agent.sqlite 的 sim_trades（妙想镜像战法）side=buy。
  - 日线：腾讯 fqkline（前复权，本机可达；短持有期内除权影响可忽略）。本环境行情端偶发返回
    schema 桩，取数带重试消化。

粒度限制：东财免费分钟线历史仅约 5 日，无法回测 5-7 月日内分时；本脚本按“日级”近似
（今开/昨收/典型价/T+1 回踩为日级近似），分钟级前瞻验证留作后续。

运行：
  python3 mode/mx-entry-timing/entry-timing-backtest.py            # 实跑并生成研究笔记
  python3 mode/mx-entry-timing/entry-timing-backtest.py --selftest # 纯函数自检
"""
import os, sys, ssl, json, time, sqlite3, urllib.request
from datetime import datetime, date

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get(
    'SA_DB', os.path.abspath(os.path.join(HERE, '..', '..', 'backend', 'data', 'stock-agent.sqlite'))
)
CACHE = os.environ.get('SA_CACHE', '/tmp/mx_entry_klcache')
os.makedirs(CACHE, exist_ok=True)
_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE

# 固定持有期（交易日），从各候选买点计到 close_{T+h} 衡量买点质量
HORIZONS = (3, 5)


# ============ 纯函数（可自检） ============

def pos_in_range(actual, low, high):
    """买点在当日振幅中的位置：0=最低价，1=最高价。high==low 归 0.5。"""
    if high <= low:
        return 0.5
    return (actual - low) / (high - low)


def typical_price(high, low, close):
    """典型价 (最高+最低+收)/3。"""
    return (high + low + close) / 3.0


def pullback_fill(open_t, low_t1, ref_price):
    """T+1 回踩买：若 T+1 最低 <= 参考价（今开）则以参考价成交，否则不成交返回 None。"""
    if low_t1 is not None and low_t1 <= ref_price:
        return ref_price
    return None


def ret(entry, exit_close):
    """收益率 (exit-entry)/entry。entry<=0 返回 None。"""
    if entry is None or entry <= 0 or exit_close is None:
        return None
    return (exit_close - entry) / entry


def _selftest():
    # 合成一段日线：索引 0..6
    bars = [
        {'d': '2026-01-01', 'o': 10.0, 'h': 10.5, 'l': 9.8, 'c': 10.2},   # T-1
        {'d': '2026-01-02', 'o': 10.3, 'h': 11.0, 'l': 10.1, 'c': 10.8},  # T (buy day)
        {'d': '2026-01-05', 'o': 10.9, 'h': 11.2, 'l': 10.2, 'c': 10.5},  # T+1 (low 10.2 <= open_T 10.3? no)
        {'d': '2026-01-06', 'o': 10.4, 'h': 10.6, 'l': 10.0, 'c': 10.3},  # T+2
        {'d': '2026-01-07', 'o': 10.3, 'h': 10.9, 'l': 10.1, 'c': 10.7},  # T+3
        {'d': '2026-01-08', 'o': 10.7, 'h': 11.5, 'l': 10.6, 'c': 11.4},  # T+4
        {'d': '2026-01-09', 'o': 11.4, 'h': 11.8, 'l': 11.0, 'c': 11.6},  # T+5
    ]
    T = 1
    actual = 10.95  # 接近当日最高 11.0
    assert abs(pos_in_range(actual, 10.1, 11.0) - (0.85 / 0.9)) < 1e-9, 'pos 计算应为 0.85/0.9'
    assert pos_in_range(actual, 10.1, 11.0) > 0.9  # 买在高位
    assert abs(typical_price(11.0, 10.1, 10.8) - (31.9 / 3)) < 1e-9
    # t1_pullback：T+1 low=10.2 > open_T=10.3? 10.2<=10.3 True → 成交于 10.3
    assert pullback_fill(bars[T]['o'], bars[T + 1]['l'], bars[T]['o']) == 10.3
    # 不成交场景：ref 低于 T+1 最低
    assert pullback_fill(9.0, bars[T + 1]['l'], 9.0) is None
    # 收益：以今开 10.3 到 T+3 收盘 10.7
    r = ret(bars[T]['o'], bars[T + 3]['c'])
    assert abs(r - (10.7 - 10.3) / 10.3) < 1e-9
    assert ret(0, 10) is None and ret(10, None) is None
    print('selftest passed')


# ============ 取数 ============

def _tsym(code):
    """腾讯行情代码前缀：6xx→sh，其余→sz。"""
    return ('sh' if code.startswith('6') else 'sz') + code


def fetch_daily(code, beg, end):
    """腾讯 fqkline 日线（前复权）。返回按日期升序 [{d,o,c,h,l}]。带 /tmp 缓存 + 重试消化间歇 schema 桩。

    腾讯 qfqday 行格式：[date, open, close, high, low, volume]。
    与东财一样，本环境行情端偶发返回非 JSON 的 schema 桩，需重试到拿真实数据。
    """
    fp = os.path.join(CACHE, f'{code}_{beg}_{end}.json')
    if os.path.exists(fp):
        return json.load(open(fp))
    url = (
        'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
        f'?param={_tsym(code)},day,{beg},{end},640,qfq'
    )
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    for attempt in range(8):
        try:
            raw = urllib.request.urlopen(req, timeout=20, context=_ctx).read().decode('utf-8')
            j = json.loads(raw)  # schema 桩非合法 JSON → 抛错触发重试
            node = ((j.get('data') or {}).get(_tsym(code))) or {}
            kl = node.get('qfqday') or node.get('day') or []
            if kl:
                out = [
                    {'d': r[0], 'o': float(r[1]), 'c': float(r[2]), 'h': float(r[3]), 'l': float(r[4])}
                    for r in kl
                ]
                json.dump(out, open(fp, 'w'))
                return out
        except Exception:
            pass
        time.sleep(0.6)
    print(f'  ! 取数失败 {code}（重试耗尽）', file=sys.stderr)
    return []


def load_buys():
    """从 sqlite 读妙想镜像战法的实际买入。返回 [{date,code,name,price}]。"""
    con = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    try:
        sid = con.execute("SELECT id FROM strategies WHERE kind='miaoxiang' LIMIT 1").fetchone()
        if not sid:
            return []
        rows = con.execute(
            "SELECT trade_date, code, name, price FROM sim_trades "
            "WHERE strategy_id=? AND side='buy' ORDER BY trade_date, created_at",
            (sid[0],),
        ).fetchall()
    finally:
        con.close()
    return [{'date': r[0], 'code': r[1], 'name': r[2], 'price': float(r[3])} for r in rows]


# ============ 回测主流程 ============

def run():
    buys = load_buys()
    if not buys:
        print('无买入样本（检查 DB 路径 / 战法）', file=sys.stderr)
        return
    print(f'样本买入 {len(buys)} 笔，加载日线中...')
    # 统一取数窗口：最早买入月的前一月初 ~ 今天（同 code 只取一次，利于缓存）
    d_min = min(datetime.strptime(b['date'], '%Y-%m-%d').date() for b in buys)
    y, m = (d_min.year, d_min.month - 1) if d_min.month > 1 else (d_min.year - 1, 12)
    WIN_BEG = f'{y:04d}-{m:02d}-01'
    WIN_END = date.today().isoformat()

    rules = ['actual', 't_open', 't_typical', 't_prevclose', 't1_open', 't1_pullback']
    # 每规则每 horizon 收集收益；另收集 成本差(相对 actual) 与 成交标记
    rec = {r: {h: [] for h in HORIZONS} for r in rules}
    cost_delta = {r: [] for r in rules}   # (entry-actual)/actual，负=更便宜
    fills = {r: 0 for r in rules}
    pos_list = []          # actual 买点在当日振幅位置
    above_open = 0         # actual 高于今开的笔数
    used, skipped = 0, 0

    for b in buys:
        code, bd, actual = b['code'], b['date'], b['price']
        bars = fetch_daily(code, WIN_BEG, WIN_END)
        idx = next((i for i, x in enumerate(bars) if x['d'] == bd), None)
        if idx is None or idx == 0:
            skipped += 1
            continue
        used += 1
        T = bars[idx]
        prev = bars[idx - 1]
        pos = pos_in_range(actual, T['l'], T['h'])
        pos_list.append(pos)
        if actual > T['o']:
            above_open += 1

        # 候选入场价
        entries = {
            'actual': actual,
            't_open': T['o'],
            't_typical': typical_price(T['h'], T['l'], T['c']),
            't_prevclose': prev['c'],
            't1_open': bars[idx + 1]['o'] if idx + 1 < len(bars) else None,
            't1_pullback': pullback_fill(
                T['o'], bars[idx + 1]['l'] if idx + 1 < len(bars) else None, T['o']
            ),
        }
        for r, e in entries.items():
            if e is None:
                continue
            fills[r] += 1
            cost_delta[r].append((e - actual) / actual)
            for h in HORIZONS:
                j = idx + h
                if j < len(bars):
                    rr = ret(e, bars[j]['c'])
                    if rr is not None:
                        rec[r][h].append(rr)

    _report(used, skipped, len(buys), pos_list, above_open, rules, rec, cost_delta, fills)


def _avg(xs):
    return sum(xs) / len(xs) if xs else None


def _winrate(xs):
    return (sum(1 for x in xs if x > 0) / len(xs)) if xs else None


def _fmt_pct(x):
    return f'{x * 100:+.2f}%' if x is not None else '—'


def _report(used, skipped, total, pos_list, above_open, rules, rec, cost_delta, fills):
    label = {
        'actual': '实际成交(基准)',
        't_open': '今开买',
        't_typical': '典型价(H+L+C)/3',
        't_prevclose': '昨收买',
        't1_open': 'T+1今开买',
        't1_pullback': 'T+1回踩买(不破今开)',
    }
    med_pos = sorted(pos_list)[len(pos_list) // 2] if pos_list else None
    lines = []
    lines.append('# 妙想买点·日级回测结论')
    lines.append('')
    lines.append(f'- 生成时间：{datetime.now().strftime("%Y-%m-%d %H:%M")}')
    lines.append(f'- 样本：实际买入 {total} 笔，有效回测 {used} 笔（跳过 {skipped}：日线缺失/无前一日）')
    lines.append(f'- 数据：腾讯 fqkline 日线（前复权）；持有期 T+{HORIZONS[0]}/T+{HORIZONS[1]} 收盘')
    lines.append('')
    lines.append('## 1. 实际买点是否买在高位')
    if pos_list:
        avg_pos = _avg(pos_list)
        hi = sum(1 for p in pos_list if p >= 0.8) / len(pos_list)
        lines.append(f'- 买点在当日振幅位置：均值 {avg_pos:.2f}、中位数 {med_pos:.2f}（0=最低,1=最高）')
        lines.append(f'- 落在当日“上沿”(≥0.8) 的比例：{hi * 100:.0f}%')
        lines.append(f'- 高于当日今开买入：{above_open}/{len(pos_list)}（{above_open / len(pos_list) * 100:.0f}%）')
    lines.append('')
    lines.append('## 2. 各买点规则后续收益对比')
    header = '| 规则 | 样本(成交) | 相对基准成本 | ' + ' | '.join(f'T+{h}胜率' for h in HORIZONS) + ' | ' + ' | '.join(f'T+{h}均收益' for h in HORIZONS) + ' |'
    sep = '|' + '---|' * (3 + 2 * len(HORIZONS))
    lines.append(header)
    lines.append(sep)
    for r in rules:
        cd = _avg(cost_delta[r])
        row = [
            label[r],
            str(fills[r]),
            _fmt_pct(cd) if r != 'actual' else '—',
        ]
        row += [(_fmt_pct(_winrate(rec[r][h])) if rec[r][h] else '—') for h in HORIZONS]
        row += [(_fmt_pct(_avg(rec[r][h])) if rec[r][h] else '—') for h in HORIZONS]
        lines.append('| ' + ' | '.join(row) + ' |')
    lines.append('')
    lines.append('> 相对基准成本：入场价相对实际成交价的差（负=更便宜）。T+1回踩买含不成交样本，成交数见“样本(成交)”。')

    text = '\n'.join(lines)
    print('\n' + text + '\n')
    out = os.path.join(HERE, f'research-notes-{date.today().isoformat()}.md')
    open(out, 'w').write(text + '\n')
    print(f'已写入 {out}')


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        _selftest()
    else:
        run()
