#!/usr/bin/env python3
"""把 mode/ 下各研究模式包解析成 stock-agent 量化研究模式库的种子 JSON。

产物落到 backend/src/seeds/research-modes-seed.json（在 backend/ 下，随镜像 COPY、被 git 跟踪；
注意不能放 backend/data，那目录被 .gitignore/.dockerignore 排除）。
后端 seedResearchModesIfEmpty() 启动时读取它，库为空才灌入，幂等。

纯解析、无副作用、不联网。README 结构规整（标题/推荐候选/回测表/成本表/风险），
按标题分节 + 通用 markdown 表格解析抽取，缺失的字段留空，UI 容错。
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

MODE_DIR = Path(__file__).resolve().parent
OUT = MODE_DIR.parent / "backend" / "src" / "seeds" / "research-modes-seed.json"

# 人工微调：状态 / 分类 / 标签（默认 experiment / ETF趋势轮动）
STATUS = {
    "etf-mainline-profit-runner": "baseline",
    "etf-rs90-top3": "baseline",
    "etf-mainline-rotation": "recommended",
    "etf-mainline-leader-runner": "recommended",
    "etf-mainline-absolute-leader": "recommended",
    "etf-mainline-agile-profit-flat-leader": "recommended",
    "etf-mainline-anti-exhaustion-leader": "recommended",
    "etf-mainline-breadth-confirmed-flat-leader": "recommended",
    "etf-mainline-confirmed-profit-sticky-leader": "recommended",
    "etf-mainline-confirmed-switch-flat-leader": "experiment",
    "etf-mainline-execution-consensus-leader": "recommended",
    "etf-mainline-family-stable-flat-leader": "experiment",
    "etf-mainline-factor-sweep": "experiment",
    "etf-mainline-high-persist-flat-leader": "recommended",
    "etf-mainline-ic-gated-runner": "experiment",
    "etf-mainline-profit-protected-sticky-leader": "recommended",
    "etf-mainline-risk-gated-sticky-leader": "recommended",
    "etf-mainline-sticky-anti-exhaustion-leader": "recommended",
    "etf-mainline-sticky-gap-leader": "recommended",
    "etf-mainline-theme-first-flat-leader": "experiment",
}
TAGS = {
    "etf-mainline-rotation": "ETF,趋势,MACD,RS,Supertrend",
    "etf-rs90-top3": "ETF,RS90,主线轮动,去重",
    "etf-mainline-profit-runner": "ETF,RS90,利润奔跑,逃顶",
    "etf-mainline-absolute-leader": "ETF,绝对动量,龙头,集中",
    "etf-mainline-agile-profit-flat-leader": "ETF,非复利收益,敏捷止盈,高持续,龙头,高于基准",
    "etf-mainline-breadth-confirmed-flat-leader": "ETF,非复利收益,主题宽度,高持续,龙头,高于基准",
    "etf-mainline-leader-runner": "ETF,龙头,集中,奔跑",
    "etf-mainline-anti-exhaustion-leader": "ETF,趋势质量,过热衰竭,龙头",
    "etf-mainline-confirmed-profit-sticky-leader": "ETF,主线确认,盈利保护,黏性持仓,龙头,高于基准",
    "etf-mainline-confirmed-switch-flat-leader": "ETF,非复利收益,连续确认,强者替换,龙头,实验候选",
    "etf-mainline-execution-consensus-leader": "ETF,执行确认,共识因子,龙头,高于基准",
    "etf-mainline-family-stable-flat-leader": "ETF,非复利收益,同主题稳定,代表ETF,去重,实验",
    "etf-mainline-factor-sweep": "ETF,因子扫描,研究,IC",
    "etf-mainline-high-persist-flat-leader": "ETF,非复利收益,主线确认,高持续,龙头,高于基准",
    "etf-mainline-ic-gated-runner": "ETF,IC过滤,主线Runner,研究",
    "etf-mainline-profit-protected-sticky-leader": "ETF,盈利保护,黏性持仓,龙头,高于基准",
    "etf-mainline-risk-gated-sticky-leader": "ETF,风控过滤,黏性持仓,龙头,高于基准",
    "etf-mainline-sticky-anti-exhaustion-leader": "ETF,过热衰竭,黏性持仓,龙头,高于基准",
    "etf-mainline-sticky-gap-leader": "ETF,缺口动量,黏性持仓,龙头,高于基准",
    "etf-mainline-theme-first-flat-leader": "ETF,非复利收益,主题优先,主线映射,同主题去重,实验",
}

# 声明式 spec：填了的模式走站内 system 自跟踪（backend/src/modes 的 TS 引擎按 spec 复算），
# 未填的仍是 external，需外部每日推快照。spec 参数须与该模式 README 的推荐候选逐项对齐，
# 否则站内跟踪结果与回测口径不一致。
SPECS = {
    # theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|
    # theme_breadth_above120>=0.50|theme_amount_power>=0.10|members>=1|4d|min8|themeTop3|
    # pg15%|dd6%|exit=ma120
    "etf-mainline-theme-first-flat-leader": {
        "kind": "themeFirst",
        "themeKey": "mainline_quality_score",
        "leaderKey": "mainline_quality_score",
        "gates": {
            "mainlinePersist": 0.15,
            "themeBreadthAbove120": 0.50,
            "themeAmountPower": 0.10,
            "minThemeMembers": 1,
        },
        "rebalanceDays": 4,
        "minHoldDays": 8,
        "themeTopExit": 3,
        "protectGain": 0.15,
        "protectDrawdown": 0.06,
        "exitMa": 120,
        # 回测 WIN 起点对应的首个交易日，决定复核相位，改动会让持仓路径整体错位
        "anchorDate": "2025-01-02",
    },
}


def num(s: str):
    """'+266.0%' / '-22.2%' / '-' -> float(百分比数值) / None"""
    if s is None:
        return None
    t = s.strip().replace("%", "").replace(",", "").replace("+", "")
    if t in ("", "-", "—", "n/a", "N/A"):
        return None
    m = re.search(r"-?\d+(\.\d+)?", t)
    return float(m.group(0)) if m else None


def parse_tables(md: str):
    """返回 [(rows)]，每个 table 是 list[list[str]]（含表头行，已去分隔行）。"""
    tables = []
    cur = []
    for line in md.splitlines():
        if line.strip().startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            # 分隔行 |---|---| 跳过
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                continue
            cur.append(cells)
        else:
            if len(cur) >= 2:
                tables.append(cur)
            cur = []
    if len(cur) >= 2:
        tables.append(cur)
    return tables


def section(md: str, *keywords: str) -> str | None:
    """抽取以某关键词标题（## …keyword…）开头到下一个同级标题前的正文。"""
    lines = md.splitlines()
    out = []
    grabbing = False
    for line in lines:
        h = re.match(r"^#{2,3}\s+(.*)$", line)
        if h:
            title = h.group(1)
            if grabbing:
                break
            if any(k in title for k in keywords):
                grabbing = True
                continue
        elif grabbing:
            out.append(line)
    text = "\n".join(out).strip()
    return text or None


