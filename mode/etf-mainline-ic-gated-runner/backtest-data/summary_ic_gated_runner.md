# IC 过滤主线 Runner 回测摘要

- 回测区间: 2025-01-02 至 2026-06-26
- ETF池: 55 只
- 最大持仓: 3；Runner 同细主题最多 1 只；主线大类 Runner 同一大主线最多 1 只。
- 组合 Runner 基准: 原 `multi_mom_quality_score` Runner `+167.9%`；主线大类 Runner 基准 `+156.0%`；单仓短周期冲刺基准 `+468.3%`。
- IC过滤 Runner 最佳: `ic-runner|ic_tq_gate_score|above60|3d|tight`，收益 复利 `145.3%` / 非复利 `94.9%`，次开10bp `128.0%`，交易记录 `trades_ic_gated_runner_best.md`。
- IC过滤主线大类 Runner 最佳: `ic-mainline|ic_tq_gate_score|above60|3d|tight`，收益 复利 `148.7%` / 非复利 `96.8%`，次开10bp `114.0%`，交易记录 `trades_ic_gated_mainline_best.md`。
- 说明: 复利收益受后期权益基数放大,后几笔大行情会主导 headline;非复利收益等权每段,用于横向评估时去除该路径依赖偏差。本模式 Top 排名已改用非复利收益。

## Top20

| 模式 | 策略 | 复利收益 | 非复利收益 | 最大回撤 | 交易 | 最大持仓 | 均仓 | 次开10bp收益 | 对组合基准 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 主线大类 | ic-mainline\|ic_tq_gate_score\|above60\|3d\|tight | 148.7% | 96.8% | -17.2% | 67 | 3 | 2.88 | 114.0% | 低于基准 |
| 细主题 | ic-runner\|ic_tq_gate_score\|above60\|3d\|tight | 145.3% | 94.9% | -16.6% | 65 | 3 | 2.88 | 128.0% | 低于基准 |
| 细主题 | ic-runner\|ic_crowding_control_score\|above60\|3d\|tight | 143.7% | 94.2% | -15.6% | 65 | 3 | 2.87 | 116.4% | 低于基准 |
| 主线大类 | ic-mainline\|ic_crowding_control_score\|above60\|3d\|tight | 137.9% | 92.3% | -14.7% | 67 | 3 | 2.88 | 110.8% | 低于基准 |
| 主线大类 | ic-mainline\|ic_crowding_control_score\|above60\|3d\|base | 136.9% | 93.1% | -18.1% | 51 | 3 | 2.94 | 137.6% | 低于基准 |
| 细主题 | ic-runner\|ic_width_rank_score\|above60\|3d\|tight | 138.8% | 92.4% | -16.6% | 67 | 3 | 2.86 | 103.7% | 低于基准 |
| 细主题 | ic-runner\|ic_crowding_control_score\|above60\|3d\|base | 132.8% | 91.5% | -17.5% | 49 | 3 | 2.93 | 117.1% | 低于基准 |
| 主线大类 | ic-mainline\|ic_crowding_control_score\|above120\|3d\|base | 126.8% | 89.7% | -18.2% | 49 | 3 | 2.94 | 124.0% | 低于基准 |
| 细主题 | ic-runner\|ic_crowding_control_score\|above120\|3d\|tight | 134.9% | 91.2% | -20.0% | 65 | 3 | 2.90 | 109.3% | 低于基准 |
| 主线大类 | ic-mainline\|ic_crowding_control_score\|above60\|3d\|loose | 129.1% | 89.8% | -19.5% | 47 | 3 | 2.94 | 131.9% | 低于基准 |
| 细主题 | ic-runner\|ic_tq_gate_score\|above120\|3d\|tight | 134.1% | 90.7% | -20.2% | 67 | 3 | 2.89 | 114.1% | 低于基准 |
| 细主题 | ic-runner\|ic_crowding_control_score\|above120\|3d\|base | 123.0% | 88.1% | -17.5% | 47 | 3 | 2.94 | 105.1% | 低于基准 |
| 细主题 | ic-runner\|ic_mainline_expand_score\|above60\|3d\|tight | 129.8% | 88.6% | -18.6% | 67 | 3 | 2.87 | 107.2% | 低于基准 |
| 细主题 | ic-runner\|ic_width_rank_score\|above120\|3d\|tight | 126.0% | 86.7% | -16.5% | 67 | 3 | 2.87 | 91.2% | 低于基准 |
| 细主题 | ic-runner\|ic_crowding_control_score\|above120\|10d\|base | 121.5% | 87.0% | -18.4% | 41 | 3 | 2.83 | 112.6% | 低于基准 |
| 细主题 | ic-runner\|ic_crowding_control_score\|above60\|3d\|loose | 123.8% | 87.4% | -19.2% | 47 | 3 | 2.93 | 128.2% | 低于基准 |
| 细主题 | ic-runner\|ic_mainline_expand_score\|above120\|5d\|tight | 126.0% | 86.7% | -19.2% | 59 | 3 | 2.83 | 97.8% | 低于基准 |
| 主线大类 | ic-mainline\|ic_tq_gate_score\|above120\|3d\|tight | 127.9% | 88.4% | -22.0% | 71 | 3 | 2.90 | 92.5% | 低于基准 |
| 细主题 | ic-runner\|ic_crowding_control_score\|above120\|3d\|loose | 118.0% | 85.1% | -19.2% | 41 | 3 | 2.95 | 119.0% | 低于基准 |
| 细主题 | ic-runner\|ic_tq_gate_score\|above120\|5d\|tight | 119.6% | 83.7% | -16.5% | 59 | 3 | 2.82 | 101.2% | 低于基准 |

## 成交/成本敏感性

| 策略 | 成交口径 | 单边成本 | 收益 | 最大回撤 | 交易 | 均仓 |
|---|---|---:|---:|---:|---:|---:|
| IC过滤Runner-收盘0bp | close | 0bp | 145.3% | -16.6% | 65 | 2.88 |
| IC过滤Runner-次开10bp | nextopen | 10bp | 128.0% | -17.3% | 63 | 2.88 |
| IC过滤主线-收盘0bp | close | 0bp | 148.7% | -17.2% | 67 | 2.88 |
| IC过滤主线-次开10bp | nextopen | 10bp | 114.0% | -17.8% | 69 | 2.87 |

## 结论

本轮 IC 过滤 Runner 未高于对应组合基准，说明高 IC 因子更适合作为解释/过滤项，暂不替代原 Runner。
所有结果均保留次开 + 10bp 口径，避免只看收盘理想成交。
