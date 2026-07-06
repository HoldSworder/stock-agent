# 同主题代表稳定非复利主线龙头回测摘要

- 回测区间: 2025-01-02 至 2026-06-26
- ETF池: 55 只
- 扫描组合: 34992
- 最大持仓: 1；同一时间不会重复持有同主题 ETF。
- 推荐候选: `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10`
- 机制: 跨主题仍按强者替换；同主题内只有新代表强度显著高于当前持仓时才切换。
- 全段收益: 复利 `747.8%` / 非复利 `234.9%`；最大回撤 `-19.2%`；交易 `56`；持仓占比 `0.99`。
- 执行口径: 次开 10bp 复利 `639.0%` / 非复利 `221.2%`。
- 交易记录: `trades_family_stable_flat_leader.md`

## 候选复核

| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 同主题代表稳定非复利主线龙头-全段 | 747.8% | 234.9% | 331.0% | -19.2% | 56 | 0.99 | 5 | 1 |

## Top 候选

| 排名 | flatReturn | 次开10bp flatReturn | 复利收益 | 最大回撤 | 持仓占比 | 交易 | 分段flatReturn | 配置 |
|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10` |
| 2 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=-9.00` |
| 3 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=0.10` |
| 4 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=-9.00` |
| 5 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=0.10` |
| 6 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=-9.00` |
| 7 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10` |
| 8 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=-9.00` |
| 9 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=0.10` |
| 10 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=-9.00` |
| 11 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=0.10` |
| 12 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=-9.00` |
| 13 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop2|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10` |
| 14 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop2|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=-9.00` |
| 15 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop2|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=0.10` |
| 16 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop2|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=-9.00` |
| 17 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop2|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=0.10` |
| 18 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.16|top1|famTop2|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=-9.00` |
| 19 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10` |
| 20 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=-9.00` |
| 21 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=0.10` |
| 22 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=-9.00` |
| 23 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=0.10` |
| 24 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop4|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=-9.00` |
| 25 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10` |
| 26 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=-9.00` |
| 27 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=0.10` |
| 28 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=-9.00` |
| 29 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=0.10` |
| 30 | 234.9% | 221.2% | 747.8% | -19.2% | 0.99 | 56 | 2025H1 46.0% / 2025H2 73.4% / 2026H1 79.1% | `family-stable|anti_exhaustion_score|4d|min8|sw0.02|famSw0.12|top1|famTop3|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=-9.00` |

## 分段复核

| 区间 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 |
|---|---:|---:|---:|---:|---:|---:|
| 2025H1 | 51.7% | 46.0% | -19.2% | 18 | 44.0% | 40.9% |
| 2025H2 | 96.2% | 73.4% | -16.0% | 20 | 99.5% | 75.2% |
| 2026H1 | 100.5% | 79.1% | -27.0% | 22 | 97.8% | 77.9% |

## 结论

同主题代表稳定规则未超过当前 breadth-confirmed 基准。它减少同主题内切换噪音，但牺牲了部分单 ETF 龙头敏捷性。