def first_para(md: str) -> str | None:
    for blk in re.split(r"\n\s*\n", md):
        b = blk.strip()
        if not b or b.startswith("#") or b.startswith("|") or b.startswith("-") or b.startswith(">"):
            continue
        return re.sub(r"\s+", " ", b)[:200]
    return None


def split_sections(md: str):
    """把 markdown 按 H2/H3 切成 (preamble, [(title, body_with_heading)])，正文逐字保留，零丢失。"""
    lines = md.splitlines()
    preamble: list[str] = []
    sections: list[tuple[str, list[str]]] = []
    cur_title: str | None = None
    cur: list[str] = []
    for line in lines:
        h = re.match(r"^(#{2,3})\s+(.*)$", line)
        if h:
            if cur_title is None:
                # 丢弃 H1（标题），其余进 preamble
                if preamble and preamble[-1] == "":
                    preamble.pop()
            else:
                sections.append((cur_title, cur))
            cur_title = h.group(2).strip()
            cur = [line]
        elif cur_title is None:
            if not re.match(r"^#\s+", line):  # 跳过 H1
                preamble.append(line)
        else:
            cur.append(line)
    if cur_title is not None:
        sections.append((cur_title, cur))
    return "\n".join(preamble).strip(), sections


# 章节标题 → 目标字段的关键词
BUYSELL_KW = ("推荐候选", "推荐模式", "推荐执行", "模式规则", "规则", "买卖", "执行", "用法", "操作", "建议用法")
RISK_KW = ("风险",)


def py_docstring(d: Path) -> tuple[str | None, str | None]:
    """无 README 目录的兜底：取 -research.py 的模块 docstring。返回 (name, doc)。"""
    pys = sorted(d.glob("*-research.py")) or sorted(d.glob("*.py"))
    if not pys:
        return None, None
    txt = read(pys[0])
    m = re.search(r'"""(.*?)"""', txt, re.S)
    if not m:
        return None, None
    doc = m.group(1).strip()
    name = doc.splitlines()[0].strip().rstrip("。.") if doc else None
    return name, doc


CFG_KW = re.compile(r"wrot|reset|keep|mom\d|rs\d{2}|rs60|ma\d|above|noabs|rank|trail|fam|factor")


def find_config(md: str) -> str | None:
    """推荐配置：取第一个含「策略关键词」且带 | 的行内反引号串，避开表格数值单元。"""
    for m in re.finditer(r"`([^`\n]+)`", md):
        tok = m.group(1).strip()
        if "|" in tok and CFG_KW.search(tok):
            return tok
    return None


