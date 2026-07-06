# ETF 主线指标大扫研究笔记

## 第一阶段范围

本阶段只纳入可以用当前历史 K 线稳定回测的指标，避免未来函数和不可复现数据。

已覆盖：

- 价格动量；
- 阶段突破；
- 均线趋势；
- 区间位置；
- 波动；
- 量能；
- 成交额承接；
- RSI/BOLL/MACD 近似；
- 主线复合分数；
- 阶段新高持有。
- 跟踪池内同主题宽度代理：同主题成员站上均线比例、强动量比例、突破比例、主题平均动量。

最新结论分三层：

- 收盘口径：`anti_exhaustion_score` 达到 `+564.8%`，微幅超过 `mom30_trend_quality_smooth` 的 `+562.9%`。
- 次开 10bp 鲁棒口径：`gap_momentum_score`、`pvt_confirm_score`、`anti_exhaustion_score` 同档，约 `+473.0%`，超过 `mom30` 的 `+384.0%`。
- 多主线 Runner：`multi_mom_quality_score` 提升到 `+167.9%`，次开 10bp `+158.5%`，但仍未突破单仓趋势质量。

`mom30_trend_quality_smooth` 的通用公式是：

```text
mom30 + 0.15 * max(MA20/MA60 - 1, 0) + 0.15 * max(收盘/MA60 - 1, 0) - 0.15 * ATR20/收盘
```

它说明：单纯 30 日动量已经很强，但加上趋势斜率、MA60 上方质量，并惩罚高波动后，可以更好地避开噪声和过度交易。交易数从 `mom30` 的 85 笔降到 67 笔。

抗过拟合扰动结果：

| 同族因子 | 次开 10bp | 结论 |
|---|---:|---|
| `mom30_trend_quality_smooth` | +472.5% | 当前最佳 |
| `mom30_trend_quality` | +445.9% | 超过旧基准 |
| `mom30_trend_quality_heavyvol` | +445.9% | 超过旧基准 |
| `mom30_trend_quality_fast` | +398.6% | 超过旧基准 |
| `mom30_trend_quality_lightvol` | +394.3% | 超过旧基准 |

邻近参数多数超过旧 `mom30` 鲁棒基准，说明这更像“趋势质量因子族有效”，而不是一个孤立参数点。

需要保留的警惕：该候选仍是单仓主线追随，收益集中在全球芯片、卫星、通信、半导体设备、中韩半导体等少数主题上，不能据此认为已经解决“多主线同时持仓”的问题。真正有价值的下一步，仍是用成分股宽度替代 ETF 宽度代理，并加入成分股资金宽度。

## 多主线 Runner 复测结论

本轮已将 `mom30_trend_quality_smooth`、`mom30_trend_quality`、`mom30_width_stable`、`mom30_theme_power`、`theme_width` 接入最多 3 仓 Runner 框架，并输出独立交易记录 `backtest-data/trades_runner_best.md`。

同时修复了 Runner 开仓循环中的同主题重复问题：原逻辑先生成候选列表再连续开仓，导致开第一只后没有重新检查主题占用，可能同日买入多只同主题 ETF。修复后，每次开仓前都会重新执行 `family_ok`。

加入多周期质量后，最终修复后最佳 Runner 更新为：

| 策略 | 收益 | 最大回撤 | 交易 | 最大持仓 | 均仓 | 次开10bp |
|---|---:|---:|---:|---:|---:|---:|
| `runner|multi_mom_quality_score|above120|5d|base` | +167.9% | -18.9% | 45 | 3 | 2.89 | +158.5% |

结论：

- 多仓 Runner 确实能持有多个不同主题，且多周期质量比主题强度旧版更好，但没有突破单仓趋势质量最佳；
- 同主题重复修复后，港股创新药/广发创新药、美股科技内部重复持仓问题消失；
- 当天退出某主题后，当天不再买入同主题其他 ETF，避免主题内无意义切换；
- 收益落后的主要原因不是持仓数量，而是 Top3 中混入了防御、资源、宽泛科技等强势但非主升主题；
- 下一阶段应先解决“真主线识别”，即成分股宽度、成分股资金宽度、板块新高宽度，而不是继续扩大持仓或继续调单一动量周期。

## 多周期一致性复测

