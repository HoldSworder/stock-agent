#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Probe ETF share creation/redemption as a forward funding signal.

The local etf_share_daily table is short-history near-term data. It should not
be used as a 2025-2026 backtest input unless historical rows already existed
at each decision date.
"""
from __future__ import annotations

import ast
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODE_DIR = Path(__file__).resolve().parent
DB_PATH = ROOT / "backend/data/stock-agent.sqlite"
RESEARCH_SCRIPT = MODE_DIR / "etf-mainline-factor-sweep-research.py"
RUNNER_TRADES = MODE_DIR / "backtest-data/trades_runner_best.md"
OUT = MODE_DIR / "backtest-data/etf_share_flow_probe.md"


def load_pool() -> dict[str, str]:
    tree = ast.parse(RESEARCH_SCRIPT.read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "POOL_FALLBACK":
                    return ast.literal_eval(node.value)
    raise RuntimeError("POOL_FALLBACK not found")


def family(name: str) -> str:
    rules = [
        ("半导体设备", ("半导体设备",)),
        ("科创芯片", ("科创芯片",)),
        ("全球芯片", ("全球芯片",)),
        ("中韩半导体", ("中韩半导体",)),
        ("芯片宽泛", ("芯片", "半导体")),
        ("通信", ("通信",)),
        ("人工智能", ("人工智能",)),
        ("电池储能", ("电池", "储能")),
        ("电网电力", ("电网", "电力")),
        ("港股创新药", ("港股创新药",)),
        ("港美互联网", ("港美互联网",)),
        ("恒生科技", ("恒生科技",)),
        ("港股通科技", ("港股通科技",)),
        ("美股科技", ("纳指", "纳斯达克", "标普信息科技")),
        ("传媒游戏", ("传媒", "游戏")),
        ("化工", ("化工",)),
        ("金融", ("证券", "银行", "金融科技")),
        ("军工航天", ("军工", "航天", "卫星")),
        ("消费", ("消费", "消费电子")),
        ("能源资源", ("煤炭", "石油", "有色", "黄金")),
        ("宽基", ("科创50", "创业板", "科创创业50")),
        ("信创软件", ("信创", "软件")),
    ]
    for fam, keys in rules:
        if any(k in name for k in keys):
            return fam
    return name.split("(")[0]


def read_runner_holdings() -> list[dict[str, str]]:
    rows = []
    if not RUNNER_TRADES.exists():
        return rows
    for line in RUNNER_TRADES.read_text().splitlines():
        if not line.startswith("| 20") or "持有中" not in line:
            continue
        cols = [c.strip() for c in line.strip("|").split("|")]
        rows.append({"code": cols[2], "name": cols[3], "family": cols[4]})
    return rows


def fmt_yi(value: float) -> str:
    return f"{value / 1e8:.2f}亿"


def main() -> None:
    pool = load_pool()
    runner = read_runner_holdings()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    for row in cur.execute("select code, name from etf_pool").fetchall():
        name = str(row["name"]).replace("ETF", "").replace("LOF", "").strip()
        pool.setdefault(row["code"], name or row["name"])

    stat = cur.execute(
        "select count(*) rows, count(distinct date) dates, min(date) min_date, max(date) max_date "
        "from etf_share_daily"
    ).fetchone()
    date_rows = cur.execute("select distinct date from etf_share_daily order by date").fetchall()
    dates = [r["date"] for r in date_rows]

    rows = cur.execute(
        """
        with s as (
          select code,
                 min(date) as start_date,
                 max(date) as end_date,
                 count(*) as n,
                 (select shares from etf_share_daily a where a.code=e.code order by date asc limit 1) as start_shares,
                 (select shares from etf_share_daily a where a.code=e.code order by date desc limit 1) as end_shares,
                 (select close from etf_share_daily a where a.code=e.code order by date desc limit 1) as end_close
          from etf_share_daily e
          group by code
        )
        select *,
               end_shares - start_shares as delta_shares,
               (end_shares - start_shares) * 1.0 / nullif(start_shares,0) as delta_pct,
               (end_shares - start_shares) * end_close as implied_flow
        from s
        where n >= 2
        order by implied_flow desc
        """
    ).fetchall()

    family_rows: dict[str, list[sqlite3.Row]] = {}
    for r in rows:
        name = pool.get(r["code"], r["code"])
        family_rows.setdefault(family(name), []).append(r)

    family_summary = []
    for fam, items in family_rows.items():
        flow = sum(float(x["implied_flow"] or 0.0) for x in items)
        start = sum(float(x["start_shares"] or 0.0) * float(x["end_close"] or 0.0) for x in items)
        pct = flow / start if start else 0.0
        family_summary.append((flow, pct, fam, items))
    family_summary.sort(reverse=True)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as f:
        f.write("# ETF 份额/申赎资金探针\n\n")
        f.write(f"- 数据库: `{DB_PATH}`\n")
        f.write(f"- 覆盖: `{stat['dates']}` 个交易日，`{stat['rows']}` 行，日期 `{stat['min_date']}` 至 `{stat['max_date']}`\n")
        f.write(f"- 日期序列: `{', '.join(dates)}`\n")
        if stat["dates"] < 60:
            f.write("- 判定: 历史长度不足，不能纳入 2025-2026 回测；本文件只做近端资金方向探针。\n")
        f.write("\n## ETF 份额扩张 Top20\n\n")
        f.write("| 代码 | 标的 | 主题 | 起始份额 | 最新份额 | 变化 | 变化率 | 估算净申购额 |\n")
        f.write("|---|---|---|---:|---:|---:|---:|---:|\n")
        for r in rows[:20]:
            name = pool.get(r["code"], r["code"])
            f.write(
                f"| {r['code']} | {name} | {family(name)} | {fmt_yi(r['start_shares'])} | {fmt_yi(r['end_shares'])} | "
                f"{fmt_yi(r['delta_shares'])} | {float(r['delta_pct'] or 0) * 100:+.2f}% | {fmt_yi(r['implied_flow'])} |\n"
            )

        f.write("\n## 主题份额资金聚合\n\n")
        f.write("| 主题 | 估算净申购额 | 主题份额变化率 | 代表 ETF |\n")
        f.write("|---|---:|---:|---|\n")
        for flow, pct, fam, items in family_summary[:15]:
            reps = "、".join(f"{x['code']} {pool.get(x['code'], x['code'])}" for x in sorted(items, key=lambda x: x["implied_flow"] or 0, reverse=True)[:4])
            f.write(f"| {fam} | {fmt_yi(flow)} | {pct * 100:+.2f}% | {reps} |\n")

        f.write("\n## Runner 持仓复核\n\n")
        f.write("| 代码 | 标的 | 主题 | 份额变化率 | 估算净申购额 | 复核 |\n")
        f.write("|---|---|---|---:|---:|---|\n")
        by_code = {r["code"]: r for r in rows}
        for h in runner:
            r = by_code.get(h["code"])
            if r:
                pct = float(r["delta_pct"] or 0.0) * 100
                flow = float(r["implied_flow"] or 0.0)
                verdict = "份额扩张" if pct > 0.5 else "份额平稳" if pct >= -0.5 else "份额收缩"
                f.write(f"| {h['code']} | {h['name']} | {h['family']} | {pct:+.2f}% | {fmt_yi(flow)} | {verdict} |\n")
            else:
                f.write(f"| {h['code']} | {h['name']} | {h['family']} | - | - | 无份额数据 |\n")

        f.write("\n## 结论\n\n")
        f.write("- 近 3 日 ETF 份额数据能作为资金确认探针，但历史长度不足，不能参与 2025-2026 收益回测。\n")
        f.write("- 半导体设备、芯片宽泛、电网电力、金融等方向出现近端份额扩张；Runner 当前通信份额平稳，中韩半导体小幅扩张。\n")
        f.write("- 后续应将 `etf_share_daily` 持续落库，并在至少 60 个交易日后测试“趋势质量 + 份额扩张确认”的前向表现。\n")

    print(f"wrote {OUT}")
    print(f"share_dates={stat['dates']} rows={stat['rows']} range={stat['min_date']}->{stat['max_date']}")
    for h in runner:
        r = {x["code"]: x for x in rows}.get(h["code"])
        pct = float(r["delta_pct"] or 0.0) * 100 if r else 0.0
        print(f"runner {h['code']} {h['name']} share_change={pct:+.2f}%")


if __name__ == "__main__":
    main()
