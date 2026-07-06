# 同主题 ETF 重复审计

## 结论

`港股创新药` 和 `港股创新药(广发)` 应视为同一主题，不能在收益归因里当作两个独立来源。当前推荐的 `etf-mainline-short-sprint` 模式不存在同一时段同时持有两只港股创新药 ETF 的情况，但旧摘要按代码统计贡献，确实会造成“重复收益来源”的误导。

已修正：

- `summary_short_sprint.md` 的收益集中度改为按主题聚合。
- `港股创新药` 主题合并展示 `159567 港股创新药` 与 `513120 港股创新药(广发)`。
- 交易明细仍按代码保留，方便复核实际买卖。

## 已检查的交易记录

逐文件扫描持仓区间后，结果如下：

| 交易记录 | 是否发现同主题重叠持仓 | 说明 |
|---|---|---|
| `mode/etf-mainline-absolute-leader/backtest-data/trades_absolute_leader.md` | 否 | 两只创新药 ETF 只是在不同阶段出现。 |
| `mode/etf-mainline-dualmom-gate/backtest-data/trades_dualmom_gate.md` | 否 | 两只创新药 ETF 只是在不同阶段出现。 |
| `mode/etf-mainline-early-breakout/backtest-data/trades_early_breakout.md` | 否 | 两只创新药 ETF 只是在不同阶段出现。 |
| `mode/etf-mainline-escape/backtest-data/trades_mainline_escape.md` | 否 | 两只创新药 ETF 只是在不同阶段出现。 |
| `mode/etf-mainline-leader-runner/backtest-data/trades_leader_runner.md` | 否 | 两只创新药 ETF 只是在不同阶段出现。 |
| `mode/etf-mainline-offense/backtest-data/trades_offense.md` | 否 | 两只创新药 ETF 只是在不同阶段出现。 |
| `mode/etf-mainline-profit-runner/backtest-data/trades_profit_runner.md` | 否 | 两只创新药 ETF 只是在不同阶段出现。 |
| `mode/etf-mainline-short-sprint/backtest-data/trades_short_sprint.md` | 否 | 当前推荐模式无重叠，摘要已改为主题聚合。 |
| `mode/etf-rs90-top3/backtest-data/trades_rs90_top3.md` | 是 | 这是未启用 family 去重的旧普通版本，存在同主题重叠，不应作为推荐口径。 |
| `mode/etf-rs90-top3/backtest-data/trades_rs90_top3_family.md` | 否 | family 去重版本无重叠。 |

## 重要区分

- “交易记录里先后出现两只同主题 ETF”不等于重复持仓。
- “收益集中度按代码拆分”会误导归因，应改为按主题聚合。
- “同一持仓区间同时持有两只同主题 ETF”才是真正的重复问题；旧 `trades_rs90_top3.md` 存在这个问题，应以 `trades_rs90_top3_family.md` 或后续 family-cap 回测为准。
