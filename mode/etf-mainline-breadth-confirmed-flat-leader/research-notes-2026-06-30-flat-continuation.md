# 2026-06-30 非复利优先延续探索记录

## 基准

当前 WebUI/DB 推荐模式第一名为：

- 模式：`etf-mainline-breadth-confirmed-flat-leader`
- 配置：`breadth-confirmed-flat|anti_exhaustion_score|above60|4d|min6|sw0|top2|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30`
- 非复利收益：`248.1%`
- 复利收益：`865.8%`
- 最大回撤：`-19.2%`
- 最大持仓：`1`
- 交易次数：`57`
- 次日开盘 + 10bp 非复利收益：`233.9%`

本轮继续探索时，以 `flatReturn` 作为主排序指标，不以复利收益作为优先判断。

## 已完成扫描

### 1. 排序因子和宽度门槛扫描

扫描范围：

- 排序因子：`anti_exhaustion_score`、`mom30_trend_quality_smooth`、`mom30_width_stable`、`mom30_theme_leader`、`mom30_theme_power`、`mainline_quality_score`、`mainline_persist_score`、`mainline_continuity_score`、`mainline_expansion_score`、`fresh_mainline_score`、`ensemble_core_score`、`ensemble_risk_adjusted_score`、`rank_quality_score`、`rank_ensemble_score`、`mature_trend_score`、`new_high_persistence_score`、`regression_mainline_score`、`mom_rs_quality`、`pvt_confirm_score`、`obv_confirm_score`、`price_amount_power`、`volume_price_absorption_score`、`theme_continuity_score`、`theme_breadth_accel_score`、`theme_money_rotation_score`、`mainline_persist`、`multi_mom_quality_score`、`balanced_momentum_score`、`path_quality_score`、`downside_control_score`
- 组合排序：`anti_exhaustion_score` 叠加主题宽度、主题成交额、`mainline_persist`、`mom30_width_stable`、`mainline_quality_score`
- 参数：`rebalance` 3/4/5，`min_hold` 4/6/8/10，`top_exit` 1/2/3，盈利保护 15/6、20/8、25/8、30/10，`mainline_persist` 0.12/0.15/0.18/0.22，`theme_breadth_above120` 0.20/0.30/0.40/0.50/0.60
- 合计扫描：`132480` 组

结果：

- 未找到超过 `flatReturn=248.1%` 的组合。
- 前排候选大量并列在 `248.1%`，说明当前收益主要来自同一条交易路径，而不是某个细小参数带来的偶然优化。
- 最优族仍是 `anti_exhaustion_score + above60 + mainline_persist>=0.15 + theme_breadth_above120>=0.30/0.40/0.50 + 4日再平衡 + 15/6盈利保护`。

代表性顶部结果：

| flatReturn | 次开10bp flatReturn | 复利收益 | 最大回撤 | 分段 flatReturn | 说明 |
|---:|---:|---:|---:|---|---|
| 248.1% | 233.9% | 865.8% | -19.2% | 2025H1 45.8% / 2025H2 73.4% / 2026H1 79.1% | 与当前推荐模式同路径 |

### 2. 空仓/风险门槛探索

尝试方向：

- `anti_exhaustion_score` 入场门槛：`-0.05`、`0`、`0.05`、`0.10`、`0.15`、`0.20`、`0.25`
- 当前持仓强度跌破阈值后的退出
- `benchmark_risk_on` / `benchmark_risk_off` 市场风险门槛
- `theme_amount_power` 成交额确认门槛
- 找不到候选时是否主动空仓

结论：

- 逐组合回放版本运行成本过高，中途停止，未得到可证明超过基准的结果。
- 从第一轮 132480 组扫描看，当前基准模式对 `top_exit`、`min_hold`、主题宽度 0.30-0.50 并不敏感，说明交易路径较稳定；但空仓/市场门槛需要先做日级候选缓存和向量化回放，才能可靠完成更大规模扫描。

### 3. 快速候选缓存扫描

新增脚本：

- `fast-flat-scan.py`

扫描范围：

- 排序因子：`anti_exhaustion_score`、`mom30_trend_quality_smooth`、`mom30_width_stable`、`mainline_quality_score`
- 持续性门槛：`mainline_persist >= 0.12/0.15/0.18`
- 主题宽度：`theme_breadth_above120 >= 0.30/0.40/0.50`
- 入场强度：`-0.05/0/0.05/0.10/0.15`
- 市场风险：无门槛、`risk_off <= 0.14`、`risk_on >= 0.01 且 risk_off <= 0.10`
- 成交额确认：无门槛、`theme_amount_power >= 0.10`
- 回放规则：4 日再平衡；`min_hold` 4/6/8；`top_exit` 1/2/3；盈利保护 15/6 或 20/8；强度退出 `-0.05/0`；候选断档是否空仓
- 合计扫描：`77760` 组

结果：

- 最优仍为 `flatReturn=248.1%`，未突破当前基准。
- 顶部候选与当前推荐模式走同一条交易路径。
- 更严格的并列规则为：
  `anti_exhaustion_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|entry_score>=-0.05|risk_on>=0.000|risk_off<=0.14|theme_amount_power>=0.10`
- 对应回放规则：
  `4d|min8|top3|pg15%|dd6%|exitScore>=-0.05|closeNoSignal`
