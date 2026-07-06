# 主线确认盈利保护黏性龙头回测摘要

- 回测区间: 2025-01-02 至 2026-06-26
- ETF池: 55 只
- 最大持仓: 1（满足最大持仓不超过 3）；同主题重复持仓天然为 0。
- 推荐配置: `confirmed-profit-sticky|anti_exhaustion_score|above60|3d|min4|sw0.035|top2|pg25%|dd8%|mainline_persist>=0.02`
- 机制: 候选需 `mainline_persist >= 0.02`；最小持有 `4` 个交易日；新标的分数至少高出 `0.035` 才触发强者替换；持仓跌出 Top2、跌破 MA120、或单笔浮盈超过 `25%` 后从峰值回撤 `8%` 时退出。
- 全段收益: 复利 `658.0%` / 非复利(等权) `223.1%`；最大回撤 `-23.6%`；交易 `43`；交易记录 `trades_confirmed_profit_sticky_leader.md`。
- 说明: 复利收益受后期权益基数放大,后几笔大行情会主导 headline;非复利收益等权每段,用于横向评估时去除该路径依赖偏差。本模式参数排名已改用次开10bp非复利收益。
- 基准: 盈利保护黏性龙头收盘 `635.8%`；盈利保护黏性龙头次开10bp `571.2%`；本模式次开10bp `595.0%`。

## 候选复核

| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 主线确认盈利保护黏性龙头-全段 | 658.0% | 223.1% | 299.2% | -23.6% | 43 | 1.00 | 1 | 1 |

## 参数对照（按次开10bp非复利收益排序）

| 策略 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 | 是否高于执行共识 |
|---|---:|---:|---:|---:|---:|---:|---|
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.035\|top2\|pg25%\|dd8%\|mainline_persist>=0.02 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.040\|top2\|pg25%\|dd8%\|mainline_persist>=0.02 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.035\|top2\|pg25%\|dd8%\|mainline_persist>=0.02 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.040\|top2\|pg25%\|dd8%\|mainline_persist>=0.02 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.035\|top2\|pg30%\|dd8%\|mainline_persist>=0.02 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.040\|top2\|pg30%\|dd8%\|mainline_persist>=0.02 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.035\|top2\|pg30%\|dd8%\|mainline_persist>=0.02 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.040\|top2\|pg30%\|dd8%\|mainline_persist>=0.02 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.035\|top2\|pg25%\|dd8%\|mainline_persist>=0.05 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.040\|top2\|pg25%\|dd8%\|mainline_persist>=0.05 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.035\|top2\|pg25%\|dd8%\|mainline_persist>=0.05 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.040\|top2\|pg25%\|dd8%\|mainline_persist>=0.05 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.035\|top2\|pg30%\|dd8%\|mainline_persist>=0.05 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.040\|top2\|pg30%\|dd8%\|mainline_persist>=0.05 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.035\|top2\|pg30%\|dd8%\|mainline_persist>=0.05 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |
| confirmed-profit-sticky\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.040\|top2\|pg30%\|dd8%\|mainline_persist>=0.05 | 658.0% | 223.1% | -23.6% | 43 | 595.0% | 214.8% | 是 |

## 成交/成本敏感性

| 口径 | 收益 | 年化 | 最大回撤 | 交易 | 均仓 |
|---|---:|---:|---:|---:|---:|
| 收盘0bp close 0bp | 658.0% | 299.2% | -23.6% | 43 | 1.00 |
| 次开0bp nextopen 0bp | 626.3% | 287.7% | -21.4% | 43 | 1.00 |
| 收盘5bp close 5bp | 641.5% | 293.3% | -23.9% | 43 | 1.00 |
| 次开5bp nextopen 5bp | 610.5% | 282.0% | -21.5% | 43 | 1.00 |
| 次开10bp nextopen 10bp | 595.0% | 276.3% | -21.7% | 43 | 1.00 |

## 收益集中度

| 主题 | 涉及标的 | 交易次数 | 胜率 | 组合贡献 |
|---|---|---:|---:|---:|
| 全球芯片 | 501225 全球芯片 | 2 | 100% | +194.4% |
| 半导体设备 | 159516 半导体设备 | 1 | 100% | +161.7% |
| 通信 | 515880 通信 | 2 | 100% | +134.6% |
| 军工航天 | 159206 卫星 | 2 | 100% | +126.9% |
| 金融 | 513090 香港证券 | 1 | 100% | +23.9% |
| 恒生科技 | 159740 恒生科技 | 1 | 100% | +22.3% |
| 人工智能 | 159363 创业板人工智能 | 1 | 100% | +21.8% |
| 港股创新药 | 159567 港股创新药 | 2 | 50% | +21.7% |
| 电池储能 | 561910 电池 | 1 | 100% | +3.0% |
| 美股科技 | 159632 纳斯达克 | 1 | 0% | -3.3% |
| 中韩半导体 | 513310 中韩半导体 | 4 | 25% | -11.6% |
| 能源资源 | 515220 煤炭、518880 黄金、561360 石油 | 4 | 25% | -37.5% |

## 结论

本模式在盈利保护黏性龙头之上加入历史可回测的主线持续性确认门槛。该门槛不替代 anti_exhaustion_score，只过滤主线延续不足的候选。相对盈利保护黏性龙头，收益继续提高，回撤基本持平；仍属于单腿集中进攻模式，需要继续前向验证。
