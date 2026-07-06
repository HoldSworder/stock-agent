# ETF 主线指标大扫回测摘要

- 回测区间: 2025-01-02 至 2026-06-26
- ETF池: 55/55 只可用
- 对比基准: 短周期冲刺 `+468.3%`；早期突破 `+420.1%`
- 最大持仓: 3；原 Runner 同细主题最多 1 只；主线大类 Runner 同一大主线最多 1 只。
- 收盘口径最佳: `factor|anti_exhaustion_score|above60|3d|100%`
- 次开10bp鲁棒最佳: `factor|gap_momentum_score|above60|3d|100%`，收益 `473.0%`

- 多主线 Runner 最佳: `runner|multi_mom_quality_score|above120|5d|base`，收益 `167.9%`，最大持仓 `3`，均仓 `2.89`，交易记录见 `trades_runner_best.md`。

- 主线大类 Runner 最佳: `runner-mainline|multi_mom_quality_score|above120|10d|base`，收益 `156.0%`，最大持仓 `3`，均仓 `2.80`，交易记录见 `trades_runner_mainline_best.md`。

## Top20 参数

| 指标族 | 策略 | 收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 超短周期冲刺 |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 趋势寿命 | factor\|anti_exhaustion_score\|above60\|3d\|100% | 564.8% | 265.0% | -21.6% | 67 | 1.00 | 357 | 是 |
| 趋势寿命 | factor\|anti_exhaustion_score\|above120\|3d\|100% | 564.8% | 265.0% | -21.6% | 67 | 1.00 | 357 | 是 |
| 复合主线 | factor\|mom30_trend_quality_smooth\|above60\|3d\|100% | 562.9% | 264.3% | -21.6% | 67 | 1.00 | 357 | 是 |
| 复合主线 | factor\|mom30_trend_quality_smooth\|above120\|3d\|100% | 562.9% | 264.3% | -21.6% | 67 | 1.00 | 357 | 是 |
| 横截面排名 | factor\|tq_rank_pct\|above60\|3d\|100% | 562.9% | 264.3% | -21.6% | 67 | 1.00 | 357 | 是 |
| 横截面排名 | factor\|tq_rank_pct\|above120\|3d\|100% | 562.9% | 264.3% | -21.6% | 67 | 1.00 | 357 | 是 |
| K线结构 | factor\|gap_momentum_score\|above60\|3d\|100% | 559.3% | 262.9% | -21.6% | 65 | 1.00 | 357 | 是 |
| K线结构 | factor\|gap_momentum_score\|above120\|3d\|100% | 559.3% | 262.9% | -21.6% | 65 | 1.00 | 357 | 是 |
| 技术指标 | factor\|pvt_confirm_score\|above60\|3d\|100% | 559.3% | 262.9% | -21.6% | 65 | 1.00 | 357 | 是 |
| 技术指标 | factor\|pvt_confirm_score\|above120\|3d\|100% | 559.3% | 262.9% | -21.6% | 65 | 1.00 | 357 | 是 |
| 技术指标 | factor\|macd_trend_score\|above60\|3d\|100% | 550.7% | 259.7% | -21.6% | 71 | 1.00 | 357 | 是 |
| 技术指标 | factor\|macd_trend_score\|above120\|3d\|100% | 550.7% | 259.7% | -21.6% | 71 | 1.00 | 357 | 是 |
| 集成/风控 | factor\|ensemble_risk_adjusted_score\|above60\|3d\|100% | 540.1% | 255.7% | -21.6% | 67 | 1.00 | 357 | 是 |
| 集成/风控 | factor\|ensemble_risk_adjusted_score\|above120\|3d\|100% | 540.1% | 255.7% | -21.6% | 67 | 1.00 | 357 | 是 |
| 多周期一致性 | factor\|balanced_momentum_score\|above60\|3d\|100% | 536.9% | 254.5% | -21.6% | 65 | 1.00 | 357 | 是 |
| 多周期一致性 | factor\|balanced_momentum_score\|above120\|3d\|100% | 536.9% | 254.5% | -21.6% | 65 | 1.00 | 357 | 是 |
| 复合主线 | factor\|mom30_trend_quality\|above60\|3d\|100% | 528.9% | 251.4% | -21.6% | 67 | 1.00 | 357 | 是 |
| 复合主线 | factor\|mom30_trend_quality\|above120\|3d\|100% | 528.9% | 251.4% | -21.6% | 67 | 1.00 | 357 | 是 |
| 复合主线 | factor\|mom30_trend_quality_heavyvol\|above60\|3d\|100% | 528.9% | 251.4% | -21.6% | 67 | 1.00 | 357 | 是 |
| 复合主线 | factor\|mom30_trend_quality_heavyvol\|above120\|3d\|100% | 528.9% | 251.4% | -21.6% | 67 | 1.00 | 357 | 是 |

## 各指标族最佳

| 指标族 | 策略 | 收益 | 最大回撤 | 交易 | 次开10bp收益 |
|---|---|---:|---:|---:|---:|
| 趋势寿命 | factor\|anti_exhaustion_score\|above60\|3d\|100% | 564.8% | -21.6% | 67 | 473.0% |
| 复合主线 | factor\|mom30_trend_quality_smooth\|above60\|3d\|100% | 562.9% | -21.6% | 67 | 472.5% |
| 横截面排名 | factor\|tq_rank_pct\|above60\|3d\|100% | 562.9% | -21.6% | 67 | 472.5% |
| K线结构 | factor\|gap_momentum_score\|above60\|3d\|100% | 559.3% | -21.6% | 65 | 473.0% |
| 技术指标 | factor\|pvt_confirm_score\|above60\|3d\|100% | 559.3% | -21.6% | 65 | 473.0% |
| 集成/风控 | factor\|ensemble_risk_adjusted_score\|above60\|3d\|100% | 540.1% | -21.6% | 67 | 465.3% |
| 多周期一致性 | factor\|balanced_momentum_score\|above60\|3d\|100% | 536.9% | -21.6% | 65 | 461.0% |
| 相对强弱 | factor\|mom_rs_quality\|above60\|3d\|100% | 515.6% | -21.6% | 71 | 437.2% |
| 尾部风险 | factor\|downside_control_score\|above60\|3d\|100% | 511.1% | -23.3% | 67 | 464.6% |
| 主题代理 | factor\|theme_width\|above60\|3d\|100% | 492.2% | -20.0% | 141 | 276.7% |
| 动量 | factor\|mom30\|above60\|3d\|100% | 468.3% | -21.6% | 85 | 384.0% |
| 基准残差 | factor\|alpha_trend_quality\|above120\|5d\|100% | 439.2% | -22.1% | 61 | 376.2% |
| 持续性主线 | factor\|fresh_mainline_score\|above120\|5d\|100% | 429.8% | -19.0% | 53 | 329.5% |
| 路径质量 | factor\|path_quality_score\|above60\|3d\|100% | 373.0% | -30.9% | 81 | 328.8% |
| 突破/位置 | factor\|recovery_breakout_score\|above60\|3d\|100% | 366.6% | -23.6% | 77 | 285.3% |
| 量能/流动性 | factor\|amount_cost_reclaim_score\|above60\|3d\|100% | 353.5% | -29.8% | 97 | 303.0% |
| 均线/趋势 | factor\|dist_ma120\|above120\|3d\|90%/10% | 297.6% | -21.0% | 108 | 267.9% |
| 阶段新高 | breakout\|hi60prev\|3d\|100%\|m4%/6%\|ma60 | 207.7% | -18.9% | 5 | 210.9% |
| 多主线Runner | runner\|multi_mom_quality_score\|above120\|5d\|base | 167.9% | -18.9% | 45 | 158.5% |
| 其他 | factor\|early_accel\|above60\|10d\|85%/10%/5% | 161.3% | -17.3% | 173 | 136.2% |
| 主线大类Runner | runner-mainline\|multi_mom_quality_score\|above120\|5d\|base | 156.1% | -18.7% | 47 | 149.7% |
| 波动 | factor\|quiet_trend\|above60\|10d\|100% | 21.4% | -42.4% | 37 | 3.5% |

