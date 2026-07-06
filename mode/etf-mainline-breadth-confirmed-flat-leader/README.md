# 主题宽度确认非复利主线龙头

本目录存放一版在 `敏捷止盈非复利主线龙头` 基础上加入主题宽度确认的 ETF 主线模式。原始 `docs/` 文档未修改。

## 推荐模式

推荐配置: `breadth-confirmed-flat|anti_exhaustion_score|above60|4d|min6|sw0|top2|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30`

- 候选必须站上 MA60。
- 候选必须满足 `mainline_persist >= 0.15`。
- 候选所在主题需满足 `theme_breadth_above120 >= 0.30`，即主题内有一定宽度站上 MA120。
- 每 4 个交易日复核一次，只持有最强 1 只 ETF，最大持仓为 1。
- 按 `anti_exhaustion_score` 排序。
- 持仓跌出 Top2、跌破 MA120、或浮盈超过 15% 后从峰值回撤 6% 时退出。

## 回测结论

该模式在系统主指标 `flatReturn` 上高于 `敏捷止盈非复利主线龙头`。主题宽度确认不是单 ETF 黑名单，而是要求主线有横向扩散，避免孤立标的冲高。

## 文件

- `etf-mainline-breadth-confirmed-flat-leader-research.py`: 回测脚本。
- `backtest-data/summary_breadth_confirmed_flat_leader.md`: 回测摘要、参数复核、分段复核。
- `backtest-data/trades_breadth_confirmed_flat_leader.md`: 推荐候选完整交易记录。

## 风险

- 主题宽度确认可能降低早期主线捕捉速度。
- 次开 10bp 非复利没有同步创新高，实盘成交仍需观察。
- 单腿集中进攻模式仍然有主线退潮风险。
