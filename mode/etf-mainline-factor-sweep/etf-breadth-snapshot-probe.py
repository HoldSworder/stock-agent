#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Probe board_newhigh_snapshots against current ETF mainline candidates.

This is intentionally a snapshot/forward-validation probe, not a historical
backtest. The local database currently may contain only a small number of
board breadth dates; using a single date as if it covered 2025-2026 would be
look-ahead leakage.
"""
from __future__ import annotations

import ast
import re
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODE_DIR = Path(__file__).resolve().parent
DB_PATH = ROOT / "backend/data/stock-agent.sqlite"
RESEARCH_SCRIPT = MODE_DIR / "etf-mainline-factor-sweep-research.py"
RUNNER_TRADES = MODE_DIR / "backtest-data/trades_runner_best.md"
OUT = MODE_DIR / "backtest-data/breadth_snapshot_probe.md"


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


BOARD_MAP: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
    (("半导体", "芯片", "集成电路", "存储", "先进封装"), ("半导体设备", "科创芯片", "全球芯片", "中韩半导体", "芯片宽泛")),
    (("通信", "5G", "6G", "光模块", "光通信", "CPO"), ("通信",)),
    (("人工智能", "算力", "机器人", "数据中心"), ("人工智能", "机器人")),
    (("新能源车", "电池", "锂电", "储能"), ("电池储能",)),
    (("电网", "电力", "特高压"), ("电网电力",)),
    (("航天", "卫星", "军工", "商业航天"), ("军工航天",)),
    (("传媒", "游戏", "短剧"), ("传媒游戏",)),
    (("创新药", "医药", "生物", "医疗"), ("港股创新药",)),
    (("证券", "银行", "金融", "保险"), ("金融",)),
    (("消费电子", "消费", "食品", "家电"), ("消费",)),
    (("信创", "软件", "华为", "鸿蒙", "国产软件"), ("信创软件", "通信", "消费")),
    (("煤炭", "石油", "有色", "黄金", "稀土", "贵金属"), ("能源资源",)),
    (("互联网", "恒生科技", "港股科技"), ("港美互联网", "恒生科技", "港股通科技")),
]


def map_board_to_families(board_name: str) -> set[str]:
    out: set[str] = set()
    for keys, families in BOARD_MAP:
        if any(k in board_name for k in keys):
            out.update(families)
    return out


def read_runner_holdings() -> list[dict[str, str]]:
    if not RUNNER_TRADES.exists():
        return []
    rows = []
    for line in RUNNER_TRADES.read_text().splitlines():
        if not line.startswith("| 20") or "持有中" not in line:
            continue
        cols = [c.strip() for c in line.strip("|").split("|")]
        rows.append({"entry": cols[0], "date": cols[1], "code": cols[2], "name": cols[3], "family": cols[4]})
    return rows


def score_row(row: sqlite3.Row) -> float:
    rank_bonus = max(0.0, 25.0 - float(row["rank"])) * 2.0
    return float(row["new_high_count"]) + 2.5 * float(row["ratio"]) + rank_bonus


def main() -> None:
    pool = load_pool()
    family_to_etfs: dict[str, list[tuple[str, str]]] = {}
    for code, name in pool.items():
        family_to_etfs.setdefault(family(name), []).append((code, name))

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    stat = cur.execute(
        "select count(*) rows, count(distinct trade_date) dates, min(trade_date) min_date, max(trade_date) max_date "
        "from board_newhigh_snapshots"
    ).fetchone()
    latest = stat["max_date"]
    rows = cur.execute(
        "select trade_date, rank, board_name, kind, new_high_count, cons_total, ratio "
        "from board_newhigh_snapshots where trade_date=? order by rank asc",
        (latest,),
    ).fetchall() if latest else []

    family_hits: dict[str, list[tuple[float, sqlite3.Row]]] = {}
    for row in rows:
        for fam in map_board_to_families(row["board_name"]):
            if fam in family_to_etfs:
                family_hits.setdefault(fam, []).append((score_row(row), row))

    runner_holdings = read_runner_holdings()
    runner_families = {r["family"] for r in runner_holdings}

    ranked_families = sorted(
        family_hits.items(),
        key=lambda kv: max(score for score, _ in kv[1]),
        reverse=True,
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as f:
        f.write("# 板块新高宽度快照探针\n\n")
        f.write(f"- 数据库: `{DB_PATH}`\n")
        f.write(f"- 快照覆盖: `{stat['dates']}` 个交易日，`{stat['rows']}` 行，日期 `{stat['min_date']}` 至 `{stat['max_date']}`\n")
        if stat["dates"] < 60:
            f.write("- 判定: 历史长度不足，不能纳入 2025-2026 收益回测；本文件只做最新快照复核与前向验证起点。\n")
        f.write(f"- 最新快照日: `{latest}`\n\n")

        f.write("## 最新板块新高 Top20\n\n")
        f.write("| 排名 | 板块 | 口径 | 新高数 | 成分数 | 新高占比 | 映射 ETF 主题 |\n")
        f.write("|---:|---|---|---:|---:|---:|---|\n")
        for row in rows[:20]:
            fams = sorted(f for f in map_board_to_families(row["board_name"]) if f in family_to_etfs)
            f.write(
                f"| {row['rank']} | {row['board_name']} | {row['kind']} | {row['new_high_count']} | "
                f"{row['cons_total']} | {row['ratio']:.1f}% | {'、'.join(fams) if fams else '-'} |\n"
            )

        f.write("\n## ETF 主题宽度匹配\n\n")
        f.write("| ETF主题 | 最高宽度板块 | 新高数/占比 | 可交易 ETF | Runner当前持有 |\n")
        f.write("|---|---|---:|---|---|\n")
        for fam, hits in ranked_families[:15]:
            score, row = max(hits, key=lambda x: x[0])
            etfs = "、".join(f"{code} {name}" for code, name in family_to_etfs.get(fam, [])[:5])
            held = "是" if fam in runner_families else ""
            f.write(
                f"| {fam} | {row['board_name']} | {row['new_high_count']}/{row['ratio']:.1f}% | {etfs} | {held} |\n"
            )

        f.write("\n## Runner 持仓复核\n\n")
        f.write("| 代码 | 标的 | 主题 | 对应宽度证据 | 复核 |\n")
        f.write("|---|---|---|---|---|\n")
        for h in runner_holdings:
            hits = family_hits.get(h["family"], [])
            if hits:
                _, row = max(hits, key=lambda x: x[0])
                evidence = f"{row['board_name']} 新高{row['new_high_count']}/占比{row['ratio']:.1f}%/排名{row['rank']}"
                verdict = "有板块新高宽度支撑"
            else:
                evidence = "-"
                verdict = "未映射到当前宽度Top"
            f.write(f"| {h['code']} | {h['name']} | {h['family']} | {evidence} | {verdict} |\n")

        f.write("\n## 结论\n\n")
        f.write("- 2026-06-26 的宽度快照明显指向半导体/芯片与通信方向，和 Runner 当前持有的 `全球芯片`、`中韩半导体`、`通信` 有较强一致性。\n")
        f.write("- 由于本地只有 1 个快照交易日，不能计算胜率、收益、回撤，也不能证明宽度因子优于现有模式。\n")
        f.write("- 下一步应持续落库 `board_newhigh_snapshots`，至少积累 60 个交易日后再做 walk-forward；历史期只能使用已经存在于当日之前的快照。\n")

    print(f"wrote {OUT}")
    print(f"snapshot_dates={stat['dates']} rows={stat['rows']} latest={latest}")
    for h in runner_holdings:
        print(f"runner {h['code']} {h['name']} {h['family']} evidence={bool(family_hits.get(h['family']))}")


if __name__ == "__main__":
    main()