## 本轮新增指标专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|vcp_breakout_score\|above60\|3d\|100% | 447.7% | -21.6% | 85 | 1.00 | 392.4% | 未超过单仓鲁棒最佳 |
| factor\|vcp_breakout_score\|above120\|3d\|100% | 447.7% | -21.6% | 85 | 1.00 | 392.4% | 未超过单仓鲁棒最佳 |
| factor\|volatility_regime_shift_score\|above60\|3d\|100% | 420.3% | -27.2% | 71 | 1.00 | 393.8% | 未超过单仓鲁棒最佳 |
| factor\|volatility_regime_shift_score\|above120\|3d\|100% | 420.3% | -27.2% | 71 | 1.00 | 393.8% | 未超过单仓鲁棒最佳 |
| factor\|volatility_regime_shift_score\|above60\|5d\|100% | 369.8% | -24.4% | 51 | 1.00 | 284.9% | 未超过单仓鲁棒最佳 |
| factor\|volatility_regime_shift_score\|above120\|5d\|100% | 369.8% | -24.4% | 51 | 1.00 | 284.9% | 未超过单仓鲁棒最佳 |
| factor\|amount_cost_reclaim_score\|above60\|3d\|100% | 353.5% | -29.8% | 97 | 1.00 | 303.0% | 未超过单仓鲁棒最佳 |
| factor\|amount_cost_reclaim_score\|above120\|3d\|100% | 353.5% | -29.8% | 97 | 1.00 | 303.0% | 未超过单仓鲁棒最佳 |
| factor\|amount_cost_reclaim_score\|above120\|5d\|100% | 331.3% | -23.8% | 65 | 1.00 | 250.0% | 未超过单仓鲁棒最佳 |
| factor\|amount_cost_reclaim_score\|above60\|5d\|100% | 327.8% | -24.4% | 65 | 1.00 | 253.5% | 未超过单仓鲁棒最佳 |
| factor\|vcp_breakout_score\|above120\|5d\|100% | 305.4% | -23.7% | 67 | 1.00 | 237.4% | 未超过单仓鲁棒最佳 |
| factor\|volatility_regime_shift_score\|above60\|10d\|100% | 299.7% | -31.5% | 43 | 1.00 | 215.3% | 未超过单仓鲁棒最佳 |
| factor\|volatility_regime_shift_score\|above120\|10d\|100% | 299.7% | -31.5% | 43 | 1.00 | 215.3% | 未超过单仓鲁棒最佳 |
| factor\|vcp_breakout_score\|above60\|5d\|100% | 288.7% | -24.4% | 67 | 1.00 | 233.0% | 未超过单仓鲁棒最佳 |
| factor\|amount_cost_reclaim_score\|above60\|10d\|100% | 287.7% | -30.9% | 49 | 1.00 | 197.2% | 未超过单仓鲁棒最佳 |
| factor\|amount_cost_reclaim_score\|above120\|10d\|100% | 287.7% | -30.9% | 49 | 1.00 | 197.2% | 未超过单仓鲁棒最佳 |
| factor\|theme_breadth_accel_score\|above60\|3d\|100% | 270.3% | -22.0% | 101 | 1.00 | 229.4% | 未超过单仓鲁棒最佳 |
| factor\|theme_breadth_accel_score\|above120\|3d\|100% | 270.3% | -22.0% | 101 | 1.00 | 229.4% | 未超过单仓鲁棒最佳 |
| factor\|theme_breadth_accel_score\|above60\|5d\|100% | 269.3% | -16.9% | 73 | 1.00 | 212.7% | 未超过单仓鲁棒最佳 |
| factor\|theme_breadth_accel_score\|above120\|5d\|100% | 269.3% | -16.9% | 73 | 1.00 | 212.7% | 未超过单仓鲁棒最佳 |
| factor\|mainline_expansion_score\|above120\|3d\|90%/10% | 259.0% | -20.1% | 218 | 2.00 | 268.9% | 未超过单仓鲁棒最佳 |
| factor\|mainline_expansion_score\|above60\|3d\|90%/10% | 258.3% | -20.1% | 220 | 2.00 | 267.7% | 未超过单仓鲁棒最佳 |
| factor\|amount_price_dist60\|above60\|10d\|100% | 246.8% | -34.6% | 49 | 1.00 | 167.1% | 未超过单仓鲁棒最佳 |
| factor\|amount_price_dist60\|above120\|10d\|100% | 246.8% | -34.6% | 49 | 1.00 | 167.1% | 未超过单仓鲁棒最佳 |

## 趋势质量扰动专项

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---|
| factor\|mom30_trend_quality_smooth\|above60\|3d\|100% | 562.9% | -21.6% | 67 | 472.5% | 超过旧鲁棒基准 |
| factor\|mom30_trend_quality_smooth\|above120\|3d\|100% | 562.9% | -21.6% | 67 | 472.5% | 超过旧鲁棒基准 |
| factor\|mom30_trend_quality\|above60\|3d\|100% | 528.9% | -21.6% | 67 | 445.9% | 超过旧鲁棒基准 |
| factor\|mom30_trend_quality\|above120\|3d\|100% | 528.9% | -21.6% | 67 | 445.9% | 超过旧鲁棒基准 |
| factor\|mom30_trend_quality_heavyvol\|above60\|3d\|100% | 528.9% | -21.6% | 67 | 445.9% | 超过旧鲁棒基准 |
| factor\|mom30_trend_quality_heavyvol\|above120\|3d\|100% | 528.9% | -21.6% | 67 | 445.9% | 超过旧鲁棒基准 |
| factor\|rs30_trend_quality\|above60\|3d\|100% | 509.5% | -21.6% | 73 | 436.9% | 超过旧鲁棒基准 |
| factor\|rs30_trend_quality\|above120\|3d\|100% | 509.5% | -21.6% | 73 | 436.9% | 超过旧鲁棒基准 |
| factor\|mom30_trend_quality_lightvol\|above60\|3d\|100% | 464.6% | -21.6% | 69 | 394.3% | 超过旧鲁棒基准 |
| factor\|mom30_trend_quality_lightvol\|above120\|3d\|100% | 464.6% | -21.6% | 69 | 394.3% | 超过旧鲁棒基准 |
| factor\|mom30_trend_quality_fast\|above60\|3d\|100% | 464.3% | -21.6% | 67 | 398.6% | 超过旧鲁棒基准 |
| factor\|mom30_trend_quality_fast\|above120\|3d\|100% | 464.3% | -21.6% | 67 | 398.6% | 超过旧鲁棒基准 |
| factor\|alpha_trend_quality\|above120\|5d\|100% | 439.2% | -22.1% | 61 | 376.2% | 未超过旧鲁棒基准 |
| factor\|alpha_trend_quality\|above120\|10d\|100% | 408.9% | -21.8% | 35 | 315.4% | 未超过旧鲁棒基准 |
| factor\|alpha_trend_quality\|above60\|5d\|100% | 392.6% | -21.0% | 61 | 352.0% | 未超过旧鲁棒基准 |
| factor\|rs30_trend_quality\|above120\|5d\|100% | 390.2% | -21.0% | 53 | 319.2% | 未超过旧鲁棒基准 |
| factor\|mom30_trend_quality_smooth\|above120\|5d\|100% | 376.6% | -21.0% | 51 | 312.1% | 未超过旧鲁棒基准 |
| factor\|rs30_trend_quality\|above60\|5d\|100% | 370.1% | -21.0% | 53 | 313.7% | 未超过旧鲁棒基准 |

## 多周期一致性专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|balanced_momentum_score\|above60\|3d\|100% | 536.9% | -21.6% | 65 | 1.00 | 461.0% | 未超过单仓鲁棒最佳 |
| factor\|balanced_momentum_score\|above120\|3d\|100% | 536.9% | -21.6% | 65 | 1.00 | 461.0% | 未超过单仓鲁棒最佳 |
| factor\|acceleration_curve_score\|above60\|3d\|100% | 489.2% | -21.6% | 69 | 1.00 | 422.8% | 未超过单仓鲁棒最佳 |
| factor\|acceleration_curve_score\|above120\|3d\|100% | 489.2% | -21.6% | 69 | 1.00 | 422.8% | 未超过单仓鲁棒最佳 |
| factor\|balanced_momentum_score\|above60\|5d\|100% | 404.5% | -21.0% | 51 | 1.00 | 325.0% | 未超过单仓鲁棒最佳 |
| factor\|balanced_momentum_score\|above120\|5d\|100% | 404.5% | -21.0% | 51 | 1.00 | 325.0% | 未超过单仓鲁棒最佳 |
| factor\|acceleration_curve_score\|above120\|5d\|100% | 353.8% | -21.0% | 53 | 1.00 | 294.8% | 未超过单仓鲁棒最佳 |
| factor\|balanced_momentum_score\|above60\|10d\|100% | 344.4% | -23.4% | 41 | 1.00 | 261.2% | 未超过单仓鲁棒最佳 |
| factor\|balanced_momentum_score\|above120\|10d\|100% | 344.4% | -23.4% | 41 | 1.00 | 261.2% | 未超过单仓鲁棒最佳 |
| factor\|acceleration_curve_score\|above60\|5d\|100% | 335.1% | -21.0% | 53 | 1.00 | 289.6% | 未超过单仓鲁棒最佳 |
| factor\|acceleration_curve_score\|above60\|10d\|100% | 323.1% | -23.4% | 39 | 1.00 | 247.4% | 未超过单仓鲁棒最佳 |
| factor\|acceleration_curve_score\|above120\|10d\|100% | 323.1% | -23.4% | 39 | 1.00 | 247.4% | 未超过单仓鲁棒最佳 |
| factor\|multi_period_consistency\|above120\|10d\|70%/20%/10% | 243.9% | -17.5% | 87 | 3.00 | 230.2% | 未超过单仓鲁棒最佳 |
| factor\|multi_period_consistency\|above60\|10d\|70%/20%/10% | 243.7% | -17.5% | 85 | 3.00 | 230.0% | 未超过单仓鲁棒最佳 |
| factor\|multi_period_consistency\|above120\|5d\|100% | 241.4% | -20.3% | 53 | 1.00 | 214.9% | 未超过单仓鲁棒最佳 |
| factor\|multi_period_consistency\|above120\|10d\|85%/10%/5% | 238.6% | -18.6% | 87 | 3.00 | 226.1% | 未超过单仓鲁棒最佳 |
| factor\|multi_period_consistency\|above60\|10d\|85%/10%/5% | 238.5% | -18.6% | 85 | 3.00 | 226.0% | 未超过单仓鲁棒最佳 |
| factor\|multi_period_consistency\|above60\|5d\|100% | 232.1% | -20.3% | 51 | 1.00 | 213.8% | 未超过单仓鲁棒最佳 |