用户追问 `mom90` 后，本轮补充了“周期结构”而不是只增加一个新动量周期：

- `multi_period_consistency`: 20/60/120 日动量同向，且趋势位置确认；
- `multi_mom_quality_score`: 多周期动量 + 趋势质量 + 波动惩罚；
- `balanced_momentum_score`: 短中长动量均衡，避免只追短线冲刺；
- `acceleration_curve_score`: 短周期相对中长期加速；
- `term_structure_slope/curve`: 动量期限结构斜率和曲率。

关键结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|balanced_momentum_score|above60|3d|100%` | +536.9% | -21.6% | 65 | +461.0% |
| `factor|acceleration_curve_score|above60|3d|100%` | +489.2% | -21.6% | 69 | +422.8% |
| `factor|multi_period_consistency|above120|10d|70%/20%/10%` | +243.9% | -17.5% | 87 | +230.2% |
| `runner|multi_mom_quality_score|above120|5d|base` | +167.9% | -18.9% | 45 | +158.5% |

结论：多周期结构对 Runner 有增量，但单仓排序仍不如趋势质量。强主线经常先由短中周期加速确认，过早要求 120 日也完全一致会滞后，因此多周期更适合做“组合候选确认”，不适合替代主排序。

## 持续性主线代理复测

本轮新增不依赖未来成分股的持续性代理：

- 个体强势持续：过去 10/20 日处在趋势质量 Top8 的比例；
- 主题强势持续：过去 20 日主题处在宽度 Top6 的比例；
- 新晋主线：最近 10 日进入强势前排，但不过度奖励长期拥挤。

最佳结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|fresh_mainline_score|above120|5d|100%` | +429.8% | -19.0% | 53 | +329.5% |

结论：持续性代理有解释力，但没有突破 `mom30_trend_quality_smooth`。长期持续霸榜反而容易滞后；更有价值的是“新晋强势主线”，它接近旧 `mom30` 但鲁棒性仍不足。

## 横截面排名代理复测

本轮继续新增横截面分位与排名跃迁：

- 趋势质量分位：`tq_rank_pct`；
- 动量分位：`mom_rank_pct`；
- 主题宽度分位：`width_rank_pct`；
- 主题横截面分位：`theme_rank_pct`；
- 趋势质量排名跃迁：`tq_rank_jump5/10`；
- 复合分数：`rank_quality_score`、`rank_surge_score`、`early_rank_confirm_score`。

关键结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|tq_rank_pct|above60|3d|100%` | +562.9% | -21.6% | 67 | +472.5% |
| `factor|rank_quality_score|above60|3d|100%` | +507.4% | -23.6% | 71 | +430.9% |
| `factor|cross_rank_blend|above60|3d|100%` | +399.5% | -21.4% | 105 | +286.5% |

结论：

- `tq_rank_pct` 与 `mom30_trend_quality_smooth` 交易等价，说明在当前 ETF 池里，最强绝对趋势质量也自然是横截面最强；
- `rank_quality_score` 收盘收益不错，但次开 10bp 低于趋势质量最佳；
- 多分位混合会引入“看起来强但不是主升核心”的方向，导致收益被稀释；
- 横截面排名更适合作为解释/确认字段，不应替代当前核心排序。

## 相对强弱 RS 复测

此前脚本已计算 `rs60/90/120`，但没有纳入大扫。本轮补齐：

- `rs20/30/60/90/120`；
- `combo90`、`combo60_90`；
- `rs30_trend_quality`、`rs60_trend_quality`；
- `mom_rs30_blend`、`mom_rs60_blend`、`mom_rs_quality`；
- `rs_accel`。

关键结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|mom_rs_quality|above60|3d|100%` | +515.6% | -21.6% | 71 | +437.2% |
| `factor|rs30_trend_quality|above60|3d|100%` | +509.5% | -21.6% | 73 | +436.9% |
| `factor|rs30|above60|3d|100%` | +468.3% | -21.6% | 85 | +384.0% |
| `factor|rs90|above120|5d|90%/10%` | +408.8% | -21.7% | 68 | +376.6% |

结论：

