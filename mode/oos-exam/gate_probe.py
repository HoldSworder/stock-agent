#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""总开关探针：看「全A等权站上 MA60」这个条件在考试区间里是什么状态。

为什么用这个条件：走出样本考试判死两套规则后，预案是给它加一个「这段时间不该参与」
的总开关。但这个动作极易变成事后拟合——「我知道这两个半月跌，所以加个条件避开」。
约束是必须用一个**早就存在、不是为这次翻车发明**的条件。

「全A等权（通达信 880008）收盘站上 MA60」正是系统里大盘阶段判断（regime）
「等权失真校正」那一维的判据：backend/src/regime/service.ts 的 classifyPhase
要求 eqwAboveMa60 === true 才可能判为主升。它 2026-08 之前就在跑。

本脚本只打印状态，不改任何东西，也不下结论。
运行：cd mode/oos-exam && python3 gate_probe.py
"""
import os
import sys

import requests

HOST = os.environ.get('SA_HOST', '192.168.31.144')
ASTOCK = os.environ.get('SA_ASTOCK', f'http://{HOST}:9119')
# 局域网地址不能走代理，否则本机 7890 会把连接失败包装成 502
PROXIES = {'http': None, 'https': None}


def fetch_880008(limit: int = 400):
    """取全A等权日线。与 backend/src/regime/client.ts 同一个端点与口径。"""
    # sidecar 把每个端点暴露为 GET /api/call/<endpoint>?param=value
    # （与 backend/src/astock/client.ts 一致）
    r = requests.get(
        f'{ASTOCK}/api/call/mootdx_index',
        params={'symbol': '880008', 'frequency': 9, 'offset': limit},
        timeout=30,
        proxies=PROXIES,
    )
    r.raise_for_status()
    data = r.json()
    rows = data.get('data') if isinstance(data, dict) else data
    if not rows:
        raise SystemExit(f'880008 返回空：{str(data)[:200]}')
    out = []
    for row in rows:
        d = str(row.get('date') or row.get('datetime') or '')[:10].replace('/', '-')
        c = row.get('close')
        if d and c:
            out.append((d, float(c)))
    out.sort()
    return out


def main() -> None:
    bars = fetch_880008()
    print(f'取到 {len(bars)} 根日线，{bars[0][0]} ~ {bars[-1][0]}', file=sys.stderr)

    closes = [c for _, c in bars]
    dates = [d for d, _ in bars]
    on_days, off_days = [], []
    for i in range(59, len(closes)):
        ma60 = sum(closes[i - 59 : i + 1]) / 60
        (on_days if closes[i] >= ma60 else off_days).append(dates[i])

    def within(xs, a, b):
        return [x for x in xs if a <= x <= b]

    for label, a, b in [
        ('回测区间 2025-01-02 ~ 2026-06-26', '2025-01-02', '2026-06-26'),
        ('考试区间 2026-06-27 ~ 2026-09-12', '2026-06-27', '2026-09-12'),
        ('考试区间（07-07 起）', '2026-07-07', '2026-09-12'),
    ]:
        on = within(on_days, a, b)
        off = within(off_days, a, b)
        tot = len(on) + len(off)
        if tot == 0:
            print(f'{label}：区间内没有可判日')
            continue
        print(f'{label}：站上 MA60 {len(on)} 天 / 共 {tot} 天（{len(on) / tot:.0%}）')
        if off:
            print(f'  失守 MA60 的日期：{off[0]} ~ {off[-1]}，共 {len(off)} 天')

    # 考试区间逐日明细，便于人工核对而不是只看一个比例
    print('\n考试区间逐日（站上=○ 失守=×）：')
    line = []
    for i in range(59, len(closes)):
        d = dates[i]
        if not ('2026-06-27' <= d <= '2026-09-12'):
            continue
        ma60 = sum(closes[i - 59 : i + 1]) / 60
        line.append(f"{d[5:]}{'○' if closes[i] >= ma60 else '×'}")
    for k in range(0, len(line), 8):
        print('  ' + '  '.join(line[k : k + 8]))


if __name__ == '__main__':
    main()