## 相对强弱 RS 专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|mom_rs_quality\|above60\|3d\|100% | 515.6% | -21.6% | 71 | 1.00 | 437.2% | 未超过单仓鲁棒最佳 |
| factor\|mom_rs_quality\|above120\|3d\|100% | 515.6% | -21.6% | 71 | 1.00 | 437.2% | 未超过单仓鲁棒最佳 |
| factor\|rs30_trend_quality\|above60\|3d\|100% | 509.5% | -21.6% | 73 | 1.00 | 436.9% | 未超过单仓鲁棒最佳 |
| factor\|rs30_trend_quality\|above120\|3d\|100% | 509.5% | -21.6% | 73 | 1.00 | 436.9% | 未超过单仓鲁棒最佳 |
| factor\|rs30\|above60\|3d\|100% | 468.3% | -21.6% | 85 | 1.00 | 384.0% | 未超过单仓鲁棒最佳 |
| factor\|rs30\|above120\|3d\|100% | 468.3% | -21.6% | 85 | 1.00 | 384.0% | 未超过单仓鲁棒最佳 |
| factor\|mom_rs30_blend\|above60\|3d\|100% | 468.3% | -21.6% | 85 | 1.00 | 384.0% | 未超过单仓鲁棒最佳 |
| factor\|mom_rs30_blend\|above120\|3d\|100% | 468.3% | -21.6% | 85 | 1.00 | 384.0% | 未超过单仓鲁棒最佳 |
| factor\|rs30\|above120\|5d\|100% | 420.1% | -16.5% | 59 | 1.00 | 345.1% | 未超过单仓鲁棒最佳 |
| factor\|mom_rs30_blend\|above120\|5d\|100% | 420.1% | -16.5% | 59 | 1.00 | 345.1% | 未超过单仓鲁棒最佳 |
| factor\|rs90\|above120\|5d\|90%/10% | 408.8% | -21.7% | 68 | 2.00 | 376.6% | 未超过单仓鲁棒最佳 |
| factor\|rs30\|above60\|5d\|100% | 398.7% | -17.1% | 59 | 1.00 | 339.2% | 未超过单仓鲁棒最佳 |
| factor\|mom_rs30_blend\|above60\|5d\|100% | 398.7% | -17.1% | 59 | 1.00 | 339.2% | 未超过单仓鲁棒最佳 |
| factor\|combo90\|above120\|5d\|90%/10% | 393.0% | -23.9% | 68 | 2.00 | 358.2% | 未超过单仓鲁棒最佳 |
| factor\|rs30_trend_quality\|above120\|5d\|100% | 390.2% | -21.0% | 53 | 1.00 | 319.2% | 未超过单仓鲁棒最佳 |
| factor\|rs30\|above60\|10d\|100% | 388.1% | -16.7% | 43 | 1.00 | 287.8% | 未超过单仓鲁棒最佳 |
| factor\|rs30\|above120\|10d\|100% | 388.1% | -16.7% | 43 | 1.00 | 287.8% | 未超过单仓鲁棒最佳 |
| factor\|mom_rs30_blend\|above60\|10d\|100% | 388.1% | -16.7% | 43 | 1.00 | 287.8% | 未超过单仓鲁棒最佳 |

## 路径质量专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|path_quality_score\|above60\|3d\|100% | 373.0% | -30.9% | 81 | 1.00 | 328.8% | 未超过单仓鲁棒最佳 |
| factor\|path_quality_score\|above120\|3d\|100% | 373.0% | -30.9% | 81 | 1.00 | 328.8% | 未超过单仓鲁棒最佳 |
| factor\|smooth_mom30\|above120\|5d\|100% | 358.0% | -26.0% | 55 | 1.00 | 236.4% | 未超过单仓鲁棒最佳 |
| factor\|smooth_mom30\|above60\|5d\|100% | 339.2% | -26.0% | 55 | 1.00 | 232.0% | 未超过单仓鲁棒最佳 |
| factor\|smooth_mom30\|above60\|3d\|100% | 315.4% | -34.1% | 95 | 1.00 | 310.2% | 未超过单仓鲁棒最佳 |
| factor\|smooth_mom30\|above120\|3d\|100% | 315.4% | -34.1% | 95 | 1.00 | 310.2% | 未超过单仓鲁棒最佳 |
| factor\|path_quality_score\|above120\|5d\|100% | 312.4% | -24.4% | 53 | 1.00 | 220.2% | 未超过单仓鲁棒最佳 |
| factor\|sharpe30\|above60\|3d\|100% | 303.5% | -24.6% | 109 | 1.00 | 270.7% | 未超过单仓鲁棒最佳 |
| factor\|sharpe30\|above120\|3d\|100% | 303.5% | -24.6% | 109 | 1.00 | 270.7% | 未超过单仓鲁棒最佳 |
| factor\|path_quality_score\|above60\|5d\|100% | 295.4% | -24.9% | 53 | 1.00 | 216.0% | 未超过单仓鲁棒最佳 |
| factor\|smooth_mom30\|above60\|10d\|100% | 286.5% | -28.8% | 47 | 1.00 | 184.6% | 未超过单仓鲁棒最佳 |
| factor\|smooth_mom30\|above120\|10d\|100% | 286.5% | -28.8% | 47 | 1.00 | 184.6% | 未超过单仓鲁棒最佳 |
| factor\|path_quality_score\|above60\|10d\|100% | 283.0% | -32.5% | 45 | 1.00 | 198.1% | 未超过单仓鲁棒最佳 |
| factor\|path_quality_score\|above120\|10d\|100% | 283.0% | -32.5% | 45 | 1.00 | 198.1% | 未超过单仓鲁棒最佳 |
| factor\|drawdown_adjusted_mom30\|above60\|3d\|100% | 254.8% | -30.3% | 95 | 0.99 | 208.8% | 未超过单仓鲁棒最佳 |
| factor\|drawdown_adjusted_mom30\|above120\|3d\|100% | 254.8% | -30.3% | 95 | 0.99 | 208.8% | 未超过单仓鲁棒最佳 |
| factor\|sortino30\|above60\|5d\|100% | 243.0% | -24.1% | 83 | 1.00 | 193.7% | 未超过单仓鲁棒最佳 |
| factor\|sortino30\|above120\|5d\|100% | 241.5% | -24.1% | 81 | 1.00 | 192.7% | 未超过单仓鲁棒最佳 |

