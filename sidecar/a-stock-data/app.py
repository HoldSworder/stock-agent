# -*- coding: utf-8 -*-
"""a-stock-data sidecar：把 vendor/SKILL.md 抽取出的 Python 函数包成 HTTP 服务。

设计对齐 stock-agent 现有 aktools 范式（单数据源 + 通用 by-name 透传）：
  GET /api/call/{endpoint}?<params>  按端点名透传（统一 JSON 返回）
  GET /api/manifest                  端点目录（name/layer/params/desc）
  GET /selfcheck                     逐个跑端点打真实接口，OK/失败明细
  GET /health                        mootdx 连通探活

上游升级只动 vendor/SKILL.md + 重跑 extract.py，本文件的薄路由层基本不变。
mootdx 的 K线/盘口/逐笔/财务/F10 在上游是「内联片段（无 def）」，由本文件 wrapper 实现。
"""
from __future__ import annotations

import math
import os
from datetime import datetime, timedelta
from typing import Any, Callable

# urllib（tencent_quote 等用）默认走系统 CA；slim 镜像不装 ca-certificates，
# 故让 ssl 默认 context 读 certifi 的根证书，避免 CERTIFICATE_VERIFY_FAILED。
try:
    import certifi

    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except Exception:  # noqa
    pass

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

import astock_functions as af

# 东财限流间隔可经环境变量覆盖（抽取出的模块默认 1.0s）
try:
    if os.environ.get("EM_MIN_INTERVAL"):
        af.EM_MIN_INTERVAL = float(os.environ["EM_MIN_INTERVAL"])
except Exception:  # noqa
    pass

app = FastAPI(title="a-stock-data sidecar", version="1.0")