- RS 家族显著有效，尤其是 `rs30_trend_quality`；
- `rs30` 与 `mom30` 在当前 ETF 池里几乎等价；
- `mom_rs_quality` 比旧 `mom30` 鲁棒结果强，但仍低于 `mom30_trend_quality_smooth`；
- RS 更适合作为确认/解释项，而不是替代当前核心排序。

## 路径质量代理复测

本轮新增：

- 上涨日比例 `up_ratio30/60`；
- 趋势效率 `efficiency30/60`；
- 阶段收益/波动 `sharpe30/60`；
- 阶段收益/下行波动 `sortino30/60`；
- 阶段最大回撤 `path_mdd30/60`；
- 复合路径分数 `smooth_mom30/60`、`drawdown_adjusted_mom30/60`、`path_quality_score`。

关键结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|path_quality_score|above60|3d|100%` | +373.0% | -30.9% | 81 | +328.8% |
| `factor|smooth_mom30|above120|5d|100%` | +358.0% | -26.0% | 55 | +236.4% |
| `factor|sharpe30|above60|3d|100%` | +303.5% | -24.6% | 109 | +270.7% |

结论：路径质量不适合替代趋势质量。主线 ETF 的强主升往往不是低波顺滑走势，过度奖励上涨稳定性和低回撤会错过通信、芯片、半导体设备这类弹性主升段。

## K线结构代理复测

本轮新增：

- 收盘位置 `close_location`；
- 实体强弱 `body_pct`；
- 上下影线 `upper_shadow_pct/lower_shadow_pct`；
- 跳空 `gap_pct`；
- ATR 收缩 `atr_ratio20_60/range_contract`；
- 复合分数 `candle_strength_score`、`squeeze_breakout_score`、`gap_momentum_score`。

关键结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|gap_momentum_score|above60|3d|100%` | +559.3% | -21.6% | 65 | +473.0% |
| `factor|squeeze_breakout_score|above60|5d|100%` | +413.7% | -18.8% | 57 | +320.7% |
| `factor|candle_strength_score|above60|5d|100%` | +378.1% | -19.0% | 59 | +266.4% |

结论：

- `gap_momentum_score` 是目前唯一在次开 10bp 上微幅超过 `mom30_trend_quality_smooth` 的 ETF 自身因子；
- 这个提升只有 `+0.5` 个百分点，不能视为大突破，但说明跳空/实体确认能略微改善执行；
- 波动收缩和强势收盘本身不够，不能替代趋势质量。

## 成交额因子复测结论

本轮已将 a-stock-data `mootdx_kline` 返回的 `amount` 写入 K 线缓存，并新增以下指标：

- `amount_ratio5/20/60`；
- `amount_trend`；
- `amount_breakout`；
- `price_amount_power`；
- `amount_dryup_pullback`；
- 同主题成交额宽度代理。

结果：

- 量能/流动性族最佳：`factor|price_amount_power|above120|10d|85%/10%/5%`
- 收盘口径：`+218.6%`
- 次开 10bp：`+156.5%`
- 对比：`mom30` 次开 10bp 为 `+384.0%`

结论：ETF 自身成交额承接不是突破口，只能作为确认项。主线突破仍应继续往“成分股宽度 + 成分股资金宽度”走。

## 基准残差/alpha/beta 复测

本轮新增：

- `beta30/beta60`: ETF 对沪深300基准的滚动 beta；
- `corr30/corr60`: 与基准相关性；
- `alpha30/alpha60/alpha90`: 扣除 beta 后的残差收益；
- `residual_mom30/residual_mom60`: ETF 动量 - 基准动量；
- `alpha_trend_quality`、`independent_trend_score`、`low_beta_alpha_score`。