## 尾部风险专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|downside_control_score\|above60\|3d\|100% | 511.1% | -23.3% | 67 | 1.00 | 464.6% | 未超过单仓鲁棒最佳 |
| factor\|downside_control_score\|above120\|3d\|100% | 511.1% | -23.3% | 67 | 1.00 | 464.6% | 未超过单仓鲁棒最佳 |
| factor\|ulcer_adjusted_mom30\|above60\|3d\|100% | 417.2% | -26.7% | 81 | 1.00 | 364.6% | 未超过单仓鲁棒最佳 |
| factor\|ulcer_adjusted_mom30\|above120\|3d\|100% | 417.2% | -26.7% | 81 | 1.00 | 364.6% | 未超过单仓鲁棒最佳 |
| factor\|downside_control_score\|above120\|5d\|100% | 392.9% | -18.8% | 53 | 1.00 | 308.6% | 未超过单仓鲁棒最佳 |
| factor\|drawdown_repair_score\|above60\|3d\|100% | 381.4% | -31.0% | 81 | 1.00 | 330.9% | 未超过单仓鲁棒最佳 |
| factor\|drawdown_repair_score\|above120\|3d\|100% | 381.4% | -31.0% | 81 | 1.00 | 330.9% | 未超过单仓鲁棒最佳 |
| factor\|downside_control_score\|above60\|5d\|100% | 372.6% | -19.3% | 53 | 1.00 | 303.2% | 未超过单仓鲁棒最佳 |
| factor\|calmar_mom30\|above120\|5d\|100% | 365.4% | -24.4% | 57 | 1.00 | 255.1% | 未超过单仓鲁棒最佳 |
| factor\|drawdown_repair_score\|above120\|5d\|100% | 351.4% | -24.4% | 55 | 1.00 | 253.5% | 未超过单仓鲁棒最佳 |
| factor\|calmar_mom30\|above60\|5d\|100% | 346.3% | -25.1% | 57 | 1.00 | 250.5% | 未超过单仓鲁棒最佳 |
| factor\|downside_control_score\|above60\|10d\|100% | 335.3% | -20.5% | 43 | 1.00 | 246.9% | 未超过单仓鲁棒最佳 |
| factor\|downside_control_score\|above120\|10d\|100% | 335.3% | -20.5% | 43 | 1.00 | 246.9% | 未超过单仓鲁棒最佳 |
| factor\|drawdown_repair_score\|above60\|5d\|100% | 332.9% | -25.2% | 55 | 1.00 | 248.9% | 未超过单仓鲁棒最佳 |
| factor\|drawdown_repair_score\|above60\|10d\|100% | 329.7% | -31.6% | 43 | 1.00 | 240.1% | 未超过单仓鲁棒最佳 |
| factor\|drawdown_repair_score\|above120\|10d\|100% | 329.7% | -31.6% | 43 | 1.00 | 240.1% | 未超过单仓鲁棒最佳 |
| factor\|calmar_mom30\|above60\|3d\|100% | 326.9% | -25.6% | 95 | 1.00 | 292.7% | 未超过单仓鲁棒最佳 |
| factor\|calmar_mom30\|above120\|3d\|100% | 326.9% | -25.6% | 95 | 1.00 | 292.7% | 未超过单仓鲁棒最佳 |

## K线结构专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|gap_momentum_score\|above60\|3d\|100% | 559.3% | -21.6% | 65 | 1.00 | 473.0% | 超过单仓鲁棒最佳 |
| factor\|gap_momentum_score\|above120\|3d\|100% | 559.3% | -21.6% | 65 | 1.00 | 473.0% | 超过单仓鲁棒最佳 |
| factor\|body_pct\|above120\|3d\|100% | 480.7% | -25.4% | 209 | 0.99 | 214.5% | 未超过单仓鲁棒最佳 |
| factor\|body_pct\|above60\|3d\|100% | 474.3% | -26.8% | 211 | 0.99 | 236.7% | 未超过单仓鲁棒最佳 |
| factor\|vcp_breakout_score\|above60\|3d\|100% | 447.7% | -21.6% | 85 | 1.00 | 392.4% | 未超过单仓鲁棒最佳 |
| factor\|vcp_breakout_score\|above120\|3d\|100% | 447.7% | -21.6% | 85 | 1.00 | 392.4% | 未超过单仓鲁棒最佳 |
| factor\|squeeze_breakout_score\|above60\|5d\|100% | 413.7% | -18.8% | 57 | 1.00 | 320.7% | 未超过单仓鲁棒最佳 |
| factor\|squeeze_breakout_score\|above120\|5d\|100% | 413.7% | -18.8% | 57 | 1.00 | 320.7% | 未超过单仓鲁棒最佳 |
| factor\|squeeze_breakout_score\|above60\|3d\|100% | 393.1% | -23.0% | 97 | 1.00 | 321.7% | 未超过单仓鲁棒最佳 |
| factor\|squeeze_breakout_score\|above120\|3d\|100% | 393.1% | -23.0% | 97 | 1.00 | 321.7% | 未超过单仓鲁棒最佳 |
| factor\|candle_strength_score\|above60\|5d\|100% | 378.1% | -19.0% | 59 | 1.00 | 266.4% | 未超过单仓鲁棒最佳 |
| factor\|candle_strength_score\|above120\|5d\|100% | 378.1% | -19.0% | 59 | 1.00 | 266.4% | 未超过单仓鲁棒最佳 |
| factor\|gap_momentum_score\|above120\|5d\|100% | 373.8% | -21.0% | 55 | 1.00 | 300.6% | 未超过单仓鲁棒最佳 |
| factor\|gap_momentum_score\|above60\|5d\|100% | 354.4% | -21.0% | 55 | 1.00 | 295.4% | 未超过单仓鲁棒最佳 |
| factor\|candle_strength_score\|above60\|3d\|100% | 349.8% | -25.0% | 101 | 1.00 | 205.4% | 未超过单仓鲁棒最佳 |
| factor\|candle_strength_score\|above120\|3d\|100% | 349.8% | -25.0% | 101 | 1.00 | 205.4% | 未超过单仓鲁棒最佳 |
| factor\|candle_strength_score\|above60\|10d\|100% | 344.5% | -19.3% | 41 | 1.00 | 258.8% | 未超过单仓鲁棒最佳 |
| factor\|candle_strength_score\|above120\|10d\|100% | 344.5% | -19.3% | 41 | 1.00 | 258.8% | 未超过单仓鲁棒最佳 |

## 基准残差专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|alpha_trend_quality\|above120\|5d\|100% | 439.2% | -22.1% | 61 | 1.00 | 376.2% | 未超过单仓鲁棒最佳 |
| factor\|alpha30\|above60\|5d\|100% | 426.3% | -24.4% | 61 | 1.00 | 354.7% | 未超过单仓鲁棒最佳 |
| factor\|residual_mom30\|above60\|5d\|100% | 426.3% | -24.4% | 61 | 1.00 | 354.7% | 未超过单仓鲁棒最佳 |
| factor\|alpha30\|above60\|10d\|100% | 422.4% | -31.5% | 37 | 1.00 | 317.8% | 未超过单仓鲁棒最佳 |
| factor\|residual_mom30\|above60\|10d\|100% | 422.4% | -31.5% | 37 | 1.00 | 317.8% | 未超过单仓鲁棒最佳 |
| factor\|alpha30\|above120\|5d\|100% | 410.0% | -24.4% | 63 | 1.00 | 338.6% | 未超过单仓鲁棒最佳 |
| factor\|residual_mom30\|above120\|5d\|100% | 410.0% | -24.4% | 63 | 1.00 | 338.6% | 未超过单仓鲁棒最佳 |
| factor\|independent_trend_score\|above60\|3d\|100% | 409.8% | -23.3% | 87 | 1.00 | 359.3% | 未超过单仓鲁棒最佳 |
| factor\|independent_trend_score\|above120\|3d\|100% | 409.8% | -23.3% | 87 | 1.00 | 359.3% | 未超过单仓鲁棒最佳 |
| factor\|alpha_trend_quality\|above120\|10d\|100% | 408.9% | -21.8% | 35 | 1.00 | 315.4% | 未超过单仓鲁棒最佳 |
| factor\|alpha_trend_quality\|above60\|5d\|100% | 392.6% | -21.0% | 61 | 1.00 | 352.0% | 未超过单仓鲁棒最佳 |
| factor\|beta30\|above120\|5d\|90%/10% | 389.7% | -21.4% | 114 | 2.00 | 384.0% | 未超过单仓鲁棒最佳 |
| factor\|independent_trend_score\|above120\|5d\|100% | 369.6% | -24.4% | 59 | 1.00 | 285.2% | 未超过单仓鲁棒最佳 |
| factor\|alpha30\|above120\|10d\|100% | 367.8% | -31.5% | 37 | 1.00 | 273.6% | 未超过单仓鲁棒最佳 |
| factor\|residual_mom30\|above120\|10d\|100% | 367.8% | -31.5% | 37 | 1.00 | 273.6% | 未超过单仓鲁棒最佳 |
| factor\|alpha30\|above60\|3d\|100% | 353.5% | -28.4% | 99 | 1.00 | 316.7% | 未超过单仓鲁棒最佳 |
| factor\|residual_mom30\|above60\|3d\|100% | 353.5% | -28.4% | 99 | 1.00 | 316.7% | 未超过单仓鲁棒最佳 |
| factor\|independent_trend_score\|above60\|5d\|100% | 350.3% | -25.1% | 59 | 1.00 | 280.2% | 未超过单仓鲁棒最佳 |

