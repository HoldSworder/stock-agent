# 敏捷止盈框架因子复扫

## 目的

继续尝试突破当前 `敏捷止盈非复利主线龙头` 的系统主指标：

| 模式 | 收盘非复利 | 次开10bp非复利 | 最大回撤 | 最大持仓 |
|---|---:|---:|---:|---:|
| 敏捷止盈非复利主线龙头 | 243.5% | 233.5% | -19.2% | 1 |

本轮不改变“单腿 + 高持续主线 + 敏捷盈利保护”的基本框架，只扫描强度因子、确认因子和通用质量过滤，仍以收盘 `flatReturn` 为首要排序。

## 扫描范围

强度因子包括：

- `anti_exhaustion_score`
- `mom30_trend_quality_smooth`
- `gap_momentum_score`
- `pvt_confirm_score`
- `mainline_quality_score`
- `mainline_core`
- `mainline_persist`
- `mainline_early`
- `mature_trend_score`
- `normalized_momentum_score`
- `regression_mainline_score`
- `multi_mom_quality_score`
- `path_quality_score`
- `drawdown_adjusted_mom30`
- `mom30` / `mom60` / `mom90`
- 组合分数：`anti_exhaustion_score + mainline_persist/mainline_quality_score/gap_momentum_score`

确认与过滤包括：

- `mainline_persist >= 0.10/0.12/0.15/0.18/0.20`
- `mainline_core >= 0.10/0.15`
- `mainline_quality_score >= 0.05/0.10`
- `mainline_early >= 0.10`
- `rsi14 <= 0.92`
- `boll_pctb <= 1.25`
- `dist_ma60` 区间过滤
- 分数下限 `-0.05/0/0.03/0.05/0.08`

共扫描 680400 个组合，保留 `flatReturn >= 240%` 的候选进行对比。

## 结果

没有发现超过当前模式 `243.5%` 的新组合。Top 候选仍然回到当前规则族：

| 规则族 | 收盘非复利 | 次开10bp非复利 | 说明 |
|---|---:|---:|---|
| `anti_exhaustion_score + mainline_persist>=0.15 + 4d + pg15/dd6` | 243.5% | 233.5% | 当前推荐规则 |
| `0.6 anti_exhaustion + 0.4 gap_momentum + mainline_persist>=0.15` | 243.5% | 233.5% | 交易路径与当前规则等价 |
| `mom30_trend_quality_smooth + mainline_persist>=0.15` | 243.3% | 233.8% | 接近但未超过 |

## 判断

当前瓶颈不在“换一个强度因子”，而在高持续主线样本本身。`anti_exhaustion_score`、`mom30_trend_quality_smooth` 和部分组合分数在 Top 区间给出近似交易路径，说明有效信息高度重叠。

后续若继续突破，应优先研究：

- 主线早期确认：在不降低 `mainline_persist` 稳健性的前提下提前进入。
- 主线退潮识别：降低 2026H1 部分切换期的回撤和低效交易。
- 引入非价格序列数据，例如 ETF 份额、成交额扩散、板块宽度或资金确认。
