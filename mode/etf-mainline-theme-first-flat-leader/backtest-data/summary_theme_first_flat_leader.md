# 主题优先非复利主线龙头探索摘要

- 回测区间: 2025-01-02 至 2026-06-26
- ETF池: 55 只
- 扫描组合: 14580
- 最大持仓: 1；先选主题，再选主题内代表 ETF，同主题重复持仓天然为 0。
- 推荐候选: `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10|members>=1|4d|min8|themeTop3|pg15%|dd6%|exit=ma120`
- 全段收益: 复利 `729.2%` / 非复利 `232.5%`；最大回撤 `-19.2%`；交易 `54`；持仓占比 `0.99`。
- 执行口径: 次开 10bp 复利 `611.8%` / 非复利 `217.3%`。
- 交易记录: `trades_theme_first_flat_leader.md`

## 候选复核

| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 主题优先非复利主线龙头-全段 | 729.2% | 232.5% | 324.5% | -19.2% | 54 | 0.99 | 5 | 1 |

## Top 候选

| 排名 | flatReturn | 次开10bp flatReturn | 复利收益 | 最大回撤 | 持仓占比 | 交易 | 分段flatReturn | 主题规则 | 回放规则 |
|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| 1 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10|members>=1` | `4d|min8|themeTop3|pg15%|dd6%|exit=ma120` |
| 2 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10|members>=1` | `4d|min8|themeTop2|pg15%|dd6%|exit=ma120` |
| 3 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10|members>=1` | `4d|min8|themeTop1|pg15%|dd6%|exit=ma120` |
| 4 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10|members>=1` | `4d|min6|themeTop3|pg15%|dd6%|exit=ma120` |
| 5 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10|members>=1` | `4d|min6|themeTop2|pg15%|dd6%|exit=ma120` |
| 6 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=0.10|members>=1` | `4d|min6|themeTop1|pg15%|dd6%|exit=ma120` |
| 7 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=-9.00|members>=1` | `4d|min8|themeTop3|pg15%|dd6%|exit=ma120` |
| 8 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=-9.00|members>=1` | `4d|min8|themeTop2|pg15%|dd6%|exit=ma120` |
| 9 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=-9.00|members>=1` | `4d|min8|themeTop1|pg15%|dd6%|exit=ma120` |
| 10 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=-9.00|members>=1` | `4d|min6|themeTop3|pg15%|dd6%|exit=ma120` |
| 11 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=-9.00|members>=1` | `4d|min6|themeTop2|pg15%|dd6%|exit=ma120` |
| 12 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.50|theme_amount_power>=-9.00|members>=1` | `4d|min6|themeTop1|pg15%|dd6%|exit=ma120` |
| 13 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=0.10|members>=1` | `4d|min8|themeTop3|pg15%|dd6%|exit=ma120` |
| 14 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=0.10|members>=1` | `4d|min8|themeTop2|pg15%|dd6%|exit=ma120` |
| 15 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=0.10|members>=1` | `4d|min8|themeTop1|pg15%|dd6%|exit=ma120` |
| 16 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=0.10|members>=1` | `4d|min6|themeTop3|pg15%|dd6%|exit=ma120` |
| 17 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=0.10|members>=1` | `4d|min6|themeTop2|pg15%|dd6%|exit=ma120` |
| 18 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=0.10|members>=1` | `4d|min6|themeTop1|pg15%|dd6%|exit=ma120` |
| 19 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=-9.00|members>=1` | `4d|min8|themeTop3|pg15%|dd6%|exit=ma120` |
| 20 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=-9.00|members>=1` | `4d|min8|themeTop2|pg15%|dd6%|exit=ma120` |
| 21 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=-9.00|members>=1` | `4d|min8|themeTop1|pg15%|dd6%|exit=ma120` |
| 22 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=-9.00|members>=1` | `4d|min6|themeTop3|pg15%|dd6%|exit=ma120` |
| 23 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=-9.00|members>=1` | `4d|min6|themeTop2|pg15%|dd6%|exit=ma120` |
| 24 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.40|theme_amount_power>=-9.00|members>=1` | `4d|min6|themeTop1|pg15%|dd6%|exit=ma120` |
| 25 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=0.10|members>=1` | `4d|min8|themeTop3|pg15%|dd6%|exit=ma120` |
| 26 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=0.10|members>=1` | `4d|min8|themeTop2|pg15%|dd6%|exit=ma120` |
| 27 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=0.10|members>=1` | `4d|min8|themeTop1|pg15%|dd6%|exit=ma120` |
| 28 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=0.10|members>=1` | `4d|min6|themeTop3|pg15%|dd6%|exit=ma120` |
| 29 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=0.10|members>=1` | `4d|min6|themeTop2|pg15%|dd6%|exit=ma120` |
| 30 | 232.5% | 217.3% | 729.2% | -19.2% | 0.99 | 54 | 2025H1 42.1% / 2025H2 87.4% / 2026H1 79.1% | `theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15|theme_breadth_above120>=0.30|theme_amount_power>=0.10|members>=1` | `4d|min6|themeTop1|pg15%|dd6%|exit=ma120` |

## 分段复核

| 区间 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 |
|---|---:|---:|---:|---:|---:|---:|
| 2025H1 | 46.0% | 42.1% | -19.2% | 18 | 41.0% | 38.7% |
| 2025H2 | 125.2% | 87.4% | -16.0% | 20 | 126.7% | 88.2% |
| 2026H1 | 100.5% | 79.1% | -27.0% | 22 | 97.8% | 77.9% |

## 结论

主题优先模式未超过当前 breadth-confirmed 基准。它解决了主题先行和同主题代表 ETF 的表达问题，但收益路径仍低于单 ETF 价格强度优先模式。