# ── 返回值 JSON 化（DataFrame / numpy / NaN / Timestamp 统一收口）─────────────
def to_jsonable(obj: Any) -> Any:
    try:
        import pandas as pd  # noqa
        import numpy as np  # noqa
    except Exception:
        pd = None
        np = None
    if obj is None:
        return None
    if pd is not None:
        if isinstance(obj, pd.DataFrame):
            return [to_jsonable(r) for r in obj.to_dict(orient="records")]
        if isinstance(obj, pd.Series):
            return to_jsonable(obj.to_dict())
        if isinstance(obj, pd.Timestamp):
            return obj.isoformat()
    if np is not None and isinstance(obj, np.generic):
        obj = obj.item()
    if isinstance(obj, float) and math.isnan(obj):
        return None
    if isinstance(obj, dict):
        return {str(k): to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    if isinstance(obj, (str, int, float, bool)):
        return obj
    return str(obj)


# ── mootdx wrapper（上游内联片段无 def，这里补成函数）────────────────────────
# category: 4=日 5=周 6=月 7=1m 8=5m 9=15m 10=30m 11=60m
def mootdx_kline(symbol: str, category: int = 4, offset: int = 100) -> Any:
    # 注意：mootdx Quotes.bars 的周期参数名是 frequency（默认 9=日K）；
    # 传 category=... 会落进 **kwargs 被静默忽略 → 所有周期都返回日线。必须用 frequency=。
    # mootdx 频率码：0=5分 1=15分 2=30分 3=60分 4=日 5=周 6=月 7/8=1分 9=日 10=季 11=年
    client = af.tdx_client()
    return client.bars(symbol=symbol, frequency=category, offset=offset)


def mootdx_index(symbol: str, frequency: int = 9, offset: int = 100) -> Any:
    # 通达信板块/自建指数（如 880008 全A等权、880003 平均股价）走 client.index；
    # 个股/ETF 用 mootdx_kline(client.bars)——板块指数走 bars 会返回空。
    # frequency 频率码同 bars：4/9=日 5=周 6=月 7/8=1分 0=5分 1=15分 2=30分 3=60分。
    # 返回除 OHLC/量额外，含 up_count/down_count 成分股涨跌家数（等权宽度可直接用）。
    client = af.tdx_client()
    return client.index(symbol=symbol, frequency=frequency, offset=offset)


def mootdx_quote(symbols: list[str]) -> Any:
    client = af.tdx_client()
    return client.quotes(symbol=symbols)


def mootdx_transaction(symbol: str, date: str) -> Any:
    client = af.tdx_client()
    return client.transaction(symbol=symbol, date=date)


def mootdx_finance(symbol: str) -> Any:
    client = af.tdx_client()
    return client.finance(symbol=symbol)


def mootdx_f10(symbol: str, name: str = "公司概况") -> Any:
    client = af.tdx_client()
    return client.F10(symbol=symbol, name=name)


def mootdx_f10_announcement(symbol: str) -> Any:
    client = af.tdx_client()
    return client.F10(symbol=symbol, name="最新提示")


# ── 大盘阶段 HMM 影子信号（hmmlearn，纯确定性，零 token）─────────────────────
# 与 backend 的确定性六维规则并列的「概率视角」：在全A等权(880008)日线上现训
# GaussianHMM，用「对数收益 + 20日滚动波动」两特征聚出 强势/震荡/弱势 三态，
# 输出最新一日三态后验概率 + 强弱读数，供与规则四态相互印证（分歧即预警）。
_ANN = 244  # A股年化交易日近似


def _regime_hmm_from_closes(
    closes: "Any", n_states: int, as_of: str, symbol: str,
) -> dict:
    """核心：给定收盘序列，现训 HMM 并解码为三态概率 + 强弱读数（可脱网自检）。

    状态无语义标签，训后按各态「平均对数收益」升序赋名（最低=弱势、最高=强势、
    中间=震荡），保证跨次重训标签稳定。`random_state` 固定 → 完全确定性。
    """
    import numpy as np
    import pandas as pd
    from hmmlearn.hmm import GaussianHMM
    from sklearn.preprocessing import StandardScaler

    s = pd.Series(np.asarray(closes, dtype=float))
    logret = np.log(s).diff()
    vol20 = logret.rolling(20).std()
    feat = pd.concat([logret, vol20], axis=1).dropna()
    feat.columns = ["ret", "vol"]
    if len(feat) < 120:
        raise ValueError(f"有效特征样本不足({len(feat)})，HMM 不训练")

    real_ret = feat["ret"].to_numpy()  # 未标准化对数收益（算各态年化用）
    x = StandardScaler().fit_transform(feat.to_numpy())
    model = GaussianHMM(
        n_components=n_states, covariance_type="full",
        n_iter=1000, random_state=42, tol=1e-4,
    )
    model.fit(x)
    states = model.predict(x)          # Viterbi
    last_probs = model.predict_proba(x)[-1]

    # 按标准化收益列（第0列，与真实收益单调）升序：最低=弱势、最高=强势
    order = list(np.argsort(model.means_[:, 0]))
    labels: dict = {}
    if n_states == 2:
        labels = {order[0]: "弱势", order[1]: "强势"}
    else:
        labels[order[0]] = "弱势"
        labels[order[-1]] = "强势"
        for mid in order[1:-1]:
            labels[mid] = "震荡"

    prob_by_label = {"强势": 0.0, "震荡": 0.0, "弱势": 0.0}
    for st in range(n_states):
        prob_by_label[labels[st]] += float(last_probs[st])
    # 强弱读数：强势概率 − 弱势概率 ∈ [-1,1] → 归一到 0-100，供与规则 score 对照
    strength = round((prob_by_label["强势"] - prob_by_label["弱势"] + 1) / 2 * 100, 1)

    per_state = []
    for st in order:  # 从弱到强
        mask = states == st
        cnt = int(mask.sum())
        if cnt == 0:
            per_state.append({"name": labels[st], "days": 0, "annRet": None, "annVol": None})
            continue
        r = real_ret[mask]
        per_state.append({
            "name": labels[st],
            "days": cnt,
            "annRet": round(float(np.mean(r)) * _ANN * 100, 1),
            "annVol": round(float(np.std(r)) * math.sqrt(_ANN) * 100, 1),
        })
    trans = [[round(float(v), 3) for v in row] for row in model.transmat_]

    return {
        "asOf": as_of,
        "state": labels[int(states[-1])],
        "probs": {k: round(v * 100, 1) for k, v in prob_by_label.items()},
        "strength": strength,
        "perState": per_state,
        "transition": trans,
        "window": len(feat),
        "nStates": n_states,
        "symbol": symbol,
    }


def regime_hmm(symbol: str = "880008", n_states: int = 3, window: int = 750) -> Any:
    """大盘阶段 HMM 影子信号：全A等权(880008)日线上现训，输出三态概率 + 强弱读数。

    纯只读、纯确定性（random_state 固定）、不调 LLM；样本不足/`fit` 不收敛时抛错，
    由 backend 服务层降级隐藏（不阻断规则四态结论）。
    ponytail: 每请求现训（T≈window，fit<1s，可接受），不缓存模型；上限=可取样本量，
    突破需 backend 落库长历史序列后改传入序列。
    """
    n_states = max(2, min(int(n_states), 4))
    window = max(250, min(int(window), 1200))

    df = mootdx_index(symbol=symbol, frequency=9, offset=window + 40)
    if df is None or len(df) == 0:
        raise ValueError(f"全A等权({symbol}) K线为空")
    try:
        import pandas as pd
        if not isinstance(df, pd.DataFrame):
            df = pd.DataFrame(df)
        tcol = "datetime" if "datetime" in df.columns else ("date" if "date" in df.columns else None)
        if tcol:
            df = df.sort_values(tcol)
        closes = pd.to_numeric(df["close"], errors="coerce").dropna().to_numpy()
        as_of = str(df[tcol].iloc[-1])[:10] if tcol else _today()
    except Exception as e:  # noqa
        raise ValueError(f"全A等权 K线解析失败：{e}")

    if len(closes) < 200:
        raise ValueError(f"样本不足(closes={len(closes)})，HMM 不训练")
    closes = closes[-window:]
    return _regime_hmm_from_closes(closes, n_states, as_of, symbol)


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


# ── 端点注册表 ────────────────────────────────────────────────────────────
# 每项：fn / layer / params[(name,type,required,default)] / desc / sample(自检用)
# type ∈ {str,int,float,codes(逗号列表)}
def _af(name: str) -> Callable | None:
    return getattr(af, name, None)


_SPEC: list[dict] = [
    # Layer 1 行情（mootdx/腾讯/百度，不封 IP 优先）
    {"name": "mootdx_kline", "fn": mootdx_kline, "layer": "行情",
     "params": [("symbol", "str", True, None), ("category", "int", False, 4), ("offset", "int", False, 100)],
     "desc": "mootdx 通达信 K线（不封IP）。category(频率码):0=5分 1=15分 2=30分 3=60分 4=日 5=周 6=月 7/8=1分 9=日 10=季 11=年", "sample": {"symbol": "688017"}},
    {"name": "mootdx_index", "fn": mootdx_index, "layer": "行情",
     "params": [("symbol", "str", True, None), ("frequency", "int", False, 9), ("offset", "int", False, 100)],
     "desc": "mootdx 通达信板块/自建指数K线（880008全A等权、880003平均股价等，走 client.index；板块指数用 mootdx_kline 会返回空）。frequency:4/9=日 5=周 6=月，返回含 up_count/down_count 涨跌家数", "sample": {"symbol": "880008"}},
    {"name": "mootdx_quote", "fn": mootdx_quote, "layer": "行情",
     "params": [("symbols", "codes", True, None)],
     "desc": "mootdx 实时报价含五档盘口（46字段）", "sample": {"symbols": "688017,300476"}},
    {"name": "mootdx_transaction", "fn": mootdx_transaction, "layer": "行情",
     "params": [("symbol", "str", True, None), ("date", "str", True, None)],
     "desc": "mootdx 逐笔成交（非交易时间返回空），date=YYYYMMDD", "sample": None},
    {"name": "tencent_quote", "fn": _af("tencent_quote"), "layer": "行情",
     "params": [("codes", "codes", True, None)],
     "desc": "腾讯财经 PE(TTM)/PB/市值/换手/涨跌停/指数/ETF（不封IP）", "sample": {"codes": "688017,300476"}},
    {"name": "baidu_kline_with_ma", "fn": _af("baidu_kline_with_ma"), "layer": "行情",
     "params": [("code", "str", True, None), ("start_time", "str", False, "")],
     "desc": "百度股市通日K线，自带 MA5/MA10/MA20 均价", "sample": {"code": "600519"}},
    # Layer 2 研报
    {"name": "eastmoney_reports", "fn": _af("eastmoney_reports"), "layer": "研报",
     "params": [("code", "str", True, None), ("max_pages", "int", False, 2)],
     "desc": "东财个股研报列表+评级+EPS预测（em_get 限流）", "sample": {"code": "688017", "max_pages": 1}},
    {"name": "eastmoney_industry_reports", "fn": _af("eastmoney_industry_reports"), "layer": "研报",
     "params": [("industry_code", "str", False, "*"), ("max_pages", "int", False, 1)],
     "desc": "东财行业研报（industry_code='*'全行业 或传东财行业码）", "sample": {"max_pages": 1}},
    {"name": "ths_eps_forecast", "fn": _af("ths_eps_forecast"), "layer": "研报",
     "params": [("code", "str", True, None)],
     "desc": "同花顺机构一致预期 EPS（直连 basic.10jqka）", "sample": {"code": "688017"}},
    {"name": "iwencai_search", "fn": _af("iwencai_search"), "layer": "研报",
     "params": [("query", "str", True, None), ("channel", "str", False, "report"), ("size", "int", False, 20)],
     "desc": "iwencai NL 语义搜索研报（需 IWENCAI_API_KEY）", "sample": None},
    {"name": "iwencai_query", "fn": _af("iwencai_query"), "layer": "研报",
     "params": [("query", "str", True, None), ("page", "int", False, 1), ("limit", "int", False, 20)],
     "desc": "iwencai NL 查询（需 IWENCAI_API_KEY）", "sample": None},
    # Layer 3 信号
    {"name": "ths_hot_reason", "fn": _af("ths_hot_reason"), "layer": "信号",
     "params": [("date", "str", False, None)],
     "desc": "同花顺当日强势股 + 题材归因 reason（盘后 15:30 后更新）", "sample": {}},
    {"name": "hsgt_realtime", "fn": _af("hsgt_realtime"), "layer": "信号",
     "params": [],
     "desc": "同花顺北向资金实时分钟流向", "sample": {}},
    {"name": "northbound_history", "fn": _af("_load_northbound_history"), "layer": "信号",
     "params": [("n", "int", False, 20)],
     "desc": "北向资金本地自缓存历史（首跑只有当天，越跑越多）", "sample": {"n": 20}},
    {"name": "eastmoney_concept_blocks", "fn": _af("eastmoney_concept_blocks"), "layer": "信号",
     "params": [("code", "str", True, None)],
     "desc": "东财个股所属板块/概念归属（行业/概念/地域+BK码+龙头）", "sample": {"code": "600519"}},
    {"name": "eastmoney_fund_flow_minute", "fn": _af("eastmoney_fund_flow_minute"), "layer": "信号",
     "params": [("code", "str", True, None)],
     "desc": "东财个股分钟级资金流向（主力/大单/中单/小单/超大单）", "sample": {"code": "000858"}},
    {"name": "dragon_tiger_board", "fn": _af("dragon_tiger_board"), "layer": "信号",
     "params": [("code", "str", True, None), ("trade_date", "str", True, None), ("look_back", "int", False, 30)],
     "desc": "个股龙虎榜上榜记录 + 买卖席位 TOP5 + 机构动向", "sample": None},
    {"name": "lockup_expiry", "fn": _af("lockup_expiry"), "layer": "信号",
     "params": [("code", "str", True, None), ("trade_date", "str", True, None), ("forward_days", "int", False, 90)],
     "desc": "限售解禁日历（历史 + 未来 N 天待解禁）", "sample": None},
    {"name": "industry_comparison", "fn": _af("industry_comparison"), "layer": "信号",
     "params": [("top_n", "int", False, 20)],
     "desc": "东财行业板块涨跌/上涨下跌家数排名（零鉴权）", "sample": {"top_n": 10}},
    {"name": "daily_dragon_tiger", "fn": _af("daily_dragon_tiger"), "layer": "信号",
     "params": [("trade_date", "str", False, None), ("min_net_buy", "float", False, None)],
     "desc": "全市场龙虎榜（每日上榜 + 净买额排名 + 上榜原因）", "sample": {}},
    # Layer 4 资金面 / 筹码
    {"name": "margin_trading", "fn": _af("margin_trading"), "layer": "资金面",
     "params": [("code", "str", True, None), ("page_size", "int", False, 30)],
     "desc": "融资融券明细（融资余额/买入/偿还 + 融券）", "sample": {"code": "600519"}},
    {"name": "block_trade", "fn": _af("block_trade"), "layer": "资金面",
     "params": [("code", "str", True, None), ("page_size", "int", False, 20)],
     "desc": "大宗交易（成交价量 + 买卖营业部 + 溢价率）", "sample": {"code": "600519"}},
    {"name": "holder_num_change", "fn": _af("holder_num_change"), "layer": "资金面",
     "params": [("code", "str", True, None), ("page_size", "int", False, 10)],
     "desc": "股东户数变化（季度 + 环比 + 户均持股，筹码集中度）", "sample": {"code": "000858"}},
    {"name": "dividend_history", "fn": _af("dividend_history"), "layer": "资金面",
     "params": [("code", "str", True, None), ("page_size", "int", False, 20)],
     "desc": "分红送转历史（派息/送股/转增 + 进度）", "sample": {"code": "600519"}},
    {"name": "stock_fund_flow_120d", "fn": _af("stock_fund_flow_120d"), "layer": "资金面",
     "params": [("code", "str", True, None)],
     "desc": "个股资金流 120 日（日级主力/大单/中单/小单净流入）", "sample": {"code": "000858"}},
    # Layer 5 新闻
    {"name": "eastmoney_stock_news", "fn": _af("eastmoney_stock_news"), "layer": "新闻",
     "params": [("code", "str", True, None), ("page_size", "int", False, 20)],
     "desc": "东财个股新闻流（直连 search-api-web）", "sample": {"code": "300476"}},
    {"name": "eastmoney_global_news", "fn": _af("eastmoney_global_news"), "layer": "新闻",
     "params": [("page_size", "int", False, 50)],
     "desc": "东财全球财经资讯 7x24（直连 np-weblist）", "sample": {"page_size": 20}},
    {"name": "cls_telegraph", "fn": _af("cls_telegraph"), "layer": "新闻",
     "params": [("page_size", "int", False, 50)],
     "desc": "财联社快讯（⚠️上游已下线，建议用 eastmoney_global_news）", "sample": None},
    # Layer 6 基础数据
    {"name": "mootdx_finance", "fn": mootdx_finance, "layer": "基础数据",
     "params": [("symbol", "str", True, None)],
     "desc": "mootdx 财务快照 37 字段季报（eps/roe/净利润/主营收入…）", "sample": {"symbol": "688017"}},
    {"name": "mootdx_f10", "fn": mootdx_f10, "layer": "基础数据",
     "params": [("symbol", "str", True, None), ("name", "str", False, "公司概况")],
     "desc": "mootdx F10 公司文本（最新提示/公司概况/财务分析/股东研究…）", "sample": {"symbol": "688017"}},
    {"name": "eastmoney_stock_info", "fn": _af("eastmoney_stock_info"), "layer": "基础数据",
     "params": [("code", "str", True, None)],
     "desc": "东财个股基本面（行业/总股本/流通/市值/上市日期）", "sample": {"code": "688017"}},
    {"name": "sina_financial_report", "fn": _af("sina_financial_report"), "layer": "基础数据",
     "params": [("code", "str", True, None), ("report_type", "str", False, "lrb"), ("num", "int", False, 8)],
     "desc": "新浪财报三表（lrb利润/fzb资产负债/llb现金流）", "sample": {"code": "600519", "num": 2}},
    # Layer 7 公告
    {"name": "cninfo_announcements", "fn": _af("cninfo_announcements"), "layer": "公告",
     "params": [("code", "str", True, None), ("page_size", "int", False, 30)],
     "desc": "巨潮公告全文检索（动态 orgId 映射，沪深北全量）", "sample": {"code": "688017", "page_size": 10}},
    {"name": "mootdx_f10_announcement", "fn": mootdx_f10_announcement, "layer": "公告",
     "params": [("symbol", "str", True, None)],
     "desc": "mootdx F10「最新提示」公告摘要", "sample": {"symbol": "688017"}},
    # 估值流程
    {"name": "full_valuation", "fn": _af("full_valuation"), "layer": "估值",
     "params": [("code", "str", True, None)],
     "desc": "单票完整估值：实时价→一致预期EPS→前向PE/PEG/PE消化年数", "sample": {"code": "688017"}},
    # 大盘阶段 HMM 影子信号
    {"name": "regime_hmm", "fn": regime_hmm, "layer": "大盘阶段",
     "params": [("symbol", "str", False, "880008"), ("n_states", "int", False, 3), ("window", "int", False, 750)],
     "desc": "大盘阶段 HMM 影子信号：全A等权(880008)日线现训 GaussianHMM(对数收益+滚动波动)，输出 强势/震荡/弱势 三态概率+强弱读数(0-100)，供与规则四态相互印证。纯确定性、零 token",
     "sample": {"symbol": "880008"}},
]

# 仅保留 fn 解析成功的端点（上游若重命名/删除，自动跳过而非崩溃）
ENDPOINTS: dict[str, dict] = {s["name"]: s for s in _SPEC if s.get("fn") is not None}


def _coerce(value: str, typ: str) -> Any:
    if typ == "int":
        return int(value)
    if typ == "float":
        return float(value)
    if typ == "codes":
        return [c.strip() for c in value.split(",") if c.strip()]
    return value


def _build_kwargs(spec: dict, query: dict) -> dict:
    kwargs: dict = {}
    for name, typ, required, default in spec["params"]:
        if name in query and query[name] != "":
            kwargs[name] = _coerce(query[name], typ)
        elif required:
            raise HTTPException(status_code=400, detail=f"缺少必需参数 {name}")
        elif default is not None:
            kwargs[name] = default
    return kwargs


@app.get("/health")
def health() -> dict:
    try:
        client = af.tdx_client()
        bars = client.bars(symbol="000001", category=4, offset=1)
        ok = bars is not None
        return {"ok": ok, "mootdx": ok, "endpoints": len(ENDPOINTS)}
    except Exception as e:  # noqa
        raise HTTPException(status_code=503, detail=f"mootdx 不可用：{e}")


@app.get("/api/manifest")
def manifest() -> dict:
    items = []
    for name, spec in ENDPOINTS.items():
        items.append({
            "name": name,
            "layer": spec["layer"],
            "desc": spec["desc"],
            "params": [
                {"name": p[0], "type": p[1], "required": p[2], "default": p[3]}
                for p in spec["params"]
            ],
        })
    return {"count": len(items), "endpoints": items}


@app.get("/api/call/{endpoint}")
def call_endpoint(endpoint: str, request: Request) -> JSONResponse:
    spec = ENDPOINTS.get(endpoint)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"未知端点 {endpoint}")
    query = dict(request.query_params)
    kwargs = _build_kwargs(spec, query)
    try:
        result = spec["fn"](**kwargs)
        return JSONResponse(content=to_jsonable(result))
    except HTTPException:
        raise
    except Exception as e:  # noqa
        raise HTTPException(status_code=502, detail=f"{endpoint} 取数失败：{e}")