def col_index(header: list[str], *keys: str):
    for i, h in enumerate(header):
        if any(k in h for k in keys):
            return i
    return None


def metrics_from_row(header, row):
    g = lambda *k: (num(row[col_index(header, *k)]) if col_index(header, *k) is not None and col_index(header, *k) < len(row) else None)
    # 「非复利收益」列优先匹配；「收益/复利收益/全段」匹配复利总收益。
    flat_idx = col_index(header, "非复利")
    flat = num(row[flat_idx]) if flat_idx is not None and flat_idx < len(row) else None
    return {
        "return": g("复利收益", "收益", "全段", "总收益"),
        "flatReturn": flat,
        "annualized": g("年化"),
        "maxDrawdown": g("回撤"),
        "trades": (int(g("交易")) if g("交易") is not None else None),
        "avgPositions": g("均仓"),
        "maxPositions": (int(g("最大持仓")) if g("最大持仓") is not None else None),
    }


def is_cost_header(header) -> bool:
    if col_index(header, "收益") is None:
        return False
    return (
        ("口径" in header[0])
        or col_index(header, "成本") is not None
        or col_index(header, "成交口径") is not None
        or col_index(header, "口径") is not None
    )


YEAR = re.compile(r"20\d{2}")


def core_table(md: str):
    """回测/核心结果 表：含「收益」「回撤」列且非成本表的第一个表。"""
    for t in parse_tables(md):
        header = t[0]
        if col_index(header, "收益", "全段", "总收益") is not None and col_index(header, "回撤") is not None:
            if is_cost_header(header):
                continue
            return header, t[1:]
    return None


def candidate_review(md: str):
    """summary 的「候选复核」表：含收益/回撤，且存在标签带 候选/全段/年份 的行。
    返回 (full_metrics, segments[]) 或 None。"""
    for t in parse_tables(md):
        header = t[0]
        if col_index(header, "收益", "全段", "总收益") is None or col_index(header, "回撤") is None or is_cost_header(header):
            continue
        rows = t[1:]
        labeled = [r for r in rows if r and ("候选" in r[0] or "全段" in r[0] or YEAR.search(r[0]))]
        if not labeled:
            continue
        full = next((r for r in rows if r and ("全段" in r[0] or "候选" in r[0]) and not YEAR.search(r[0])), None)
        if full is None:
            full = labeled[0]
        full_m = metrics_from_row(header, full)
        segs = []
        for r in rows:
            if r is full or not r:
                continue
            ym = YEAR.search(r[0])
            if ym:
                m = metrics_from_row(header, r)
                segs.append({"label": r[0], "return": m["return"], "maxDrawdown": m["maxDrawdown"], "trades": m["trades"]})
        return full_m, segs
    return None


def cost_table(md: str):
    for t in parse_tables(md):
        header = t[0]
        if is_cost_header(header):
            return header, t[1:]
    return None


def build_cost_rows(tbl):
    ch, crows = tbl
    ci_ret = col_index(ch, "收益")
    ci_dd = col_index(ch, "回撤")
    ci_tr = col_index(ch, "交易")
    ci_kou = col_index(ch, "口径") if col_index(ch, "口径") is not None else col_index(ch, "成交口径")
    ci_cost = col_index(ch, "成本")
    out = []
    for r in crows:
        if not r:
            continue
        cal = r[0]
        if ci_kou is not None and ci_kou != 0 and ci_kou < len(r):
            cal = r[ci_kou]
        if ci_cost is not None and ci_cost < len(r) and r[ci_cost] not in ("", cal):
            cal = f"{cal} {r[ci_cost]}"
        out.append({
            "caliber": cal,
            "return": num(r[ci_ret]) if ci_ret is not None and ci_ret < len(r) else None,
            "maxDrawdown": num(r[ci_dd]) if ci_dd is not None and ci_dd < len(r) else None,
            "trades": (int(num(r[ci_tr])) if ci_tr is not None and ci_tr < len(r) and num(r[ci_tr]) is not None else None),
        })
    return out


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except Exception:
        return ""


def pick_trades(bt_dir: Path) -> str | None:
    if not bt_dir.is_dir():
        return None
    cands = sorted(bt_dir.glob("trades_*.md"))
    # 偏好 family / best / 推荐相关
    for kw in ("family", "best", "profit", "leader", "runner"):
        for c in cands:
            if kw in c.name:
                return read(c)
    return read(cands[0]) if cands else None