## 技术指标扩展专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|pvt_confirm_score\|above60\|3d\|100% | 559.3% | -21.6% | 65 | 1.00 | 473.0% | 超过单仓鲁棒最佳 |
| factor\|pvt_confirm_score\|above120\|3d\|100% | 559.3% | -21.6% | 65 | 1.00 | 473.0% | 超过单仓鲁棒最佳 |
| factor\|macd_trend_score\|above60\|3d\|100% | 550.7% | -21.6% | 71 | 1.00 | 451.2% | 未超过单仓鲁棒最佳 |
| factor\|macd_trend_score\|above120\|3d\|100% | 550.7% | -21.6% | 71 | 1.00 | 451.2% | 未超过单仓鲁棒最佳 |
| factor\|boll_width_pct\|above120\|10d\|100% | 489.3% | -27.1% | 61 | 1.00 | 449.5% | 未超过单仓鲁棒最佳 |
| factor\|boll_width_pct\|above60\|10d\|100% | 445.5% | -27.1% | 59 | 1.00 | 407.0% | 未超过单仓鲁棒最佳 |
| factor\|ma_ribbon_score\|above60\|5d\|100% | 427.6% | -21.0% | 51 | 1.00 | 346.4% | 未超过单仓鲁棒最佳 |
| factor\|ma_ribbon_score\|above120\|5d\|100% | 427.6% | -21.0% | 51 | 1.00 | 346.4% | 未超过单仓鲁棒最佳 |
| factor\|regression_trend_score\|above60\|3d\|100% | 423.4% | -22.8% | 71 | 1.00 | 356.3% | 未超过单仓鲁棒最佳 |
| factor\|regression_trend_score\|above120\|3d\|100% | 423.4% | -22.8% | 71 | 1.00 | 356.3% | 未超过单仓鲁棒最佳 |
| factor\|volatility_regime_shift_score\|above60\|3d\|100% | 420.3% | -27.2% | 71 | 1.00 | 393.8% | 未超过单仓鲁棒最佳 |
| factor\|volatility_regime_shift_score\|above120\|3d\|100% | 420.3% | -27.2% | 71 | 1.00 | 393.8% | 未超过单仓鲁棒最佳 |
| factor\|mfi_trend_score\|above60\|3d\|100% | 417.1% | -23.3% | 79 | 1.00 | 366.1% | 未超过单仓鲁棒最佳 |
| factor\|mfi_trend_score\|above120\|3d\|100% | 417.1% | -23.3% | 79 | 1.00 | 366.1% | 未超过单仓鲁棒最佳 |
| factor\|mfi_trend_score\|above120\|5d\|100% | 415.7% | -18.8% | 55 | 1.00 | 339.2% | 未超过单仓鲁棒最佳 |
| factor\|ma_ribbon_score\|above60\|3d\|100% | 413.0% | -26.7% | 71 | 1.00 | 367.8% | 未超过单仓鲁棒最佳 |
| factor\|ma_ribbon_score\|above120\|3d\|100% | 413.0% | -26.7% | 71 | 1.00 | 367.8% | 未超过单仓鲁棒最佳 |
| factor\|macd_trend_score\|above120\|5d\|100% | 409.9% | -21.0% | 51 | 1.00 | 324.2% | 未超过单仓鲁棒最佳 |
| factor\|volatility_expansion_score\|above60\|3d\|100% | 406.6% | -27.2% | 67 | 1.00 | 400.0% | 未超过单仓鲁棒最佳 |
| factor\|volatility_expansion_score\|above120\|3d\|100% | 406.6% | -27.2% | 67 | 1.00 | 400.0% | 未超过单仓鲁棒最佳 |
| factor\|regression_trend_score\|above60\|10d\|100% | 406.3% | -18.9% | 43 | 1.00 | 309.0% | 未超过单仓鲁棒最佳 |
| factor\|regression_trend_score\|above120\|10d\|100% | 406.3% | -18.9% | 43 | 1.00 | 309.0% | 未超过单仓鲁棒最佳 |
| factor\|pvt_confirm_score\|above120\|5d\|100% | 395.8% | -21.0% | 49 | 1.00 | 317.0% | 未超过单仓鲁棒最佳 |
| factor\|mfi_trend_score\|above60\|5d\|100% | 394.5% | -19.6% | 55 | 1.00 | 333.5% | 未超过单仓鲁棒最佳 |

## 集成/风控专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|ensemble_risk_adjusted_score\|above60\|3d\|100% | 540.1% | -21.6% | 67 | 1.00 | 465.3% | 未超过单仓鲁棒最佳 |
| factor\|ensemble_risk_adjusted_score\|above120\|3d\|100% | 540.1% | -21.6% | 67 | 1.00 | 465.3% | 未超过单仓鲁棒最佳 |
| factor\|confirm_stack_score\|above60\|3d\|100% | 515.6% | -21.6% | 71 | 1.00 | 437.2% | 未超过单仓鲁棒最佳 |
| factor\|confirm_stack_score\|above120\|3d\|100% | 515.6% | -21.6% | 71 | 1.00 | 437.2% | 未超过单仓鲁棒最佳 |
| factor\|ensemble_core_score\|above60\|3d\|100% | 515.6% | -21.6% | 71 | 1.00 | 437.2% | 未超过单仓鲁棒最佳 |
| factor\|ensemble_core_score\|above120\|3d\|100% | 515.6% | -21.6% | 71 | 1.00 | 437.2% | 未超过单仓鲁棒最佳 |
| factor\|regime_trend_score\|above60\|3d\|100% | 515.6% | -21.6% | 71 | 1.00 | 437.2% | 未超过单仓鲁棒最佳 |
| factor\|regime_trend_score\|above120\|3d\|100% | 515.6% | -21.6% | 71 | 1.00 | 437.2% | 未超过单仓鲁棒最佳 |
| factor\|mainline_quality_score\|above60\|3d\|100% | 515.6% | -21.6% | 71 | 1.00 | 437.2% | 未超过单仓鲁棒最佳 |
| factor\|mainline_quality_score\|above120\|3d\|100% | 515.6% | -21.6% | 71 | 1.00 | 437.2% | 未超过单仓鲁棒最佳 |
| factor\|rank_ensemble_score\|above60\|3d\|100% | 512.5% | -21.6% | 71 | 1.00 | 427.8% | 未超过单仓鲁棒最佳 |
| factor\|rank_ensemble_score\|above120\|3d\|100% | 512.5% | -21.6% | 71 | 1.00 | 427.8% | 未超过单仓鲁棒最佳 |
| factor\|ensemble_risk_adjusted_score\|above120\|5d\|100% | 394.8% | -21.0% | 51 | 1.00 | 307.8% | 未超过单仓鲁棒最佳 |
| factor\|confirm_stack_score\|above120\|5d\|100% | 376.6% | -21.0% | 51 | 1.00 | 312.1% | 未超过单仓鲁棒最佳 |
| factor\|ensemble_core_score\|above120\|5d\|100% | 376.6% | -21.0% | 51 | 1.00 | 312.1% | 未超过单仓鲁棒最佳 |
| factor\|regime_trend_score\|above120\|5d\|100% | 376.6% | -21.0% | 51 | 1.00 | 312.1% | 未超过单仓鲁棒最佳 |
| factor\|mainline_quality_score\|above120\|5d\|100% | 376.6% | -21.0% | 51 | 1.00 | 312.1% | 未超过单仓鲁棒最佳 |
| factor\|rank_ensemble_score\|above60\|5d\|100% | 376.6% | -21.0% | 51 | 1.00 | 312.1% | 未超过单仓鲁棒最佳 |
| factor\|rank_ensemble_score\|above120\|5d\|100% | 376.6% | -21.0% | 51 | 1.00 | 312.1% | 未超过单仓鲁棒最佳 |
| factor\|ensemble_risk_adjusted_score\|above60\|5d\|100% | 374.5% | -21.0% | 51 | 1.00 | 302.5% | 未超过单仓鲁棒最佳 |
| factor\|confirm_stack_score\|above60\|5d\|100% | 357.0% | -21.0% | 51 | 1.00 | 306.7% | 未超过单仓鲁棒最佳 |
| factor\|ensemble_core_score\|above60\|5d\|100% | 357.0% | -21.0% | 51 | 1.00 | 306.7% | 未超过单仓鲁棒最佳 |
| factor\|regime_trend_score\|above60\|5d\|100% | 357.0% | -21.0% | 51 | 1.00 | 306.7% | 未超过单仓鲁棒最佳 |
| factor\|mainline_quality_score\|above60\|5d\|100% | 357.0% | -21.0% | 51 | 1.00 | 306.7% | 未超过单仓鲁棒最佳 |