@app.get("/selfcheck")
def selfcheck() -> dict:
    """逐个跑有 sample 的端点打真实接口，返回 OK/失败明细（上游同步验证 + 运维看板）。"""
    today = _today()
    recent = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    results = []
    ok_count = 0
    for name, spec in ENDPOINTS.items():
        sample = spec.get("sample")
        if sample is None:
            results.append({"endpoint": name, "status": "skipped", "reason": "无 sample（需特定参数/Key）"})
            continue
        # 补齐需要日期的样本
        kwargs = dict(sample)
        for p in spec["params"]:
            if p[0] == "trade_date" and "trade_date" not in kwargs:
                kwargs["trade_date"] = recent
        # 把 codes 字符串转列表
        norm = {}
        for p in spec["params"]:
            pname, typ = p[0], p[1]
            if pname in kwargs and typ == "codes" and isinstance(kwargs[pname], str):
                norm[pname] = [c.strip() for c in kwargs[pname].split(",") if c.strip()]
            elif pname in kwargs:
                norm[pname] = kwargs[pname]
        try:
            r = spec["fn"](**norm)
            j = to_jsonable(r)
            size = len(j) if isinstance(j, (list, dict)) else 1
            results.append({"endpoint": name, "status": "ok", "size": size})
            ok_count += 1
        except Exception as e:  # noqa
            results.append({"endpoint": name, "status": "error", "error": str(e)[:200]})
    return {"checked_at": today, "ok": ok_count, "total_tested": len([r for r in results if r["status"] != "skipped"]), "results": results}