def build_mode(d: Path):
    readme = read(d / "README.md")
    summary_files = sorted((d / "backtest-data").glob("summary_*.md"))
    notes = sorted(d.glob("research-notes-*.md")) + sorted(d.glob("*search*.md")) + sorted(d.glob("*improvement*.md"))

    ana_parts: list[str] = []
    if readme:
        title_m = re.search(r"^#\s+(.+)$", readme, re.M)
        name = title_m.group(1).strip() if title_m else d.name
        rec_cfg = find_config(readme)
        # 按 README 章节无损路由：风险→risksMd，推荐/规则/用法→buySellMd，其余正文（含诊断/结论）→analysisMd
        preamble, sections = split_sections(readme)
        buy_parts: list[str] = []
        risk_parts: list[str] = []
        if preamble:
            ana_parts.append(preamble)
        for title, body in sections:
            blk = "\n".join(body).strip()
            if not blk:
                continue
            if any(k in title for k in RISK_KW):
                risk_parts.append(blk)
            elif any(k in title for k in BUYSELL_KW):
                buy_parts.append(blk)
            else:
                ana_parts.append(blk)
        summary_text = first_para(readme)
    else:
        # 无 README 目录（如 anti-exhaustion-leader / ic-gated-runner）：用 -research.py 的 docstring 兜底
        name, doc = py_docstring(d)
        if not doc and not summary_files:
            return None
        name = name or d.name
        rec_cfg = None
        buy_parts, risk_parts = [], []
        if doc:
            ana_parts.append(doc)
        summary_text = re.sub(r"\s+", " ", doc)[:200] if doc else first_para(read(summary_files[0])) if summary_files else None

    # analysisMd 逐字纳入全部 notes 与全部 summary（不再 12000 截断），保证 mode/ 文本零丢失
    for nf in notes:
        ana_parts.append(f"---\n\n## 研究笔记：{nf.name}\n\n" + read(nf))
    for sf in summary_files:
        ana_parts.append(f"---\n\n## 回测汇总：{sf.name}\n\n" + read(sf))
    analysis = "\n\n".join(p for p in ana_parts if p and p.strip()) or None
    buy_sell = "\n\n".join(buy_parts) or None
    risks = "\n\n".join(risk_parts) or None

    summary = read(summary_files[0]) if summary_files else ""

    cost = cost_table(summary) or (cost_table(readme) if readme else None)
    cost_rows = build_cost_rows(cost) if cost else []
    trades_md = pick_trades(d / "backtest-data")

    backtests = []
    cr = candidate_review(summary) if summary else None
    if cr:
        full_m, segs = cr
        backtests.append({
            "label": (rec_cfg or "推荐候选"),
            "range": "2025-01-02 ~ 2026-06-26",
            "poolSize": 55,
            "metrics": full_m,
            "costSensitivity": cost_rows,
            "segments": segs,
            "tradesMd": trades_md,
            "isRecommended": True,
        })

    ct = core_table(readme) if readme else None
    if ct:
        header, rows = ct
        label_of = lambda r: (r[0] if r else "")
        # 无 summary 推荐时，从 README 核心表里选推荐行（含 推荐/本版，否则收益最高）
        rec_idx = -1
        if not cr:
            rec_idx = next((i for i, r in enumerate(rows) if any(k in label_of(r) for k in ("推荐", "本版"))), -1)
            if rec_idx < 0:
                best, bi = None, 0
                for i, r in enumerate(rows):
                    m = metrics_from_row(header, r)
                    if m["return"] is not None and (best is None or m["return"] > best):
                        best, bi = m["return"], i
                rec_idx = bi
        for i, r in enumerate(rows):
            m = metrics_from_row(header, r)
            is_rec = (not cr) and (i == rec_idx)
            backtests.append({
                "label": label_of(r) or f"版本{i+1}",
                "range": "2025-01-02 ~ 2026-06-26",
                "poolSize": 55,
                "metrics": m,
                "costSensitivity": cost_rows if is_rec else [],
                "segments": [],
                "tradesMd": trades_md if is_rec else None,
                "isRecommended": is_rec,
            })

    mode = {
        "id": d.name,
        "name": name,
        "category": "ETF趋势轮动",
        "tags": TAGS.get(d.name, "ETF,趋势"),
        "status": STATUS.get(d.name, "experiment"),
        "summary": summary_text,
        "recommendedConfig": rec_cfg,
        "buySellMd": buy_sell,
        "analysisMd": analysis,
        "risksMd": risks,
        "trackingMode": "system" if d.name in SPECS else "external",
        "source": "codex",
    }
    if d.name in SPECS:
        mode["spec"] = SPECS[d.name]
    return {"mode": mode, "backtests": backtests}


def main():
    out = []
    for d in sorted(p for p in MODE_DIR.iterdir() if p.is_dir()):
        entry = build_mode(d)
        if entry:
            out.append(entry)
            bt = len(entry["backtests"])
            print(f"  ✓ {d.name}: {bt} 回测版本", file=sys.stderr)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写入 {len(out)} 个模式 → {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
