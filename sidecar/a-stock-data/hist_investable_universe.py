# -*- coding: utf-8 -*-
"""hist_investable_universe — production daily isST overlay for a-stock-data sidecar.

GET /api/call/hist_investable_universe?asof=YYYY-MM-DD&exclude_st=1
Defaults: st_mode=daily, miss_policy=conservative_out, exclude_st=1.
Name heuristics are NOT on the enough path (only st_mode=heuristic contrast).

ST SoT = Mac Baostock daily isST panel JSON(s). Configure via:
  HIST_ISST_PANEL_DIR   (default empty; look for baostock_isST_panel_{asof}.json)
  HIST_STOCK_BASIC_PATH (baostock stock_basic JSON)
  HIST_TRADE_DATES_PATH (trade dates JSON list)
Optional query params panel_dir / basic_path / trade_dates_path override env.

Mac panel SoT example:
  /Users/qiuzhuoran/orca/workspaces/stock-agent/.scratch/st-isST-panel-20261021
Box baostock:10030 is unreachable — never claim box can live-pull.

Rules (G5-HIST-UNIVERSE-RULES-NAILED-20261021):
  HS A only (exclude BJ); delist day OUT; half-open ST (hat-on OUT / hat-off IN);
  month-end = last trading day when month=YYYY-MM.

Version: hist_investable_universe@prod-daily-isst-20261021
≠ clear B63 hang ≠ freeze ≠ backtest; pool total gate still hung.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

TZ = timezone(timedelta(hours=8))
VERSION = "hist_investable_universe@prod-daily-isst-20261021"
ST_MODES = ("daily", "events", "heuristic", "off")
ST_MODES_EXT = ST_MODES + ("daily+events",)

DEFAULT_PANEL_DIR = os.environ.get("HIST_ISST_PANEL_DIR", "").strip()
DEFAULT_BASIC_PATH = os.environ.get("HIST_STOCK_BASIC_PATH", "").strip()
DEFAULT_TRADE_DATES_PATH = os.environ.get("HIST_TRADE_DATES_PATH", "").strip()


def now_iso() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%dT%H:%M:%S%z")


def bare_code(bs_code: str) -> str:
    return bs_code.split(".", 1)[1] if "." in bs_code else bs_code


def is_bj(bs_code: str, bare: str) -> bool:
    c = bs_code.lower()
    if c.startswith("bj."):
        return True
    if bare.startswith(("8", "4")) and len(bare) == 6:
        return True
    return False


def load_basic(path: Path) -> list[dict]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return raw["rows"] if isinstance(raw, dict) and "rows" in raw else raw


def load_trade_dates(path: Path) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "dates" in data:
        return list(data["dates"])
    return list(data)


def load_st_events(path: Path | None) -> dict[str, list[dict]]:
    if not path:
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    out: dict[str, list[dict]] = {}
    for item in data.get("events", data if isinstance(data, list) else []):
        code = item["code"]
        intervals = item.get("intervals") or [
            {"st_start": item["st_start"], "st_end": item.get("st_end")}
        ]
        out[code] = intervals
    return out


def load_st_daily(path: Path | None) -> dict[tuple[str, str], int]:
    if not path:
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("rows") if isinstance(data, dict) else data
    if rows is None:
        rows = []
    out: dict[tuple[str, str], int] = {}
    for r in rows:
        code = str(r.get("code") or "").strip()
        if not code and r.get("bs_code"):
            code = bare_code(str(r["bs_code"]))
        if "." in code:
            code = bare_code(code)
        date = str(r.get("date") or "")[:10]
        if not code or not date:
            continue
        try:
            is_st = int(str(r.get("isST", r.get("is_st", 0))).strip())
        except ValueError:
            is_st = 1 if str(r.get("isST")).strip().lower() in ("1", "true", "yes") else 0
        out[(code, date)] = 1 if is_st else 0
    return out


def resolve_panel_path(panel_dir: str, asof: str, st_daily_path: str = "") -> Path | None:
    if st_daily_path:
        p = Path(st_daily_path)
        return p if p.is_file() else None
    if not panel_dir:
        return None
    d = Path(panel_dir)
    candidates = [
        d / f"baostock_isST_panel_{asof}.json",
        d / f"isST_panel_{asof}.json",
        d / asof / "panel.json",
    ]
    for c in candidates:
        if c.is_file():
            return c
    return None


def st_from_events(code: str, asof: str, st_events: dict[str, list[dict]]) -> tuple[bool | None, str]:
    if code not in st_events:
        return None, "events_absent"
    for iv in st_events[code]:
        start = (iv.get("st_start") or "")[:10]
        end = (iv.get("st_end") or "")[:10]
        if start and asof >= start and (not end or asof < end):
            return True, f"st_events[{start},{end or '∞'})"
    return False, "st_events_miss"


def is_st_at(
    code: str,
    name: str,
    asof: str,
    exclude_st: bool,
    st_mode: str,
    st_events: dict[str, list[dict]],
    st_daily: dict[tuple[str, str], int],
    miss_policy: str,
) -> tuple[bool, str, str]:
    if not exclude_st or st_mode == "off":
        return False, "exclude_st=0_or_off", "n/a"

    if st_mode in ("daily", "daily+events"):
        key = (code, asof)
        if key in st_daily:
            v = st_daily[key]
            return bool(v), f"daily_isST={v}", "hit"
        if st_mode == "daily+events":
            known, why = st_from_events(code, asof, st_events)
            if known is not None:
                return known, f"events_fill:{why}", "miss_filled_events"
        if miss_policy == "conservative_out":
            return True, "daily_miss:conservative_out", "miss"
        if miss_policy == "bucket":
            return True, "daily_miss:bucket_out", "miss"
        return False, "daily_miss:allow_in", "miss"

    if st_mode == "events":
        known, why = st_from_events(code, asof, st_events)
        if known is None:
            if miss_policy in ("conservative_out", "bucket"):
                return True, f"events_absent:{miss_policy}", "miss"
            return False, "events_absent:allow_in", "miss"
        return known, why, "hit"

    if st_mode == "heuristic":
        if "ST" in (name or "").upper():
            return True, "name_heuristic_current", "heuristic"
        return False, "not_st_heuristic", "heuristic"

    raise ValueError(f"unknown st_mode={st_mode}")


def eligible_hs_a(row: dict, asof: str) -> bool:
    code_bs = row.get("code") or ""
    bare = bare_code(code_bs)
    typ = str(row.get("type") or "")
    ipo = (row.get("ipoDate") or row.get("ipo_date") or "")[:10]
    out = (row.get("outDate") or row.get("out_date") or "")[:10]
    if typ != "1":
        return False
    if not (code_bs.startswith("sh.") or code_bs.startswith("sz.")):
        return False
    if is_bj(code_bs, bare):
        return False
    if not ipo or ipo > asof:
        return False
    if out and out <= asof:
        return False
    return True


def member_ok(
    row: dict,
    asof: str,
    exclude_st: bool,
    st_mode: str,
    st_events: dict[str, list[dict]],
    st_daily: dict[tuple[str, str], int],
    miss_policy: str,
) -> tuple[bool, str, str]:
    code_bs = row.get("code") or ""
    bare = bare_code(code_bs)
    typ = str(row.get("type") or "")
    name = row.get("code_name") or row.get("codeName") or ""
    ipo = (row.get("ipoDate") or row.get("ipo_date") or "")[:10]
    out = (row.get("outDate") or row.get("out_date") or "")[:10]

    if typ != "1":
        return False, "type!=1", "n/a"
    if not (code_bs.startswith("sh.") or code_bs.startswith("sz.")):
        return False, "market", "n/a"
    if is_bj(code_bs, bare):
        return False, "bj", "n/a"
    if not ipo or ipo > asof:
        return False, "not_listed", "n/a"
    if out and out <= asof:
        return False, "delisted", "n/a"
    st, why, cov = is_st_at(
        bare, name, asof, exclude_st, st_mode, st_events, st_daily, miss_policy
    )
    if st:
        return False, f"st:{why}", cov
    return True, "in", cov


def build_universe(
    rows: list[dict],
    asof: str,
    exclude_st: bool,
    st_mode: str,
    st_events: dict[str, list[dict]],
    st_daily: dict[tuple[str, str], int],
    miss_policy: str,
) -> tuple[list[dict], dict]:
    members: list[dict] = []
    eligible = 0
    for r in rows:
        if eligible_hs_a(r, asof):
            eligible += 1
        ok, reason, _tag = member_ok(
            r, asof, exclude_st, st_mode, st_events, st_daily, miss_policy
        )
        if ok:
            members.append(
                {
                    "bs_code": r.get("code") or "",
                    "code": bare_code(r.get("code") or ""),
                    "name": r.get("code_name") or "",
                    "ipoDate": (r.get("ipoDate") or "")[:10],
                    "outDate": (r.get("outDate") or "")[:10],
                }
            )
    members.sort(key=lambda x: x["code"])

    cov2 = {"hit": 0, "miss": 0, "miss_filled_events": 0, "heuristic": 0, "n/a": 0}
    for r in rows:
        if not eligible_hs_a(r, asof):
            continue
        bare = bare_code(r.get("code") or "")
        _, _, tag = is_st_at(
            bare,
            r.get("code_name") or "",
            asof,
            exclude_st,
            st_mode,
            st_events,
            st_daily,
            miss_policy,
        )
        cov2[tag if tag in cov2 else "n/a"] = cov2.get(tag if tag in cov2 else "n/a", 0) + 1

    coverage = {
        "eligible_hs_a": eligible,
        "st_coverage": cov2,
        "covered": cov2["hit"] + cov2["miss_filled_events"] + cov2["heuristic"],
        "missing": cov2["miss"],
        "coverage_rate": round(
            (cov2["hit"] + cov2["miss_filled_events"] + cov2["heuristic"]) / eligible, 6
        )
        if eligible
        else None,
        "miss_policy": miss_policy,
        "st_mode": st_mode,
    }
    return members, coverage


def last_trade_day(dates: list[str], yyyymm: str) -> str:
    cands = [d for d in dates if d.startswith(yyyymm)]
    if not cands:
        raise ValueError(f"no trading day for {yyyymm}")
    return cands[-1]


def codes_sha256(members: list[dict]) -> str:
    blob = "\n".join(m["code"] for m in members) + "\n"
    return hashlib.sha256(blob.encode()).hexdigest()


def st_rule_note(st_mode: str) -> str:
    if st_mode == "daily":
        return (
            "Mac Baostock daily isST panel (isST==1⇔OUT; half-open align); "
            "NO name_heuristic on enough path; miss→miss_policy"
        )
    if st_mode == "daily+events":
        return "daily isST first; curated st_events fill miss only; NO name_heuristic"
    if st_mode == "events":
        return "curated st_events half-open [start,end); miss→miss_policy; NO name_heuristic"
    if st_mode == "heuristic":
        return "CONTRAST ONLY — current name contains ST; VETO for enough acceptance"
    return "ST filter off"


def hist_investable_universe(
    asof: str = "",
    month: str = "",
    exclude_st: int = 1,
    st_mode: str = "daily",
    miss_policy: str = "conservative_out",
    panel_dir: str = "",
    basic_path: str = "",
    trade_dates_path: str = "",
    st_daily_path: str = "",
    st_events_path: str = "",
    include_members: int = 1,
) -> dict[str, Any]:
    """Production callable: historical investable HS-A universe at asof.

    Defaults pinned for enough path: st_mode=daily, miss_policy=conservative_out, exclude_st=1.
    """
    asof = (asof or "").strip()[:10]
    month = (month or "").strip()[:7]
    st_mode = (st_mode or "daily").strip()
    miss_policy = (miss_policy or "conservative_out").strip()
    if st_mode not in ST_MODES_EXT:
        raise ValueError(f"st_mode must be one of {ST_MODES_EXT}, got {st_mode}")
    if miss_policy not in ("conservative_out", "bucket", "allow_in"):
        raise ValueError(f"bad miss_policy={miss_policy}")

    basic_p = Path((basic_path or DEFAULT_BASIC_PATH).strip())
    dates_p = Path((trade_dates_path or DEFAULT_TRADE_DATES_PATH).strip())
    if not basic_p.is_file():
        raise ValueError(
            "stock_basic JSON missing; set HIST_STOCK_BASIC_PATH or basic_path "
            f"(tried: {basic_p})"
        )
    if not dates_p.is_file():
        raise ValueError(
            "trade_dates JSON missing; set HIST_TRADE_DATES_PATH or trade_dates_path "
            f"(tried: {dates_p})"
        )

    rows = load_basic(basic_p)
    dates = load_trade_dates(dates_p)

    if month:
        asof = last_trade_day(dates, month)
    elif not asof or len(asof) != 10:
        raise ValueError("need asof=YYYY-MM-DD or month=YYYY-MM")

    pdir = (panel_dir or DEFAULT_PANEL_DIR).strip()
    panel_file = resolve_panel_path(pdir, asof, (st_daily_path or "").strip())
    st_daily = load_st_daily(panel_file)
    st_events = load_st_events(
        Path(st_events_path) if (st_events_path or "").strip() else None
    )

    exclude = bool(int(exclude_st))
    if st_mode == "daily" and exclude and not st_daily:
        # all eligible will miss → miss_policy; still valid but warn in note
        panel_warn = (
            f"daily panel empty/missing under panel_dir={pdir!r} asof={asof}; "
            "eligible will miss→miss_policy"
        )
    else:
        panel_warn = None

    members, coverage = build_universe(
        rows, asof, exclude, st_mode, st_events, st_daily, miss_policy
    )

    payload: dict[str, Any] = {
        "PROXY_POOL": "≠PROD_ACCEPTANCE",
        "version": VERSION,
        "asof": asof,
        "exclude_st": int(exclude),
        "st_mode": st_mode,
        "count": len(members),
        "codes_sha256": codes_sha256(members),
        "generated_at": now_iso(),
        "coverage": coverage,
        "rules": {
            "source_basic": str(basic_p),
            "calendar": str(dates_p),
            "type": "1",
            "market": "sh./sz. only; BJ excluded",
            "ipo": "ipoDate<=asof",
            "delist": "outDate empty OR outDate > asof (asof==outDate OUT; nailed)",
            "st": st_rule_note(st_mode),
            "st_mode": st_mode,
            "st_daily_file": str(panel_file) if panel_file else None,
            "st_events_file": (st_events_path or None) or None,
            "st_fetch_path_fixed": (
                "Mac／stock-main · baostock query_history_k_data_plus fields=date,isST · "
                "box:10030 unreachable · Mac originals SoT · set HIST_ISST_PANEL_DIR"
            ),
            "name_heuristic": (
                "REMOVED from enough path; available only via st_mode=heuristic (veto)"
            ),
            "halt_new_mcap": "not filtered (nailed v1)",
            "miss_policy": miss_policy,
            "panel_dir": pdir or None,
        },
        "note": (
            "ST子门附条件通过≠池总门；≠清B63挂账≠冻≠开跑。"
            "默认 daily+conservative_out；箱侧 baostock:10030 不通。"
        ),
    }
    if panel_warn:
        payload["panel_warn"] = panel_warn
    if int(include_members):
        payload["members"] = members
    else:
        payload["members_omitted"] = True
    return payload
