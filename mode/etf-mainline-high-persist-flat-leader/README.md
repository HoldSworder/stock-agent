# 高持续主线非复利龙头

本目录存放一版以非复利收益为首要评估口径的 ETF 主线模式。原始 `docs/` 文档未修改。

## 推荐模式

推荐配置: `high-persist-flat|anti_exhaustion_score|above60|3d|min4|sw0.01|top2|pg25%|dd8%|mainline_persist>=0.15`

- 候选必须站上 MA60。
- 候选必须满足 `mainline_persist >= 0.15`，只追已经持续确认的主线。
- 每 3 个交易日复核一次，只持有最强 1 只 ETF，最大持仓为 1。
- 按 `anti_exhaustion_score` 排序，追主升但扣除过热、布林上轨过度和长上影衰竭信号。
- 当前持仓最少持有 4 个交易日，新标的强度高出 0.01 才允许强者替换。
- 持仓跌出 Top2、跌破 MA120、或浮盈超过 25% 后从峰值回撤 8% 时退出。

## 回测结论

该模式把排序目标从复利收益切换到非复利收益，并用次开 10bp 非复利收益做主筛选。相对上一版 `主线确认盈利保护黏性龙头`，它提高了非复利收益，但也更依赖较高主线持续门槛，属于进攻型候选。

## 文件

- `etf-mainline-high-persist-flat-leader-research.py`: 回测脚本。
- `backtest-data/summary_high_persist_flat_leader.md`: 回测摘要、参数复核、分段复核。
- `backtest-data/trades_high_persist_flat_leader.md`: 推荐候选完整交易记录。

## 风险

- `mainline_persist >= 0.15` 是较高门槛，可能漏掉早期启动主线。
- 切换阈值 `0.01` 比上一版更敏感，虽然回测中换手仍可控，但实盘需要注意成交滑点。
- 该模式仍是单腿集中进攻，不适合承受不了单一主线波动的账户直接满仓使用。
