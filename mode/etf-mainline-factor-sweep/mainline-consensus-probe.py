#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build a near-term mainline consensus report from local deterministic tables.

Inputs:
- market_themes: theme strength and phase history.
- board_newhigh_snapshots: board breadth/new-high snapshot.
- etf_share_daily: ETF share creation/redemption proxy.

These tables are short-history in the current local DB, so this script is a
forward-validation probe, not a 2025-2026 return backtest.
"""
from __future__ import annotations

import ast
import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODE_DIR = Path(__file__).resolve().parent
DB_PATH = ROOT / "backend/data/stock-agent.sqlite"
RESEARCH_SCRIPT = MODE_DIR / "etf-mainline-factor-sweep-research.py"
RUNNER_TRADES = MODE_DIR / "backtest-data/trades_runner_best.md"
OUT = MODE_DIR / "backtest-data/mainline_consensus_probe.md"


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
        ("港股通科技", ("港股通科技")),
        ("美股科技", ("纳指", "纳斯达克", "标普信息科技")),
        ("传媒游戏", ("传媒", "游戏")),
        ("化工", ("化工",)),
        ("金融", ("证券", "银行", "金融科技")),
        ("军工航天", ("军工", "航天", "卫星")),
        ("消费", ("消费", "消费电子")),
        ("能源资源", ("煤炭", "石油", "有色", "黄金", "小金属", "钨", "铅锌")),
        ("宽基", ("科创50", "创业板", "科创创业50")),
        ("信创软件", ("信创", "软件")),
    ]
    for fam, keys in rules:
        if any(k in name for k in keys):
            return fam
    return name.split("(")[0]


MAP_RULES: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
    (("半导体", "芯片", "集成电路", "封测", "存储", "先进封装", "PCB", "元件"), ("半导体设备", "科创芯片", "全球芯片", "中韩半导体", "芯片宽泛")),
    (("通信", "光模块", "光通信", "CPO", "5G", "6G"), ("通信",)),
    (("人工智能", "AI", "算力", "机器人", "数据中心"), ("人工智能", "机器人")),
    (("新能源车", "电池", "锂电", "储能", "锂"), ("电池储能",)),
    (("电网", "电力", "特高压"), ("电网电力",)),
    (("航天", "卫星", "军工", "商业航天"), ("军工航天",)),
    (("传媒", "游戏", "短剧"), ("传媒游戏",)),
    (("创新药", "医药", "生物", "医疗"), ("港股创新药",)),
    (("证券", "银行", "金融", "保险"), ("金融",)),
    (("消费电子", "消费", "食品", "家电"), ("消费",)),
    (("信创", "软件", "华为", "鸿蒙", "国产软件"), ("信创软件", "通信", "消费")),
    (("煤炭", "石油", "有色", "黄金", "稀土", "贵金属", "小金属", "钨", "铅锌"), ("能源资源",)),
    (("互联网", "恒生科技", "港股科技"), ("港美互联网", "恒生科技", "港股通科技")),
]


def map_to_families(name: str) -> set[str]:
    out: set[str] = set()
    for keys, families in MAP_RULES:
        if any(k in name for k in keys):
            out.update(families)
    return out


def parse_history(raw: str) -> tuple[int, float]:
    try:
        xs = json.loads(raw or "[]")
    except Exception:
        return 0, 0.0
    if not isinstance(xs, list) or not xs:
        return 0, 0.0
    vals = [float(x.get("strength", 0.0)) for x in xs if isinstance(x, dict)]
    if not vals:
        return 0, 0.0
    return len(vals), vals[-1] - vals[0]


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


def main() -> None:
    pool = load_pool()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    for row in cur.execute("select code, name from etf_pool").fetchall():
        clean = str(row["name"]).replace("ETF", "").replace("LOF", "").strip()
        pool.setdefault(row["code"], clean or row["name"])

    family_to_etfs: dict[str, list[tuple[str, str]]] = {}
    for code, name in pool.items():
        family_to_etfs.setdefault(family(name), []).append((code, name))

    theme_stat = cur.execute(
        "select count(*) rows, min(first_seen_date) min_date, max(last_seen_date) max_date from market_themes"
    ).fetchone()
    breadth_stat = cur.execute(
        "select count(*) rows, count(distinct trade_date) dates, min(trade_date) min_date, max(trade_date) max_date from board_newhigh_snapshots"
    ).fetchone()
    share_stat = cur.execute(
        "select count(*) rows, count(distinct date) dates, min(date) min_date, max(date) max_date from etf_share_daily"
    ).fetchone()

    theme_rows = cur.execute(
        "select theme, board_code, strength, status, phase, first_seen_date, last_seen_date, strength_history "
        "from market_themes"
    ).fetchall()

    family_theme: dict[str, list[dict[str, object]]] = {}
    for row in theme_rows:
        hist_n, accel = parse_history(row["strength_history"])
        for fam in map_to_families(row["theme"]):
            if fam not in family_to_etfs:
                continue
            phase_bonus = 10 if row["phase"] in ("启动", "加速") else -6 if row["phase"] in ("退潮",) else 0
            status_bonus = 3 if row["status"] == "active" else -8
            score = float(row["strength"]) + 0.25 * accel + phase_bonus + status_bonus + min(hist_n, 8)
            family_theme.setdefault(fam, []).append({"score": score, "row": row, "accel": accel, "hist_n": hist_n})

    latest_breadth = breadth_stat["max_date"]
    breadth_rows = cur.execute(
        "select * from board_newhigh_snapshots where trade_date=? order by rank asc",
        (latest_breadth,),
    ).fetchall() if latest_breadth else []
    family_breadth: dict[str, list[sqlite3.Row]] = {}
    for row in breadth_rows:
        for fam in map_to_families(row["board_name"]):
            if fam in family_to_etfs:
                family_breadth.setdefault(fam, []).append(row)

    share_rows = cur.execute(
        """
        with s as (
          select code,
                 count(*) as n,
                 (select shares from etf_share_daily a where a.code=e.code order by date asc limit 1) as start_shares,
                 (select shares from etf_share_daily a where a.code=e.code order by date desc limit 1) as end_shares,
                 (select close from etf_share_daily a where a.code=e.code order by date desc limit 1) as end_close
          from etf_share_daily e group by code
        )
        select code, n, start_shares, end_shares, end_close,
               (end_shares-start_shares)*1.0/nullif(start_shares,0) as delta_pct,
               (end_shares-start_shares)*end_close as implied_flow
        from s where n>=2
        """
    ).fetchall()
    family_share: dict[str, dict[str, float]] = {}
    for row in share_rows:
        fam = family(pool.get(row["code"], row["code"]))
        stat = family_share.setdefault(fam, {"flow": 0.0, "start_value": 0.0})
        stat["flow"] += float(row["implied_flow"] or 0.0)
        stat["start_value"] += float(row["start_shares"] or 0.0) * float(row["end_close"] or 0.0)

    consensus = []
    for fam, etfs in family_to_etfs.items():
        themes = family_theme.get(fam, [])
        breadth = family_breadth.get(fam, [])
        share = family_share.get(fam, {"flow": 0.0, "start_value": 0.0})
        theme_score = max([float(x["score"]) for x in themes], default=0.0)
        breadth_score = 0.0
        if breadth:
            best_b = min(breadth, key=lambda r: r["rank"])
            breadth_score = float(best_b["new_high_count"]) + 2.0 * float(best_b["ratio"]) + max(0, 20 - int(best_b["rank"]))
        flow = share["flow"]
        share_pct = flow / share["start_value"] if share["start_value"] else 0.0
        share_score = min(max(share_pct * 300, -20), 25)
        total = 0.52 * theme_score + 0.33 * breadth_score + 0.15 * share_score
        consensus.append((total, fam, etfs, themes, breadth, flow, share_pct))
    consensus.sort(reverse=True)

    runner = read_runner_holdings()
    runner_fams = {x["family"] for x in runner}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as f:
        f.write("# 主线共识探针\n\n")
        f.write(f"- 数据库: `{DB_PATH}`\n")
        f.write(f"- `market_themes`: {theme_stat['rows']} 行，{theme_stat['min_date']} 至 {theme_stat['max_date']}\n")
        f.write(f"- `board_newhigh_snapshots`: {breadth_stat['rows']} 行，{breadth_stat['dates']} 个交易日，{breadth_stat['min_date']} 至 {breadth_stat['max_date']}\n")
        f.write(f"- `etf_share_daily`: {share_stat['rows']} 行，{share_stat['dates']} 个交易日，{share_stat['min_date']} 至 {share_stat['max_date']}\n")
        f.write("- 判定: 三类表历史都偏短，不能纳入 2025-2026 收益回测；本报告用于近端主线共识和前向验证。\n\n")

        f.write("## ETF 主题共识排名\n\n")
        f.write("| 排名 | ETF主题 | 共识分 | 最强主题证据 | 板块新高证据 | 份额资金 | Runner持有 | 可交易ETF |\n")
        f.write("|---:|---|---:|---|---|---:|---|---|\n")
        for i, (total, fam, etfs, themes, breadth, flow, share_pct) in enumerate(consensus[:18], 1):
            best_theme = max(themes, key=lambda x: float(x["score"])) if themes else None
            if best_theme:
                tr = best_theme["row"]
                theme_txt = f"{tr['theme']} 强度{float(tr['strength']):.0f}/{tr['phase']}"
            else:
                theme_txt = "-"
            if breadth:
                br = min(breadth, key=lambda r: r["rank"])
                breadth_txt = f"{br['board_name']} 新高{br['new_high_count']}/占比{float(br['ratio']):.1f}%/排名{br['rank']}"
            else:
                breadth_txt = "-"
            etf_txt = "、".join(f"{code} {name}" for code, name in etfs[:4])
            held = "是" if fam in runner_fams else ""
            f.write(f"| {i} | {fam} | {total:.1f} | {theme_txt} | {breadth_txt} | {flow / 1e8:+.2f}亿/{share_pct * 100:+.2f}% | {held} | {etf_txt} |\n")

        f.write("\n## Runner 持仓共识复核\n\n")
        f.write("| 代码 | 标的 | 主题 | 共识排名 | 主题证据 | 宽度证据 | 份额证据 | 结论 |\n")
        f.write("|---|---|---|---:|---|---|---|---|\n")
        rank_by_fam = {fam: (i + 1, row) for i, row in enumerate(consensus) for fam in [row[1]]}
        for h in runner:
            rank, row = rank_by_fam.get(h["family"], (None, None))
            if row:
                _, fam, _, themes, breadth, flow, share_pct = row
                best_theme = max(themes, key=lambda x: float(x["score"])) if themes else None
                theme_txt = f"{best_theme['row']['theme']} 强度{float(best_theme['row']['strength']):.0f}" if best_theme else "-"
                if breadth:
                    br = min(breadth, key=lambda r: r["rank"])
                    breadth_txt = f"{br['board_name']} 新高{br['new_high_count']}/排名{br['rank']}"
                else:
                    breadth_txt = "-"
                share_txt = f"{flow / 1e8:+.2f}亿/{share_pct * 100:+.2f}%"
                verdict = "三源共振" if best_theme and breadth and flow >= 0 else "两源确认" if best_theme and breadth else "证据不足"
            else:
                theme_txt = breadth_txt = share_txt = "-"
                verdict = "无映射"
            f.write(f"| {h['code']} | {h['name']} | {h['family']} | {rank or '-'} | {theme_txt} | {breadth_txt} | {share_txt} | {verdict} |\n")

        f.write("\n## 结论\n\n")
        f.write("- 近端三源共识最强的是半导体/芯片链，通信也有主题和宽度证据，但份额资金偏平稳。\n")
        f.write("- 当前 Runner 持有的通信、全球芯片、中韩半导体均有主题/宽度证据；全球芯片缺少份额数据，中韩半导体份额小幅扩张。\n")
        f.write("- 由于数据历史太短，共识分只能用于前向验证，不可回填历史收益。后续应持续落库后检验“趋势质量 + 主线共识”的 walk-forward 表现。\n")

    print(f"wrote {OUT}")
    print(f"themes={theme_stat['rows']} breadth_dates={breadth_stat['dates']} share_dates={share_stat['dates']}")
    for h in runner:
        rank = rank_by_fam.get(h["family"], (None,))[0]
        print(f"runner {h['code']} {h['name']} family={h['family']} consensus_rank={rank}")


if __name__ == "__main__":
    main()