关键结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|alpha_trend_quality|above120|5d|100%` | +439.2% | -22.1% | 61 | +376.2% |
| `factor|alpha30|above60|5d|100%` | +426.3% | -24.4% | 61 | +354.7% |
| `factor|independent_trend_score|above60|3d|100%` | +409.8% | -23.3% | 87 | +359.3% |
| `factor|beta30|above120|5d|90%/10%` | +389.7% | -21.4% | 114 | +384.0% |

结论：基准残差能解释“这是不是独立于大盘的强势”，但目前不适合作为主排序核心。它更适合做过滤器：当 ETF 趋势质量接近时，优先选择 `alpha` 为正、相关性不过高、资金承接更好的主题。

## 技术指标扩展复测

本轮新增：

- MACD: `macd_norm`、`macd_trend_score`；
- DMI/ADX: `plus_di20`、`minus_di20`、`dmi_spread20`、`adx20`、`dmi_trend_score`、`adx_breakout_score`；
- OBV/PVT: `obv_slope20`、`amount_obv_slope20`、`pvt_slope20`、`obv_confirm_score`、`pvt_confirm_score`；
- MFI: `mfi14`、`mfi_trend_score`；
- 布林带: `boll_width_pct`、`boll_squeeze`；
- 回撤修复/均线带: `high_reclaim60`、`recovery_from_low60`、`recovery_breakout_score`、`ma_ribbon_score`。
- 统计趋势/摆动: `reg_slope30/60`、`reg_r2_30/60`、`regression_trend_score`、`regression_mainline_score`、`aroon_trend_score`、`stoch_k14`、`kdj_k`、`willr14`、`cci20`、`swing_strength_score`、`uptrend_pullback_score`、`volatility_expansion_score`。

关键结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|pvt_confirm_score|above60|3d|100%` | +559.3% | -21.6% | 65 | +473.0% |
| `factor|macd_trend_score|above60|3d|100%` | +550.7% | -21.6% | 71 | +451.2% |
| `factor|boll_width_pct|above120|10d|100%` | +489.3% | -27.1% | 61 | +449.5% |
| `factor|ma_ribbon_score|above60|5d|100%` | +427.6% | -21.0% | 51 | +346.4% |
| `factor|regression_trend_score|above60|3d|100%` | +423.4% | -22.8% | 71 | +356.3% |
| `factor|mfi_trend_score|above60|3d|100%` | +417.1% | -23.3% | 79 | +366.1% |
| `factor|volatility_expansion_score|above60|3d|100%` | +406.6% | -27.2% | 67 | +400.0% |

结论：

- `pvt_confirm_score` 与 `gap_momentum_score` 几乎同档，次开 10bp 为 `+473.0%`，说明 PVT 量价累积确认有用；
- `macd_trend_score` 进入前排，但次开 10bp 低于趋势质量扰动；
- 布林带宽度能抓到部分高弹性主升，但回撤扩大，稳定性不足；
- 回归斜率/R²、Aroon、KDJ/Stochastic、CCI/Williams、趋势内回踩和波动扩张都没有独立突破；
- ADX/DMI、OBV、MFI、均线带、回撤修复都没有独立突破，适合作为解释或过滤，不适合作为主排序核心。

## 集成/风控复测

本轮新增：

- `confirm_stack_score`: 趋势质量 + PVT + 跳空 + MACD + alpha 确认；
- `ensemble_core_score`: 趋势质量、缺口、PVT、RS、alpha 的保守集成；
- `ensemble_risk_adjusted_score`: 在集成核心上扣除波动、路径回撤和基准风险；
- `regime_trend_score`: 趋势质量 + 沪深300风险状态；
- `mainline_quality_score`: 趋势质量 + PVT/缺口/RS/alpha；
- `rank_ensemble_score`: 趋势质量 + 确认项 + 横截面分位。

关键结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|ensemble_risk_adjusted_score|above60|3d|100%` | +540.1% | -21.6% | 67 | +465.3% |
| `factor|confirm_stack_score|above60|3d|100%` | +515.6% | -21.6% | 71 | +437.2% |
| `factor|ensemble_core_score|above60|3d|100%` | +515.6% | -21.6% | 71 | +437.2% |
| `factor|rank_ensemble_score|above60|3d|100%` | +512.5% | -21.6% | 71 | +427.8% |

结论：确认项集成没有突破 `mom30_trend_quality_smooth`，也没有超过 `gap_momentum_score/pvt_confirm_score` 的次开 10bp 口径。简单堆叠确认项会稀释最有效的趋势质量信号；风控类更适合用于人工复核和仓位管理，不适合替代主排序。

## 趋势寿命/过热衰竭复测

本轮新增：

- `streak_above20/60`: 连续站上 MA20/MA60 天数；
- `streak_up`: 连续上涨天数；
- `new_high_rate20/60`: 近 20/60 日接近 60 日新高的比例；
- `mom30_z`: 30 日动量相对 30 日波动的 z-score；
- `trend_age_score`: 趋势质量 + 站上均线持续性；
- `new_high_persistence_score`: 趋势质量 + 创新高频率；
- `normalized_momentum_score`: 趋势质量 + 动量 z-score；
- `anti_exhaustion_score`: 趋势质量 - RSI/布林/上影线过热惩罚；
- `mature_trend_score`: 趋势质量 + 成熟趋势持续 + alpha。

关键结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|anti_exhaustion_score|above60|3d|100%` | +564.8% | -21.6% | 67 | +473.0% |
| `factor|new_high_persistence_score|above60|5d|100%` | +397.1% | -19.2% | 51 | +338.2% |
| `factor|normalized_momentum_score|above60|3d|100%` | +373.6% | -29.8% | 81 | +326.8% |
| `factor|trend_age_score|above60|3d|100%` | +355.3% | -23.0% | 81 | +308.3% |
| `factor|mom30_z|above60|3d|100%` | +303.5% | -24.6% | 109 | +270.7% |