## 趋势寿命专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|anti_exhaustion_score\|above60\|3d\|100% | 564.8% | -21.6% | 67 | 1.00 | 473.0% | 超过单仓鲁棒最佳 |
| factor\|anti_exhaustion_score\|above120\|3d\|100% | 564.8% | -21.6% | 67 | 1.00 | 473.0% | 超过单仓鲁棒最佳 |
| factor\|new_high_persistence_score\|above60\|5d\|100% | 397.1% | -19.2% | 51 | 1.00 | 338.2% | 未超过单仓鲁棒最佳 |
| factor\|new_high_persistence_score\|above120\|5d\|100% | 397.1% | -19.2% | 51 | 1.00 | 338.2% | 未超过单仓鲁棒最佳 |
| factor\|new_high_persistence_score\|above60\|10d\|100% | 383.5% | -19.2% | 41 | 1.00 | 293.1% | 未超过单仓鲁棒最佳 |
| factor\|new_high_persistence_score\|above120\|10d\|100% | 383.5% | -19.2% | 41 | 1.00 | 293.1% | 未超过单仓鲁棒最佳 |
| factor\|new_high_persistence_score\|above60\|3d\|100% | 378.1% | -26.1% | 79 | 1.00 | 337.2% | 未超过单仓鲁棒最佳 |
| factor\|new_high_persistence_score\|above120\|3d\|100% | 378.1% | -26.1% | 79 | 1.00 | 337.2% | 未超过单仓鲁棒最佳 |
| factor\|anti_exhaustion_score\|above120\|5d\|100% | 376.6% | -21.0% | 51 | 1.00 | 312.1% | 未超过单仓鲁棒最佳 |
| factor\|normalized_momentum_score\|above60\|3d\|100% | 373.6% | -29.8% | 81 | 1.00 | 326.8% | 未超过单仓鲁棒最佳 |
| factor\|normalized_momentum_score\|above120\|3d\|100% | 373.6% | -29.8% | 81 | 1.00 | 326.8% | 未超过单仓鲁棒最佳 |
| factor\|anti_exhaustion_score\|above60\|5d\|100% | 357.0% | -21.0% | 51 | 1.00 | 306.7% | 未超过单仓鲁棒最佳 |
| factor\|trend_age_score\|above60\|3d\|100% | 355.3% | -23.0% | 81 | 1.00 | 308.3% | 未超过单仓鲁棒最佳 |
| factor\|trend_age_score\|above120\|3d\|100% | 355.3% | -23.0% | 81 | 1.00 | 308.3% | 未超过单仓鲁棒最佳 |
| factor\|anti_exhaustion_score\|above60\|10d\|100% | 344.4% | -23.4% | 41 | 1.00 | 261.2% | 未超过单仓鲁棒最佳 |
| factor\|anti_exhaustion_score\|above120\|10d\|100% | 344.4% | -23.4% | 41 | 1.00 | 261.2% | 未超过单仓鲁棒最佳 |
| factor\|trend_age_score\|above120\|5d\|100% | 341.6% | -23.0% | 59 | 1.00 | 266.3% | 未超过单仓鲁棒最佳 |
| factor\|trend_age_score\|above60\|5d\|100% | 323.5% | -23.0% | 59 | 1.00 | 261.5% | 未超过单仓鲁棒最佳 |
| factor\|normalized_momentum_score\|above120\|5d\|100% | 322.6% | -24.4% | 51 | 1.00 | 233.8% | 未超过单仓鲁棒最佳 |
| factor\|normalized_momentum_score\|above60\|5d\|100% | 305.2% | -24.9% | 51 | 1.00 | 229.4% | 未超过单仓鲁棒最佳 |
| factor\|mom30_z\|above60\|3d\|100% | 303.5% | -24.6% | 109 | 1.00 | 270.7% | 未超过单仓鲁棒最佳 |
| factor\|mom30_z\|above120\|3d\|100% | 303.5% | -24.6% | 109 | 1.00 | 270.7% | 未超过单仓鲁棒最佳 |
| factor\|trend_age_score\|above60\|10d\|100% | 296.9% | -24.2% | 43 | 1.00 | 222.4% | 未超过单仓鲁棒最佳 |
| factor\|trend_age_score\|above120\|10d\|100% | 296.9% | -24.2% | 43 | 1.00 | 222.4% | 未超过单仓鲁棒最佳 |

## 持续性主线专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|fresh_mainline_score\|above120\|5d\|100% | 429.8% | -19.0% | 53 | 1.00 | 329.5% | 未超过单仓鲁棒最佳 |
| factor\|fresh_mainline_score\|above60\|5d\|100% | 417.1% | -19.0% | 53 | 1.00 | 320.6% | 未超过单仓鲁棒最佳 |
| factor\|fresh_mainline_score\|above60\|10d\|100% | 417.0% | -17.7% | 45 | 1.00 | 308.1% | 未超过单仓鲁棒最佳 |
| factor\|fresh_mainline_score\|above120\|10d\|100% | 417.0% | -17.7% | 45 | 1.00 | 308.1% | 未超过单仓鲁棒最佳 |
| factor\|theme_continuity_score\|above60\|3d\|100% | 361.0% | -20.3% | 63 | 1.00 | 333.8% | 未超过单仓鲁棒最佳 |
| factor\|theme_continuity_score\|above120\|3d\|100% | 361.0% | -20.3% | 63 | 1.00 | 333.8% | 未超过单仓鲁棒最佳 |
| factor\|fresh_mainline_score\|above60\|3d\|100% | 330.4% | -29.8% | 89 | 1.00 | 266.5% | 未超过单仓鲁棒最佳 |
| factor\|fresh_mainline_score\|above120\|3d\|100% | 330.4% | -29.8% | 89 | 1.00 | 266.5% | 未超过单仓鲁棒最佳 |
| factor\|theme_continuity_score\|above120\|5d\|100% | 324.1% | -22.6% | 47 | 1.00 | 308.2% | 未超过单仓鲁棒最佳 |
| factor\|theme_continuity_score\|above60\|5d\|100% | 306.8% | -22.6% | 49 | 1.00 | 292.2% | 未超过单仓鲁棒最佳 |
| factor\|trend_top20_persist\|above60\|10d\|100% | 293.9% | -26.5% | 49 | 1.00 | 263.8% | 未超过单仓鲁棒最佳 |
| factor\|trend_top20_persist\|above120\|10d\|100% | 293.9% | -26.5% | 49 | 1.00 | 263.8% | 未超过单仓鲁棒最佳 |
| factor\|theme_continuity_score\|above60\|10d\|100% | 293.0% | -22.3% | 35 | 1.00 | 258.6% | 未超过单仓鲁棒最佳 |
| factor\|theme_continuity_score\|above120\|10d\|100% | 293.0% | -22.3% | 35 | 1.00 | 258.6% | 未超过单仓鲁棒最佳 |
| factor\|mainline_persist_score\|above60\|10d\|100% | 275.6% | -23.4% | 39 | 1.00 | 213.6% | 未超过单仓鲁棒最佳 |
| factor\|mainline_persist_score\|above120\|10d\|100% | 275.6% | -23.4% | 39 | 1.00 | 213.6% | 未超过单仓鲁棒最佳 |
| factor\|mainline_persist_score\|above60\|10d\|90%/10% | 273.0% | -19.3% | 68 | 2.00 | 255.8% | 未超过单仓鲁棒最佳 |
| factor\|mainline_persist_score\|above120\|10d\|90%/10% | 273.0% | -19.3% | 68 | 2.00 | 255.8% | 未超过单仓鲁棒最佳 |

## 横截面排名专项