# ── HMM 脱网自检（`python app.py` 直接运行；不触网、不落库）─────────────────
# 构造「低波正收益 → 高波负收益」两段拼接序列，断言 HMM 能把强势态判为高收益、
# 弱势态判为低收益，且标签排序正确（对齐 backend regime/service.ts 的 assert 范式）。
if __name__ == "__main__":
    import numpy as np

    rng = np.random.default_rng(42)
    up = rng.normal(0.0015, 0.006, 400)     # 低波正收益（强势）
    down = rng.normal(-0.0020, 0.025, 300)  # 高波负收益（弱势）
    rets = np.concatenate([up, down, up])
    prices = 100.0 * np.exp(np.cumsum(rets))  # 收益 → 收盘价序列

    out = _regime_hmm_from_closes(prices, n_states=3, as_of="2026-07-10", symbol="TEST")
    assert set(out["probs"]) == {"强势", "震荡", "弱势"}, "三态概率键应为 强势/震荡/弱势"
    assert 0 <= out["strength"] <= 100, f"强弱读数应在 0-100，实际 {out['strength']}"
    strong = next(p for p in out["perState"] if p["name"] == "强势")
    weak = next(p for p in out["perState"] if p["name"] == "弱势")
    assert strong["annRet"] > weak["annRet"], (
        f"强势态年化收益({strong['annRet']})应高于弱势态({weak['annRet']})"
    )
    assert out["state"] in {"强势", "震荡", "弱势"}, "当前态应为三态之一"
    print(f"regime_hmm 自检通过：state={out['state']} strength={out['strength']} "
          f"probs={out['probs']} 强势年化={strong['annRet']}% 弱势年化={weak['annRet']}%")