结论：`anti_exhaustion_score` 是小幅增量，说明在趋势质量上轻微惩罚过热形态有帮助；但改善幅度很小，不能视为模式突破。趋势寿命、创新高频率、动量 z-score 单独排序都弱，说明“持续了多久”不如“当下 30 日趋势质量 + 执行确认”重要。

## 尾部风险/回撤结构复测

本轮新增：

- `ulcer30/60`: 阶段回撤深度与持续性的 Ulcer 指标；
- `skew30/60`: 阶段收益偏度；
- `tail_loss30/60`: 阶段最差 20% 日收益均值；
- `calmar30/60`: 阶段收益/最大回撤；
- `ulcer_adjusted_mom30`: 30 日动量 - Ulcer 惩罚；
- `tail_risk_adjusted_mom30`: 30 日动量 + 尾部损失/偏度调整；
- `calmar_mom30`: 30 日动量 + Calmar 调整；
- `downside_control_score`: 趋势质量 - Ulcer + 尾部风险控制；
- `drawdown_repair_score`: 趋势质量 + 区间位置 - 回撤惩罚。

关键结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|downside_control_score|above60|3d|100%` | +511.1% | -23.3% | 67 | +464.6% |
| `factor|ulcer_adjusted_mom30|above60|3d|100%` | +417.2% | -26.7% | 81 | +364.6% |
| `factor|drawdown_repair_score|above60|3d|100%` | +381.4% | -31.0% | 81 | +330.9% |
| `factor|calmar_mom30|above120|5d|100%` | +365.4% | -24.4% | 57 | +255.1% |

结论：尾部风险/回撤结构没有改善主线排序，最好结果也低于 `anti_exhaustion_score` 与趋势质量基准。对 ETF 主升行情来说，过度惩罚回撤和尾部波动会错过弹性段，更适合做风控解释或仓位调整。

## 成交额成本线/波动状态/主题加速度复测

本轮继续新增一批可历史回测、但不只是 mom/rs 的主线代理：

- `amount_price_dist20/60`: 当前价格相对 20/60 日成交额加权成本线的位置；
- `amount_cost_reclaim_score`: 30 日动量 + 成交额成本线站回 + 成交额趋势；
- `volume_price_absorption_score`: 放量后收盘位置较强、上影线不过重；
- `vcp_breakout_score`: 窄幅蓄势后突破，叠加成交额趋势和上影线惩罚；
- `ma_pullback_reclaim_score`: 上升趋势中回踩 MA20/MA60 后再转强；
- `volatility_regime_shift_score`: 波动收缩后重新扩张；
- `theme_width_accel5/10`: 同主题 ETF 宽度加速度；
- `theme_breadth_accel_score`: 趋势质量 + 主题宽度加速度；
- `theme_money_rotation_score`: 趋势质量 + 同主题成交额宽度和成交额加速度；
- `mainline_expansion_score`: 趋势质量 + 主题宽度 + 主题宽度加速度。

关键结果：

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp |
|---|---:|---:|---:|---:|
| `factor|vcp_breakout_score|above60|3d|100%` | +447.7% | -21.6% | 85 | +392.4% |
| `factor|volatility_regime_shift_score|above60|3d|100%` | +420.3% | -27.2% | 71 | +393.8% |
| `factor|amount_cost_reclaim_score|above60|3d|100%` | +353.5% | -29.8% | 97 | +303.0% |
| `factor|theme_breadth_accel_score|above60|3d|100%` | +270.3% | -22.0% | 101 | +229.4% |
| `runner|mainline_expansion_score|above60|3d|base` | +150.2% | -19.8% | 49 | +152.5% |

结论：

- `vcp_breakout_score` 是本轮新增项里最强的单仓因子，但次开 10bp 仍明显低于 `gap_momentum_score/anti_exhaustion_score` 的 `+473.0%`；
- 成交额成本线、量价承接、均线回踩转强更适合作为解释字段，独立排序会降低主线捕捉；
- 用 ETF 池内部同主题宽度做加速度，噪声仍大，不能替代真实板块/成分股宽度；
- 这轮负结果支持一个更明确的工程方向：下一步要用 `board_newhigh_snapshots`、成分股宽度、成分股资金宽度，而不是继续只在 ETF 自身 K 线上加指标。

## 板块新高宽度快照探针

本轮进一步检查了项目内置的真实板块新高宽度表 `board_newhigh_snapshots`。

实测结果：

| 项目 | 数值 |
|---|---:|
| 数据库 | `backend/data/stock-agent.sqlite` |
| 快照交易日 | 1 |
| 快照行数 | 60 |
| 覆盖日期 | 2026-06-26 |

因为只有一个交易日，本轮没有把它塞进历史收益曲线。正确处理方式是生成独立探针报告：

`backtest-data/breadth_snapshot_probe.md`

最新快照复核：

| Runner 当前持仓 | 宽度证据 | 结论 |
|---|---|---|
| `515880 通信` | 通信技术新高 46、占比 12.0%、排名 7 | 有板块宽度支撑 |
| `501225 全球芯片` | 半导体概念新高 64、占比 12.9%、排名 1 | 有板块宽度支撑 |
| `513310 中韩半导体` | 半导体概念新高 64、占比 12.9%、排名 1 | 有板块宽度支撑 |

结论：板块新高宽度是目前最接近“真正主线”的系统内置数据。它在 2026-06-26 能解释当前 Runner 持有的通信/芯片主线，但样本长度不足，不能证明收益改进。下一步应持续落库后做前向 walk-forward，而不是用单日快照回填历史。

## ETF 份额/申赎资金探针

本轮继续检查 `etf_share_daily`，新增 `etf-share-flow-probe.py`，生成：

`backtest-data/etf_share_flow_probe.md`

实测数据覆盖：

| 项目 | 数值 |
|---|---:|
| 交易日 | 3 |
| 行数 | 160 |
| 日期 | 2026-06-24 至 2026-06-26 |

近端主题资金扩张：

| 主题 | 估算净申购额 | 主题份额变化率 |
|---|---:|---:|
| 电网电力 | +32.34 亿 | +9.04% |
| 半导体设备 | +25.80 亿 | +7.59% |
| 金融 | +11.24 亿 | +1.38% |
| 芯片宽泛 | +7.40 亿 | +2.31% |
| 科创芯片 | +1.62 亿 | +0.30% |
| 中韩半导体 | +0.39 亿 | +0.26% |
| 通信 | +0.07 亿 | +0.01% |

Runner 持仓复核：

| 持仓 | 份额变化 | 结论 |
|---|---:|---|
| `515880 通信` | +0.00% | 份额平稳 |
| `501225 全球芯片` | 无份额数据 | 暂不能用份额确认 |
| `513310 中韩半导体` | +0.26% | 小幅扩张 |

结论：ETF 份额是资金侧的有用确认项，但目前只有 3 天，不能参与历史收益回测。它和板块新高宽度一样，应该进入前向验证框架：趋势质量负责交易触发，板块新高宽度负责主线硬证据，ETF 份额变化负责资金确认/分歧。

## 主线共识探针

本轮继续新增 `mainline-consensus-probe.py`，把三类近端数据合成：

- `market_themes`: 主题强度、阶段、强度历史；
- `board_newhigh_snapshots`: 板块新高宽度；
- `etf_share_daily`: ETF 份额/申赎资金。

输出文件：

`backtest-data/mainline_consensus_probe.md`

关键结果：

| 排名 | ETF主题 | 主题证据 | 宽度证据 | 份额证据 | Runner持有 |
|---:|---|---|---|---:|---|
| 1 | 半导体设备 | 集成电路封测强度 100/启动 | 半导体概念新高 64、排名 1 | +25.80 亿 | 否 |
| 2 | 芯片宽泛 | 集成电路封测强度 100/启动 | 半导体概念新高 64、排名 1 | +7.40 亿 | 否 |
| 3 | 科创芯片 | 集成电路封测强度 100/启动 | 半导体概念新高 64、排名 1 | +1.62 亿 | 否 |
| 4 | 中韩半导体 | 集成电路封测强度 100/启动 | 半导体概念新高 64、排名 1 | +0.39 亿 | 是 |
| 5 | 全球芯片 | 集成电路封测强度 100/启动 | 半导体概念新高 64、排名 1 | 0.00 亿 | 是 |
| 6 | 通信 | 通信线缆及配套强度 92/分歧 | 华为概念新高 51、排名 5 | +0.07 亿 | 是 |

结论：

- 当前 Runner 的三个持仓在共识探针中排第 4、5、6，方向没有跑偏；
- 半导体/芯片链是近端共识最强主线；
- 同一主线内部的 ETF 载体选择仍有优化空间，近端证据更偏向 `半导体设备/芯片/科创芯片`；
- 由于三类数据历史仍短，这个共识分只能前向验证，不能回填历史收益。

## 系统内可继续接入的数据

下一阶段应从“ETF 自身指标”升级到“主题级数据”。CodeGraph 复核后，项目里已经存在一条更像主线判据的确定性链路：`backend/src/breadth/*` 会用 `stock_rank_cxg_ths`、行业/概念板块清单和板块成分，生成 `board_newhigh_snapshots`，字段包括板块新高数、新高占比、横向排名、持续天数等。这比单纯 mom/rs 更贴近“通信、创新药、半导体设备是否成为真正主线”。

| 数据 | 系统来源 | 是否适合回测 | 用法 |
|---|---|---|---|
| 板块新高宽度 | `backend/src/breadth/*`、`board_newhigh_snapshots` | 高，取决于历史快照长度 | 主线硬证据：板块内创新高数量、占比、排名、持续天数。 |
| 成分股横截面快照 | `fetchMarketSnapshot` | 中高 | 用上涨家数、成交额、换手、行业聚合出主题宽度。 |
| 板块涨幅榜/60日强势榜 | `getSectorRanking` | 中 | 将 ETF 映射到东财行业/概念 BK 码后，做主题强度确认。 |
| 板块资金流 | `getSectorMoneyFlow` | 中 | 判断主线是否有资金合力，但历史完整性需验证。 |
| 个股资金流 | `getStockFundFlow` | 高 | 对 ETF 成分股汇总主力净流入，构造主题资金宽度。 |
| 成交额/量比/换手 | `getQuotesEastmoney`、K线 amount 扩展 | 高 | 判断主线是否获得流动性承接。 |
| 板块宽度 | 成分股 + K线 | 高 | 计算成分股新高家数、站上均线比例、涨幅中位数。 |
| 涨停梯队/龙头评分 | `getEmotion/getLadder/getDragonRanking` | 低到中 | 更适合盘中确认，历史回测要额外落库。 |
| 龙虎榜 | `getDragonTigerEntries` | 中 | 主题龙头资金确认，适合解释与风控。 |
| 研报/新闻/公告 | `research_reports/mx_search/cninfo` | 低 | 催化确认，文本历史难量化，适合人工/LLM复核。 |
| 财务估值 | `getFinancialStatements/getStockValuation` | 中 | 用于过滤，不是 ETF 主线启动核心。 |
| 筹码分布 | `getChipDistribution` | 低 | ETF 价值低，个股龙头下钻时可用。 |

当前 live 复查注意：a-stock-data sidecar 配置地址 `http://192.168.31.144:9119` 本轮请求 `/api/manifest`、`industry_comparison`、`mootdx_kline` 返回 502，`127.0.0.1:9119` 未监听。因此这些端点属于“系统已内置、代码可接入”，但当前实时服务需要另行恢复后才能继续取新数据。已有 K 线缓存仍可用于本轮回测。

## 下一阶段优先级

1. 建立 ETF → 主题 → 成分股映射。
2. 用成分股 K 线计算主题宽度：新高家数、MA60/120 上方比例、涨幅中位数。
3. 用个股资金流汇总主题资金宽度。
4. 将 `主题宽度 + 主题资金 + ETF趋势` 合成主线分数，再回测。
5. 所有新候选必须同时输出收盘口径和 `次开 + 10bp` 口径，避免高换手指标伪突破。

这比继续在 ETF 自身 `mom/rs` 上微调更可能解决“真正选出主线”的问题。

## 主线大类去重回测

针对“半导体设备/科创芯片/中韩半导体/全球芯片同属一条半导体主线，但此前 Runner 可能把它们视为不同细主题”的问题，本轮新增 `mainline_group` 粗分组，并加入 `runner-mainline|...` 对照模式。

粗主线映射：

| 主线大类 | 覆盖细主题 |
|---|---|
| 半导体芯片 | 半导体设备、科创芯片、全球芯片、中韩半导体、芯片宽泛 |
| 港股科技 | 港美互联网、恒生科技、港股通科技 |
| AI软件 | 人工智能、信创软件 |
| 电力能源 | 电网电力、能源资源 |
| 消费传媒 | 消费、传媒游戏 |

回测结果：

| 模式 | 最佳参数 | 收益 | 均仓 | 交易 | 交易记录 |
|---|---|---:|---:|---:|---|
| 原 Runner | `runner|multi_mom_quality_score|above120|5d|base` | +167.9% | 2.89 | 24 | `backtest-data/trades_runner_best.md` |
| 主线大类 Runner | `runner-mainline|multi_mom_quality_score|above120|10d|base` | +156.0% | 2.80 | 23 | `backtest-data/trades_runner_mainline_best.md` |

复扫 `trades_runner_mainline_best.md` 的持仓区间后，同一主线大类重叠持仓次数为 0。该模式没有超过原 Runner，但它更接近“最多 3 条不同主线，每条主线只选一个 ETF 载体”的实用约束；收益下降约 11.9 个百分点，可视为消除同主线重复暴露后的真实代价。

## IC 体检与高 IC 因子复测

本轮运行 `ic_health_check.py` 与 `factor_export.py`，导出：

- `backtest-data/ic_health_check.md`
- `backtest-data/factor-catalog.json`

样本为 55 只 ETF、800 个交易日、257 个候选因子。IC 结果显示，真正稳定的横截面预测因子集中在“横截面排名 + 主题宽度/主线扩散”：

| 因子 | 5日 mean IC | 5日 t值 | 10日 mean IC | 观察 |
|---|---:|---:|---:|---|
| `cross_rank_blend` | 0.1039 | 5.65 | 0.1368 | 全场排序最强。 |
| `mom30_width_stable` | 0.0952 | 5.06 | 0.1274 | 动量叠加主题宽度，稳定有效。 |
| `rank_quality_score` | 0.0933 | 4.95 | 0.1257 | 排名质量高 IC。 |
| `mainline_expansion_score` | 0.0876 | 4.81 | 0.1175 | 主线扩散有前瞻性。 |

但把这些高 IC 因子补入 Runner 后，组合收益没有突破：

| 模式 | 最好结果 | 收益 | 次开10bp收益 | 结论 |
|---|---|---:|---:|---|
| 原 Runner | `runner|multi_mom_quality_score|above120|5d|base` | +167.9% | +158.5% | 仍是最佳。 |
| 主线大类 Runner | `runner-mainline|multi_mom_quality_score|above120|10d|base` | +156.0% | +159.7% | 实用约束更强，收益略低。 |
| 高 IC Runner | `runner|rank_quality_score|above60|3d|tight` | +143.8% | +105.2% | 未突破原 Runner。 |
| 高 IC 单因子 | `factor|cross_rank_blend|above60|3d|100%` | +399.5% | +286.5% | 高 IC 不等于单仓/三仓收益冠军。 |

结论：IC 体检确认了主题宽度和横截面排名是有效数据，但它们更适合作为“主线确认/过滤/拥挤惩罚”，而不是直接替代趋势质量做主排序。下一步更合理的方向是把高 IC 的主题宽度作为入场门槛或持仓过滤，而不是单独排序。