| 策略 | 收益 | 最大回撤 | 交易 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---|
| factor\|tq_rank_pct\|above60\|3d\|100% | 562.9% | -21.6% | 67 | 1.00 | 472.5% | 未超过单仓鲁棒最佳 |
| factor\|tq_rank_pct\|above120\|3d\|100% | 562.9% | -21.6% | 67 | 1.00 | 472.5% | 未超过单仓鲁棒最佳 |
| factor\|rank_quality_score\|above60\|3d\|100% | 507.4% | -23.6% | 71 | 1.00 | 430.9% | 未超过单仓鲁棒最佳 |
| factor\|rank_quality_score\|above120\|3d\|100% | 507.4% | -23.6% | 71 | 1.00 | 430.9% | 未超过单仓鲁棒最佳 |
| factor\|width_rank_pct\|above60\|3d\|100% | 492.2% | -20.0% | 141 | 1.00 | 276.7% | 未超过单仓鲁棒最佳 |
| factor\|width_rank_pct\|above120\|3d\|100% | 492.2% | -20.0% | 141 | 1.00 | 276.7% | 未超过单仓鲁棒最佳 |
| factor\|theme_rank_pct\|above60\|3d\|100% | 492.2% | -20.0% | 141 | 1.00 | 276.7% | 未超过单仓鲁棒最佳 |
| factor\|theme_rank_pct\|above120\|3d\|100% | 480.0% | -20.0% | 141 | 1.00 | 268.3% | 未超过单仓鲁棒最佳 |
| factor\|cross_rank_blend\|above60\|3d\|100% | 399.5% | -21.4% | 105 | 1.00 | 286.5% | 未超过单仓鲁棒最佳 |
| factor\|cross_rank_blend\|above120\|3d\|100% | 399.5% | -21.4% | 105 | 1.00 | 286.5% | 未超过单仓鲁棒最佳 |
| factor\|tq_rank_pct\|above120\|5d\|100% | 376.6% | -21.0% | 51 | 1.00 | 312.1% | 未超过单仓鲁棒最佳 |
| factor\|rank_quality_score\|above60\|5d\|100% | 376.6% | -21.0% | 51 | 1.00 | 312.1% | 未超过单仓鲁棒最佳 |
| factor\|rank_quality_score\|above120\|5d\|100% | 376.6% | -21.0% | 51 | 1.00 | 312.1% | 未超过单仓鲁棒最佳 |
| factor\|tq_rank_pct\|above60\|5d\|100% | 357.0% | -21.0% | 51 | 1.00 | 306.7% | 未超过单仓鲁棒最佳 |
| factor\|width_rank_pct\|above60\|5d\|100% | 347.6% | -22.5% | 99 | 1.00 | 307.2% | 未超过单仓鲁棒最佳 |
| factor\|width_rank_pct\|above120\|5d\|100% | 347.6% | -22.5% | 99 | 1.00 | 307.2% | 未超过单仓鲁棒最佳 |
| factor\|theme_rank_pct\|above60\|5d\|100% | 347.6% | -22.5% | 99 | 1.00 | 307.2% | 未超过单仓鲁棒最佳 |
| factor\|theme_rank_pct\|above120\|5d\|100% | 347.6% | -22.5% | 99 | 1.00 | 307.2% | 未超过单仓鲁棒最佳 |

## 多主线 Runner 专项

| 策略 | 收益 | 最大回撤 | 交易 | 最大持仓 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---:|---|
| runner\|multi_mom_quality_score\|above120\|5d\|base | 167.9% | -18.9% | 45 | 3 | 2.89 | 158.5% | 未超过单仓鲁棒最佳 |
| runner\|mainline_expansion_score\|above60\|3d\|base | 150.2% | -19.8% | 49 | 3 | 2.94 | 152.5% | 未超过单仓鲁棒最佳 |
| runner\|volume_price_absorption_score\|above60\|3d\|base | 149.9% | -17.9% | 47 | 3 | 2.94 | 136.6% | 未超过单仓鲁棒最佳 |
| runner\|balanced_momentum_score\|above60\|3d\|tight | 149.3% | -16.6% | 57 | 3 | 2.89 | 119.9% | 未超过单仓鲁棒最佳 |
| runner\|mainline_expansion_score\|above120\|3d\|base | 147.7% | -19.6% | 47 | 3 | 2.94 | 144.6% | 未超过单仓鲁棒最佳 |
| runner\|multi_mom_quality_score\|above120\|3d\|base | 144.3% | -18.5% | 49 | 3 | 2.94 | 128.4% | 未超过单仓鲁棒最佳 |
| runner\|volume_price_absorption_score\|above60\|3d\|loose | 144.0% | -17.9% | 45 | 3 | 2.94 | 137.7% | 未超过单仓鲁棒最佳 |
| runner\|rank_quality_score\|above60\|3d\|tight | 143.8% | -16.6% | 65 | 3 | 2.88 | 105.2% | 未超过单仓鲁棒最佳 |
| runner\|rank_ensemble_score\|above60\|3d\|tight | 143.8% | -16.6% | 65 | 3 | 2.88 | 105.2% | 未超过单仓鲁棒最佳 |
| runner\|mom30_theme_leader\|above60\|3d\|tight | 143.8% | -16.6% | 65 | 3 | 2.88 | 105.2% | 未超过单仓鲁棒最佳 |
| runner\|new_high_persistence_score\|above60\|3d\|tight | 142.9% | -16.2% | 61 | 3 | 2.89 | 116.8% | 未超过单仓鲁棒最佳 |
| runner\|regression_trend_score\|above120\|3d\|tight | 141.8% | -14.5% | 67 | 3 | 2.89 | 112.4% | 未超过单仓鲁棒最佳 |
| runner\|mom30_theme_power\|above60\|3d\|tight | 139.3% | -16.6% | 71 | 3 | 2.87 | 105.5% | 未超过单仓鲁棒最佳 |
| runner\|vcp_breakout_score\|above60\|3d\|tight | 139.2% | -15.5% | 59 | 3 | 2.89 | 111.0% | 未超过单仓鲁棒最佳 |
| runner\|regression_mainline_score\|above120\|5d\|base | 139.0% | -16.6% | 43 | 3 | 2.89 | 141.4% | 未超过单仓鲁棒最佳 |
| runner\|mom30_width_stable\|above60\|3d\|tight | 138.8% | -16.6% | 67 | 3 | 2.86 | 103.7% | 未超过单仓鲁棒最佳 |
| runner\|mom30_width_blend\|above60\|3d\|tight | 138.8% | -16.6% | 67 | 3 | 2.86 | 103.7% | 未超过单仓鲁棒最佳 |
| runner\|multi_mom_quality_score\|above120\|10d\|base | 138.1% | -16.4% | 41 | 3 | 2.81 | 132.8% | 未超过单仓鲁棒最佳 |

## 主线大类 Runner 专项

| 策略 | 收益 | 最大回撤 | 交易 | 最大持仓 | 均仓 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---:|---:|---|
| runner-mainline\|multi_mom_quality_score\|above120\|5d\|base | 156.1% | -18.7% | 47 | 3 | 2.88 | 149.7% | 低于原Runner |
| runner-mainline\|multi_mom_quality_score\|above120\|10d\|base | 156.0% | -16.8% | 43 | 3 | 2.80 | 159.7% | 低于原Runner |
| runner-mainline\|fresh_mainline_score\|above60\|3d\|tight | 149.1% | -14.2% | 67 | 3 | 2.87 | 107.8% | 低于原Runner |
| runner-mainline\|theme_rank_pct\|above120\|3d\|loose | 141.7% | -17.9% | 43 | 3 | 2.94 | 134.6% | 低于原Runner |
| runner-mainline\|mainline_expansion_score\|above60\|3d\|base | 139.7% | -18.1% | 47 | 3 | 2.94 | 140.4% | 低于原Runner |
| runner-mainline\|balanced_momentum_score\|above120\|3d\|tight | 139.4% | -18.8% | 57 | 3 | 2.91 | 111.9% | 低于原Runner |
| runner-mainline\|mom30_theme_leader\|above60\|3d\|tight | 139.4% | -17.2% | 63 | 3 | 2.88 | 113.0% | 低于原Runner |
| runner-mainline\|mainline_expansion_score\|above120\|3d\|base | 137.4% | -18.1% | 45 | 3 | 2.95 | 134.6% | 低于原Runner |
| runner-mainline\|theme_width\|above120\|3d\|loose | 137.3% | -17.9% | 41 | 3 | 2.95 | 132.3% | 低于原Runner |
| runner-mainline\|rank_quality_score\|above60\|3d\|tight | 135.0% | -17.2% | 65 | 3 | 2.88 | 111.7% | 低于原Runner |
| runner-mainline\|alpha_trend_quality\|above60\|3d\|tight | 133.3% | -17.1% | 63 | 3 | 2.88 | 118.2% | 低于原Runner |
| runner-mainline\|balanced_momentum_score\|above120\|5d\|tight | 130.6% | -15.8% | 55 | 3 | 2.83 | 111.6% | 低于原Runner |
| runner-mainline\|alpha_trend_quality\|above120\|10d\|base | 129.8% | -19.0% | 41 | 3 | 2.84 | 134.0% | 低于原Runner |
| runner-mainline\|mainline_expansion_score\|above60\|3d\|tight | 129.8% | -20.0% | 69 | 3 | 2.87 | 127.4% | 低于原Runner |
| runner-mainline\|mainline_expansion_score\|above60\|3d\|loose | 128.9% | -19.5% | 43 | 3 | 2.94 | 132.5% | 低于原Runner |
| runner-mainline\|fresh_mainline_score\|above120\|3d\|tight | 124.6% | -15.6% | 71 | 3 | 2.88 | 88.1% | 低于原Runner |
| runner-mainline\|multi_mom_quality_score\|above120\|3d\|base | 124.2% | -18.9% | 53 | 3 | 2.93 | 115.7% | 低于原Runner |
| runner-mainline\|multi_mom_quality_score\|above120\|5d\|loose | 123.9% | -21.7% | 39 | 3 | 2.92 | 128.2% | 低于原Runner |

