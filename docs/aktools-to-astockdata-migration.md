# aktools → a-stock-data 分阶段替代

a-stock-data sidecar 与 aktools 当前**并行运行**。待 sidecar 长期稳定（看 `/selfcheck` 通过率与数据源页统计），按本文档**逐步把 `callAkshare` 调用切到 `callAstock`**，最终下线 aktools。本次仅文档化，不执行迁移。

## 两套范式对照（接口形状一致，可平滑切换）

| | aktools | a-stock-data sidecar |
| --- | --- | --- |
| 服务 | `/api/public/<func>` | `/api/call/<endpoint>` |
| 后端 client | `callAkshare(func, params)` | `callAstock(endpoint, params)` |
| Agent 工具 | `akshare_call` | `astock_call` |
| 数据源 | `akshare` | `astockdata` |
| 防封 | akshare 内部 | mootdx 不封 IP + 东财 `em_get()` 限流 |

## 迁移面：现有 `callAkshare` 调用点

迁移时逐文件替换，并按下表把 akshare 函数名换成 a-stock-data 端点名：

| 现状 akshare 函数 | a-stock-data 端点 | 备注 |
| --- | --- | --- |
| 个股历史 K 线 `stock_zh_a_hist` | `mootdx_kline` | 已在 K线调度自动接入，无需 agent 显式调用 |
| 龙虎榜 | `dragon_tiger_board` / `daily_dragon_tiger` | a-stock-data 字段更全（席位/机构动向） |
| 解禁 | `lockup_expiry` | 含未来 N 天待解禁 |
| 融资融券 | `margin_trading` | |
| 大宗交易 | `block_trade` | 含营业部/溢价率 |
| 股东户数 | `holder_num_change` | 筹码集中度 |
| 分红送转 | `dividend_history` | |
| 个股资金流 | `eastmoney_fund_flow_minute` / `stock_fund_flow_120d` | 分钟级 / 120 日 |
| 行业板块 | `industry_comparison` | 东财零鉴权 |
| 板块归属 | `eastmoney_concept_blocks` | 一次拿全 |
| 个股新闻 | `eastmoney_stock_news` | |
| 全球资讯 / 财联社 | `eastmoney_global_news` | 财联社旧 API 已下线 |
| 财报三表 | `sina_financial_report` | |
| 个股基本面 | `eastmoney_stock_info` | |
| 雪球热度 `stock_hot_*_xq` | （a-stock-data 无对应）| 保留走 akshare，或后续补端点 |

> 当前 `callAkshare` 调用点（迁移检查清单）：`backend/src/capital/data.ts`、`backend/src/market/chip.ts`、`backend/src/breadth/data.ts`、`backend/src/market/datacenter.ts` 等。迁移前用 `grep -rn callAkshare backend/src` 取最新清单。

## 步骤

1. **观察期**：保持并行，日常看 `/selfcheck` 与数据源页 `astockdata` 调用统计/延迟。
2. **逐模块切换**：一次切一个模块的 `callAkshare(func)` → `callAstock(endpoint)`，对照上表改名改参；跑 typecheck + 该模块功能验证。
3. **雪球等无对应端点**：暂留 akshare，或给上游提 issue / 在 sidecar 补端点。
4. **下线**：全部切完后，移除 `akshare_call` 工具、`akshare` 数据源与设置项，停掉 aktools 容器。

## 回退

切换是「改调用面」而非「改框架」，数据源/调度/工具框架两者共用。任何一步异常，把该模块的 `callAstock` 改回 `callAkshare` 即可，无连带影响。
