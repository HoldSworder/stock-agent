---
name: stock-agent-quant-research
description: >-
  codex/cursor 把 mode/ 目录下的量化研究成果（策略模式买卖逻辑、回测结果、每日跟踪快照）
  登记进 stock-agent 系统的读写 API 与数据 schema。当你在 mode/ 里发掘/组合因子、跑回测，
  并希望结果在 WebUI「量化研究模式库」页可见、可关注、可每日跟踪时使用。覆盖模式 upsert、
  回测推送、声明式 spec（让系统站内自跟踪）、external 每日快照推送、研究标的库读写。
---

# stock-agent · 量化研究模式库读写

系统是**唯一事实源**：codex/cursor 不直接读 `mode/` 给 WebUI，而是把结构化结果**推**进
SQLite（经下列 API），WebUI 只读 DB。回测/发掘仍在 `mode/` 的 python 里跑，系统**不**跑 python、
**不**下单、**不**调 LLM——它只存储、展示，并对声明式模式做站内每日跟踪。

基址 `http://<host>:8787/api`（本地开发经 Vite 代理）。若系统设了访问密码，所有 `/api` 需带
`x-app-token`（或机器侧 `x-bridge-secret`）。响应统一 `{ ok: boolean, data?, error? }`。

## 1. 登记 / 更新一个模式

`PUT /api/modes/:id`（id 用稳定 slug，如 `etf-mainline-profit-runner`）。再次 PUT 同 id 即更新；
`followed`（关注开关）不受 upsert 影响，由用户在 WebUI 控制。

```jsonc
{
  "name": "ETF主线·利润奔跑者",
  "category": "ETF趋势轮动",
  "tags": "ETF,趋势,主线轮动",
  "status": "recommended",          // experiment | recommended | baseline | retired
  "summary": "周频Top-N RS90主线轮动，Supertrend出场，咬住主升浪。",
  "recommendedConfig": "wrot-keep|rs90|noabs|70/30|ma60trail12",
  "buySellMd": "## 入场\n- ...\n## 出场\n- Supertrend(10,3) 多翻空清仓",
  "analysisMd": "## 反过拟合\n- 分年/集中度单调性/成交成本全量复核 ...",
  "universeNote": "研究标的库全量；同主题去重",
  "risksMd": "超额高度依赖当期超级主线龙头，单标的集中度高。",
  "trackingMode": "system",         // system=站内声明式自跟踪；external=你每日推快照
  "spec": { /* system 模式必填，见 §3 */ },
  "source": "codex"
}
```

## 2. 推送回测结果（可多版本）

`POST /api/modes/:id/backtests`。一个模式可挂多版（推荐版 / 基准版 / 高收益版）。收益类字段
**用百分比数值**（`+266%` 写 `266`），与 README 口径一致；回撤为负数。

```jsonc
{
  "label": "wrot-keep rs90 70/30 ma60trail12",
  "range": "2025-01-02 ~ 2026-06-26",
  "poolSize": 55,
  "isRecommended": true,
  "metrics": { "return": 353, "annualized": 180, "maxDrawdown": -22,
               "trades": 54, "winRate": 54, "avgPositions": 2, "maxPositions": 3 },
  "costSensitivity": [
    { "caliber": "0bp", "return": 380, "maxDrawdown": -22, "trades": 54 },
    { "caliber": "10bp", "return": 353, "maxDrawdown": -23, "trades": 54 }
  ],
  "segments": [
    { "label": "2025", "return": 150, "maxDrawdown": -18 },
    { "label": "2026H1", "return": 80, "maxDrawdown": -14 }
  ],
  "concentrationMd": "## 集中度单调性\n80/20 > 70/30 > 等权 ...",
  "tradesMd": "| 日期 | 标的 | 方向 | 收益 |\n|--|--|--|--|\n..."   // 惰性返回，列表不带
}
```

## 3. 声明式 spec —— 让系统站内每日自跟踪（trackingMode=`system`）

填了 `spec` 且被用户关注后，站内 TS 引擎每收盘按 spec 重算应持仓 / 信号 / 关注以来累计收益，
无需你每天推快照。**仅支持站内可计算因子白名单**，白名单外的复杂逻辑请走 §4 external。

```jsonc
{
  "selectorFactors": [              // 横截面加权 z-score 选股；单因子就放一个、权重1
    { "name": "rs90", "weight": 1 }
  ],
  "topN": 3,
  "weights": [0.7, 0.3],            // 省略=等权；长度需等于 topN
  "rebalanceDays": 5,               // 周频
  "dedupTheme": true,               // 按标的库 tags 首个标签同主题去重
  "exits": [
    { "type": "belowMaDrawdown", "ma": 60, "drawdownPct": 12 },
    { "type": "supertrend", "period": 10, "mult": 3 }
  ]
}
```

因子白名单：`rs90` / `rs60`（相对沪深300超额）、`mom20`/`mom30`/`mom60`/`mom90`/`mom120`
（N 日动量）、`trendQuality`、`crossRank`（趋势质量类，横截面排名）。退出：`rankDrop`（每日重选隐式）、
`belowMaDrawdown`、`supertrend`。可手动 `POST /api/modes/:id/track-now`（即时跑一日）/
`POST /api/modes/:id/rebacktest`（按 spec 历史重跑出指标并落一版回测）。

## 4. 推送每日快照（trackingMode=`external`，复杂 python 策略）

白名单覆盖不了的策略，自己在 python 算完每天 `POST /api/modes/:id/tracking`：

```jsonc
{
  "date": "2026-06-27",
  "holdings": [ { "code": "512760", "name": "半导体ETF", "weight": 0.7 },
                { "code": "159740", "name": "恒生科技ETF", "weight": 0.3 } ],
  "signal": [ { "kind": "enter", "code": "512760", "name": "半导体ETF", "note": "RS新高换入" } ],
  "dayReturn": 0.012,               // 当日收益（小数，非百分比）
  "cumReturn": 0.85,                // 关注以来累计
  "drawdown": -0.06
}
```

按 `(modeId, date)` 幂等；`signal` 会同步成 WebUI 时间线事件。

## 5. 研究标的库（独立于 ETF 关注列表）

回测/跟踪所用标的池在系统侧维护，与「ETF 关注列表」分开：
- `GET /api/research-universe` → `[{ code, name, tags, note }]`，python 取这个池做研究。
- `POST /api/research-universe` `{ code, name, tags?, note? }` 增 / 改（按 code 幂等）。
- `PUT /api/research-universe/:code` `{ tags?, note? }`；`DELETE /api/research-universe/:code`。
- `tags` 逗号分隔，**首个标签**用作 spec `dedupTheme` 的主题去重键。

## 落地约定

- 一个 `mode/<name>/` 研究 → 一个 `PUT /api/modes/<slug>` + 一/多条 `POST .../backtests`。
- 能用 §3 白名单表达的（常见 ETF 轮动）优先填 `spec` 走站内自跟踪；否则 `external` 每日推。
- 收益/回撤在**回测**里用百分比整数，在**每日快照**里用小数；不要混。
- 不在系统侧跑 python、不下单；系统只存储 + 展示 + 声明式跟踪。