## 成交额因子专项

| 策略 | 收益 | 最大回撤 | 交易 | 次开10bp收益 | 观察 |
|---|---:|---:|---:|---:|---|
| factor\|amount_cost_reclaim_score\|above60\|3d\|100% | 353.5% | -29.8% | 97 | 303.0% | 未超过鲁棒基准 |
| factor\|amount_cost_reclaim_score\|above120\|3d\|100% | 353.5% | -29.8% | 97 | 303.0% | 未超过鲁棒基准 |
| factor\|amount_cost_reclaim_score\|above120\|5d\|100% | 331.3% | -23.8% | 65 | 250.0% | 未超过鲁棒基准 |
| factor\|amount_cost_reclaim_score\|above60\|5d\|100% | 327.8% | -24.4% | 65 | 253.5% | 未超过鲁棒基准 |
| factor\|mom30_theme_amount\|above60\|3d\|100% | 293.2% | -29.9% | 109 | 321.9% | 未超过鲁棒基准 |
| factor\|amount_cost_reclaim_score\|above60\|10d\|100% | 287.7% | -30.9% | 49 | 197.2% | 未超过鲁棒基准 |
| factor\|amount_cost_reclaim_score\|above120\|10d\|100% | 287.7% | -30.9% | 49 | 197.2% | 未超过鲁棒基准 |
| factor\|mom30_theme_amount\|above120\|3d\|100% | 284.2% | -29.9% | 111 | 310.4% | 未超过鲁棒基准 |
| factor\|amount_price_dist60\|above60\|10d\|100% | 246.8% | -34.6% | 49 | 167.1% | 未超过鲁棒基准 |
| factor\|amount_price_dist60\|above120\|10d\|100% | 246.8% | -34.6% | 49 | 167.1% | 未超过鲁棒基准 |
| factor\|amount_cost_reclaim_score\|above120\|3d\|90%/10% | 226.8% | -19.4% | 178 | 225.8% | 未超过鲁棒基准 |
| factor\|amount_cost_reclaim_score\|above60\|3d\|90%/10% | 226.2% | -19.4% | 178 | 225.5% | 未超过鲁棒基准 |
| factor\|amount_price_dist60\|above120\|5d\|85%/10%/5% | 224.7% | -23.1% | 177 | 162.5% | 未超过鲁棒基准 |
| factor\|amount_price_dist60\|above60\|5d\|85%/10%/5% | 223.4% | -23.2% | 183 | 161.7% | 未超过鲁棒基准 |
| factor\|price_amount_power\|above120\|10d\|85%/10%/5% | 218.6% | -21.9% | 163 | 156.5% | 未超过鲁棒基准 |

## 次开10bp鲁棒榜

| 指标族 | 策略 | 次开10bp收益 | 最大回撤 | 交易 | 收盘收益 |
|---|---|---:|---:|---:|---:|
| K线结构 | factor\|gap_momentum_score\|above60\|3d\|100% | 473.0% | -21.5% | 65 | 559.3% |
| K线结构 | factor\|gap_momentum_score\|above120\|3d\|100% | 473.0% | -21.5% | 65 | 559.3% |
| 技术指标 | factor\|pvt_confirm_score\|above60\|3d\|100% | 473.0% | -21.5% | 65 | 559.3% |
| 技术指标 | factor\|pvt_confirm_score\|above120\|3d\|100% | 473.0% | -21.5% | 65 | 559.3% |
| 趋势寿命 | factor\|anti_exhaustion_score\|above60\|3d\|100% | 473.0% | -21.5% | 67 | 564.8% |
| 趋势寿命 | factor\|anti_exhaustion_score\|above120\|3d\|100% | 473.0% | -21.5% | 67 | 564.8% |
| 复合主线 | factor\|mom30_trend_quality_smooth\|above60\|3d\|100% | 472.5% | -21.5% | 67 | 562.9% |
| 复合主线 | factor\|mom30_trend_quality_smooth\|above120\|3d\|100% | 472.5% | -21.5% | 67 | 562.9% |
| 横截面排名 | factor\|tq_rank_pct\|above60\|3d\|100% | 472.5% | -21.5% | 67 | 562.9% |
| 横截面排名 | factor\|tq_rank_pct\|above120\|3d\|100% | 472.5% | -21.5% | 67 | 562.9% |
| 集成/风控 | factor\|ensemble_risk_adjusted_score\|above60\|3d\|100% | 465.3% | -21.7% | 67 | 540.1% |
| 集成/风控 | factor\|ensemble_risk_adjusted_score\|above120\|3d\|100% | 465.3% | -21.7% | 67 | 540.1% |
| 尾部风险 | factor\|downside_control_score\|above60\|3d\|100% | 464.6% | -21.7% | 67 | 511.1% |
| 尾部风险 | factor\|downside_control_score\|above120\|3d\|100% | 464.6% | -21.7% | 67 | 511.1% |
| 多周期一致性 | factor\|balanced_momentum_score\|above60\|3d\|100% | 461.0% | -22.9% | 65 | 536.9% |

## 候选复核

| 策略 | 收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 全段-候选 | 564.8% | 209.2% | 265.0% | -21.6% | 67 | 1.00 | 357 | 1 |
| 2025-候选 | 200.0% | 119.7% | 201.4% | -18.8% | 49 | 1.00 | 243 | 1 |
| 2026-候选 | 117.0% | 87.4% | 424.8% | -21.6% | 19 | 1.00 | 114 | 1 |

## 成交/成本敏感性

| 策略 | 成交口径 | 单边成本 | 收益 | 年化 | 最大回撤 | 交易 | 均仓 |
|---|---|---:|---:|---:|---:|---:|---:|
| 候选-收盘-0bp | close | 0bp | 564.8% | 265.0% | -21.6% | 67 | 1.00 |
| 候选-次开-0bp | nextopen | 0bp | 512.8% | 245.2% | -21.4% | 67 | 1.00 |
| 候选-收盘-5bp | close | 5bp | 542.9% | 256.7% | -21.9% | 67 | 1.00 |
| 候选-次开-5bp | nextopen | 5bp | 492.6% | 237.4% | -21.4% | 67 | 1.00 |
| 候选-次开-10bp | nextopen | 10bp | 473.0% | 229.8% | -21.5% | 67 | 1.00 |

## 主线标的捕捉

| 代码 | 标的 | 主题 | 交易次数 | 组合贡献 |
|---|---|---|---:|---:|
| 159567 | 港股创新药 | 港股创新药 | 2 | -7.1% |
| 513120 | 港股创新药(广发) | 港股创新药 | 1 | +24.8% |
| 515880 | 通信 | 通信 | 2 | +121.4% |
| 159695 | 通信(嘉实) | 通信 | 0 | +0.0% |
| 513310 | 中韩半导体 | 中韩半导体 | 6 | +51.8% |
| 588200 | 科创芯片 | 科创芯片 | 0 | +0.0% |
| 159516 | 半导体设备 | 半导体设备 | 1 | +141.9% |
| 501225 | 全球芯片 | 全球芯片 | 1 | +125.8% |
| 159206 | 卫星 | 军工航天 | 1 | +110.2% |

## 收益集中度

| 主题 | 涉及标的 | 交易次数 | 胜率 | 组合贡献 |
|---|---|---:|---:|---:|
| 半导体设备 | 159516 半导体设备 | 1 | 100% | +141.9% |
| 全球芯片 | 501225 全球芯片 | 1 | 100% | +125.8% |
| 通信 | 515880 通信 | 2 | 100% | +121.4% |
| 军工航天 | 159206 卫星 | 1 | 100% | +110.2% |
| 中韩半导体 | 513310 中韩半导体 | 6 | 50% | +51.8% |
| 金融 | 159887 银行、513090 香港证券 | 2 | 50% | +21.0% |
| 港股创新药 | 159567 港股创新药、513120 港股创新药(广发) | 3 | 33% | +17.7% |
| 恒生科技 | 159740 恒生科技 | 4 | 50% | +9.1% |
| 信创软件 | 560850 信创(汇添富) | 3 | 33% | +7.2% |
| 化工 | 516120 化工(富国) | 1 | 100% | +2.8% |
| 人工智能 | 159363 创业板人工智能 | 1 | 100% | +1.8% |
| 美股科技 | 159509 纳指科技、159632 纳斯达克、161128 标普信息科技 | 3 | 33% | -0.7% |