- 指标：`flatReturn=248.1%`、次开 10bp `flatReturn=233.9%`、复利 `865.8%`、最大回撤 `-19.2%`、持仓占比 `0.99`、交易次数 `58`。
- 输出文件：
  - `backtest-data/fast_flat_scan_2026-06-30.md`
  - `backtest-data/fast_flat_scan_top_trades_2026-06-30.md`

解释：

这说明当前交易路径里被选中的主线标的，本身已经满足较高主题宽度和成交额确认；继续提高这些门槛不会改变路径，也不会带来收益突破。下一步若要突破，重点不应再放在单腿门槛微调，而应转向主题级主线选择、同主题 ETF 代表品种映射、或 `nextopen + cost` 执行收益优化。

### 4. 同主题互斥 Top2/Top3 组合扫描

探索目的：

- 验证“最多持有 2/3 条主线、同主题互斥”能否比单腿龙头更好地覆盖阶段主升；
- 避免港股创新药与港股创新药(广发)这类同主题标的同时出现；
- 仍以 `flatReturn` 为主排序指标，最大持仓不超过 3。

扫描范围：

- 分数：`anti_exhaustion_score`
- 权重：`(1.0,)`、`(0.85,0.15)`、`(0.8,0.2)`、`(0.7,0.3)`、`(0.6,0.4)`、`(0.5,0.5)`、`(0.6,0.25,0.15)`、`(0.5,0.3,0.2)`、`(0.4,0.35,0.25)`、三等权
- 再平衡：3/4/5 日
- 门槛：`mainline_persist` 0.12/0.15/0.18；`theme_breadth_above120` 0.30/0.40/0.50；`theme_amount_power` 无/0.10；入场强度 -0.05/0/0.05/0.10
- 退出：跌出 TopN、跌破 MA120、盈利保护 15/6 或 20/8，另含无盈利保护版本
- 合计扫描：`25920` 组

结果：

- 未找到超过 `flatReturn=248.1%` 的 Top2/Top3 组合。
- 前排最优反而退化为 Top1，最佳 `flatReturn=226.7%`，次开 10bp `flatReturn=211.2%`，复利 `682.9%`，最大回撤 `-20.1%`。
- Top2/Top3 的分散持仓没有进入前排，说明在当前 ETF 池和非复利口径下，多主线持仓更多是在稀释第一龙头，而不是补充收益。

代表性结果：

| flatReturn | 次开10bp flatReturn | 复利收益 | 最大回撤 | 分段 flatReturn | 配置 |
|---:|---:|---:|---:|---|---|
| 226.7% | 211.2% | 682.9% | -20.1% | 2025H1 34.8% / 2025H2 97.2% / 2026H1 79.1% | `weights=(1.0,), 4d, mainline_persist>=0.15, theme_breadth_above120>=0.50, theme_amount_power>=0.10, entry_score>=-0.05` |

解释：

这次结果支持一个偏逆直觉的判断：想提升收益，并不是简单把 2025 创新药、通信、2026 半导体等主线“同时多拿几个”。这些主线在时间上有明显交替，真正有效的是在每个阶段尽快压到当时的单一最强龙头；多持仓会把资金分给第二、第三强主题，降低主升段的暴露。因此后续突破点应继续围绕“更早识别第一主线”和“减少错误替换”，而不是扩大持仓数。

### 5. 连续确认强者替换

探索目的：

- 保留单 ETF 龙头的敏捷性；
- 不引入多持仓稀释；
- 只在强者替换处加入“连续确认”，减少单次排名跳动造成的误切；
- 仍以 `flatReturn` 为主排序指标。

最佳候选已落盘为：

- `mode/etf-mainline-confirmed-switch-flat-leader`

规则：

- 候选：`above60`、`mainline_persist >= 0.15`、`theme_breadth_above120 >= 0.50`、`theme_amount_power >= 0.10`
- 排序：`anti_exhaustion_score`
- 复核：4 日
- 最小持有：8 日
- 替换：新强者需连续 2 次复核确认，并且强度领先当前持仓 `0.06`
- 退出：跌出 Top1、跌破 MA120、盈利保护 15/6

结果：

| flatReturn | 次开10bp flatReturn | 复利收益 | 最大回撤 | 交易 | 最大持仓 | 状态 |
|---:|---:|---:|---:|---:|---:|---|
| 248.2% | 233.9% | 866.3% | -19.2% | 58 | 1 | experiment |

解释：

该模式收盘 `flatReturn` 略高于当前 `breadth-confirmed` 基准的 `248.1%`，但优势只有约 `0.1` 个百分点，且次开 10bp 口径没有改善。单独从 2026H1 起跑时表现较弱，说明它对前序路径存在依赖。因此该模式作为“减少误切”的实验候选入库，不直接升级为推荐模式。

## 当前判断

截至本轮记录，仍应保留 `etf-mainline-breadth-confirmed-flat-leader` 作为非复利口径下的系统推荐模式。

不建议为了“看起来超过 248.1%”而采用更细碎的阈值或只命中少数交易的规则。下一步如果继续突破，应优先做一个高效的日级候选缓存回测器，再探索：

- 主升确认后的空仓风控；
- 对通信、半导体、创新药等主线族群的主题级强度排名；
- 龙头 ETF 与同主题重复 ETF 的互斥映射；
- 交易执行口径下的 `nextopen + cost` 目标，而不仅是收盘价回测。
