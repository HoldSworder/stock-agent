"""竞价冠军 Top3 · 候选特征表后处理。

只做能从战法原文确证的检验，不引入原文未给出的评分系数：
  1. 全样本前向收益分布（等权，含竞价基准与可成交基准两套口径）；
  2. 按战法自己给出的竞价倍率分档（<1 / 1~5 / 5~10 / >=10）看是否单调；
  3. 用「按竞价倍率取每日 Top3」这个完全确定的规则，算逐日组合收益。

运行：python3 mode/auction-champion-top3/analyze.py
"""

import csv
import os
import statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))


def load():
    with open(os.path.join(HERE, "candidates.csv"), encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        def num(k):
            v = r[k].strip()
            return float(v) if v else None
        out.append({
            "date": r["信号日"],
            "code": r["代码"],
            "name": r["名称"],
            "pct": num("竞价涨幅%"),
            "amount": num("竞价额(万)"),
            "ratio": num("竞价倍率"),
            "rsi6": num("RSI6"),
            "boards": int(r["昨连板"]),
            "breaks": int(r["昨炸板"]),
            "slip": num("开盘首价溢价%"),
            "t": [num(f"T+{n}%(竞价基准)") for n in (1, 2, 3)],
            "treal": [num(f"T+{n}%(可成交基准)") for n in (1, 2, 3)],
        })
    return out


def desc(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return "无样本"
    win = sum(1 for v in vals if v > 0) / len(vals) * 100
    return (f"n={len(vals):3d} 均值{st.mean(vals):+7.2f}% 中位{st.median(vals):+7.2f}% "
            f"胜率{win:5.1f}% 最好{max(vals):+7.2f}% 最差{min(vals):+7.2f}%")


def main():
    rows = load()
    days = sorted({r["date"] for r in rows})
    print(f"样本：{len(rows)} 只候选 / {len(days)} 个信号日（{days[0]} ~ {days[-1]}）\n")

    print("== 全样本等权前向收益（竞价价基准）==")
    for i, n in enumerate((1, 2, 3)):
        print(f"  T+{n}: {desc([r['t'][i] for r in rows])}")
    print("== 同上，改用 9:30 后首个可成交价基准 ==")
    for i, n in enumerate((1, 2, 3)):
        print(f"  T+{n}: {desc([r['treal'][i] for r in rows])}")
    slips = [r["slip"] for r in rows if r["slip"] is not None]
    print(f"  开盘首价相对竞价价溢价：均值{st.mean(slips):+.2f}% 绝对值均值{st.mean([abs(s) for s in slips]):.2f}%\n")

    print("== 按战法的竞价倍率分档看 T+2（竞价基准）==")
    buckets = [("<1倍 (+0分)", lambda x: x < 1),
               ("1~5倍 (+2分)", lambda x: 1 <= x < 5),
               ("5~10倍 (+5分)", lambda x: 5 <= x < 10),
               (">=10倍 (+7分)", lambda x: x >= 10)]
    for label, cond in buckets:
        sel = [r["t"][1] for r in rows if r["ratio"] is not None and cond(r["ratio"])]
        print(f"  {label:14s} {desc(sel)}")

    print("\n== 规则：每日按竞价倍率取 Top3 等权（原文唯一量化项）==")
    for i, n in enumerate((1, 2, 3)):
        per_day = []
        for d in days:
            same = [r for r in rows if r["date"] == d and r["ratio"] is not None]
            top3 = sorted(same, key=lambda r: -r["ratio"])[:3]
            vals = [r["t"][i] for r in top3 if r["t"][i] is not None]
            if vals:
                per_day.append(st.mean(vals))
        print(f"  T+{n}: 组合逐日 {desc(per_day)}")
    print("\n  逐日明细（T+2，竞价基准）：")
    for d in days:
        same = [r for r in rows if r["date"] == d and r["ratio"] is not None]
        top3 = sorted(same, key=lambda r: -r["ratio"])[:3]
        detail = "  ".join(f"{r['name']}(倍{r['ratio']:.1f}, {r['t'][1]:+.1f}%)" for r in top3 if r["t"][1] is not None)
        vals = [r["t"][1] for r in top3 if r["t"][1] is not None]
        avg = f"{st.mean(vals):+6.2f}%" if vals else "   —  "
        print(f"    {d} 组合{avg}  {detail}")

    print("\n== 单因子扫描：各特征按每日 Top3 选股的 T+2 组合收益（找有排序能力的项）==")
    factors = [
        ("竞价倍率 高→低", lambda r: -r["ratio"] if r["ratio"] is not None else None),
        ("竞价倍率 低→高", lambda r: r["ratio"] if r["ratio"] is not None else None),
        ("竞价额 大→小", lambda r: -r["amount"] if r["amount"] is not None else None),
        ("竞价额 小→大", lambda r: r["amount"] if r["amount"] is not None else None),
        ("竞价涨幅 高→低", lambda r: -r["pct"] if r["pct"] is not None else None),
        ("竞价涨幅 低→高", lambda r: r["pct"] if r["pct"] is not None else None),
        ("竞价涨幅贴近6%", lambda r: abs(r["pct"] - 6) if r["pct"] is not None else None),
        ("RSI6 高→低", lambda r: -r["rsi6"] if r["rsi6"] is not None else None),
        ("RSI6 低→高", lambda r: r["rsi6"] if r["rsi6"] is not None else None),
        ("昨连板 高→低", lambda r: -r["boards"]),
        ("昨炸板 少→多", lambda r: r["breaks"]),
    ]
    baseline = []
    for d in days:
        vals = [r["t"][1] for r in rows if r["date"] == d and r["t"][1] is not None]
        if vals:
            baseline.append(st.mean(vals))
    print(f"  {'全候选等权(基准)':22s} {desc(baseline)}")
    for label, key in factors:
        per_day = []
        for d in days:
            same = [r for r in rows if r["date"] == d and key(r) is not None]
            top3 = sorted(same, key=key)[:3]
            vals = [r["t"][1] for r in top3 if r["t"][1] is not None]
            if vals:
                per_day.append(st.mean(vals))
        print(f"  {label:22s} {desc(per_day)}")


if __name__ == "__main__":
    main()
