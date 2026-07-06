# 高持续主线非复利龙头回测摘要

- 回测区间: 2025-01-02 至 2026-06-26
- ETF池: 55 只
- 最大持仓: 1（满足最大持仓不超过 3）；同主题重复持仓天然为 0。
- 推荐配置: `high-persist-flat|anti_exhaustion_score|above60|3d|min4|sw0.01|top2|pg25%|dd8%|mainline_persist>=0.15`
- 机制: 候选需 `mainline_persist >= 0.15`；每 3 个交易日复核；最小持有 4 个交易日；新标的分数至少高出 0.01 才触发强者替换；持仓跌出 Top2、跌破 MA120、或单笔浮盈超过 25% 后从峰值回撤 8% 时退出。
- 全段收益: 复利 `764.0%` / 非复利(等权) `236.5%`；最大回撤 `-23.6%`；交易 `49`；交易记录 `trades_high_persist_flat_leader.md`。
- 执行口径: 次开 10bp 复利 `744.6%` / 非复利 `234.6%`。
- 说明: 本轮排序以次开10bp非复利收益为准。该模式高于上一版主线确认盈利保护黏性龙头的收盘非复利 `223.1%` 与次开10bp非复利 `214.8%`。

## 候选复核

| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 高持续主线非复利龙头-全段 | 764.0% | 236.5% | 336.6% | -23.6% | 49 | 0.99 | 4 | 1 |

## 参数对照（按次开10bp非复利收益排序）

| 策略 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 | 备注 |
|---|---:|---:|---:|---:|---:|---:|---|
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.01\|top2\|pg20%\|dd8%\|mainline_persist>=0.15 | 764.0% | 236.5% | -23.6% | 49 | 744.6% | 234.6% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.01\|top2\|pg25%\|dd8%\|mainline_persist>=0.15 | 764.0% | 236.5% | -23.6% | 49 | 744.6% | 234.6% | 推荐 |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.01\|top2\|pg20%\|dd8%\|mainline_persist>=0.15 | 764.0% | 236.5% | -23.6% | 49 | 744.6% | 234.6% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.01\|top2\|pg25%\|dd8%\|mainline_persist>=0.15 | 764.0% | 236.5% | -23.6% | 49 | 744.6% | 234.6% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.01\|top2\|pg40%\|dd12%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 47 | 691.8% | 228.0% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.01\|top2\|pg40%\|dd12%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 47 | 691.8% | 228.0% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.01\|top2\|pg30%\|dd10%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 49 | 690.2% | 227.8% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.01\|top2\|pg30%\|dd10%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 49 | 690.2% | 227.8% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.01\|top2\|pg15%\|dd6%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 51 | 688.6% | 227.5% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.01\|top2\|pg15%\|dd6%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 51 | 688.6% | 227.5% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.02\|top2\|pg20%\|dd8%\|mainline_persist>=0.15 | 703.7% | 229.3% | -23.6% | 45 | 677.2% | 226.3% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.02\|top2\|pg25%\|dd8%\|mainline_persist>=0.15 | 703.7% | 229.3% | -23.6% | 45 | 677.2% | 226.3% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.02\|top2\|pg20%\|dd8%\|mainline_persist>=0.15 | 703.7% | 229.3% | -23.6% | 45 | 677.2% | 226.3% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.02\|top2\|pg25%\|dd8%\|mainline_persist>=0.15 | 703.7% | 229.3% | -23.6% | 45 | 677.2% | 226.3% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.035\|top2\|pg25%\|dd8%\|mainline_persist>=0.15 | 662.4% | 224.6% | -28.8% | 41 | 655.4% | 223.8% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.035\|top2\|pg25%\|dd8%\|mainline_persist>=0.15 | 662.4% | 224.6% | -28.8% | 41 | 655.4% | 223.8% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.02\|top2\|pg40%\|dd12%\|mainline_persist>=0.15 | 663.7% | 224.0% | -23.6% | 43 | 628.6% | 219.7% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.02\|top2\|pg40%\|dd12%\|mainline_persist>=0.15 | 663.7% | 224.0% | -23.6% | 43 | 628.6% | 219.7% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.02\|top2\|pg30%\|dd10%\|mainline_persist>=0.15 | 663.7% | 224.0% | -23.6% | 45 | 627.1% | 219.4% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.02\|top2\|pg30%\|dd10%\|mainline_persist>=0.15 | 663.7% | 224.0% | -23.6% | 45 | 627.1% | 219.4% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.02\|top2\|pg15%\|dd6%\|mainline_persist>=0.15 | 663.7% | 224.0% | -23.6% | 47 | 625.7% | 219.2% |  |
| high-persist-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.02\|top2\|pg15%\|dd6%\|mainline_persist>=0.15 | 663.7% | 224.0% | -23.6% | 47 | 625.7% | 219.2% |  |

## 分段复核

| 区间 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 |
|---|---:|---:|---:|---:|---:|---:|
| 2025H1 | 42.5% | 39.6% | -19.2% | 17 | 35.2% | 34.5% |
| 2025H2 | 149.5% | 97.8% | -16.6% | 15 | 152.0% | 98.7% |
| 2026H1 | 131.2% | 94.1% | -23.6% | 17 | 139.9% | 98.3% |

## 成交/成本敏感性

| 口径 | 收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 |
|---|---:|---:|---:|---:|---:|---:|
| 收盘0bp | 764.0% | 236.5% | 336.6% | -23.6% | 49 | 0.99 |
| 次开0bp | 788.0% | 239.5% | 344.8% | -21.4% | 49 | 0.99 |
| 收盘5bp | 742.6% | 234.1% | 329.2% | -23.7% | 49 | 0.99 |
| 次开5bp | 766.0% | 237.0% | 337.3% | -21.5% | 49 | 0.99 |
| 次开10bp | 744.6% | 234.6% | 329.9% | -21.7% | 49 | 0.99 |

## 收益集中度

| 主题 | 涉及标的 | 交易次数 | 胜率 | 组合贡献 |
|---|---|---:|---:|---:|
| 全球芯片 | 501225 全球芯片 | 2 | 100% | +221.6% |
| 半导体设备 | 159516 半导体设备 | 1 | 100% | +184.4% |
| 通信 | 515880 通信 | 2 | 100% | +140.6% |
| 军工航天 | 159206 卫星 | 2 | 100% | +134.4% |
| 港股创新药 | 159567 港股创新药、513120 港股创新药(广发) | 3 | 67% | +27.8% |
| 金融 | 513090 香港证券 | 1 | 100% | +23.9% |
| 人工智能 | 159363 创业板人工智能 | 1 | 100% | +23.1% |
| 恒生科技 | 159740 恒生科技 | 2 | 50% | +18.4% |
| 美股科技 | 159509 纳指科技 | 1 | 100% | +6.6% |
| 电池储能 | 561910 电池 | 1 | 100% | +3.0% |
| 科创芯片 | 588200 科创芯片 | 1 | 100% | +0.9% |
| 信创软件 | 560850 信创(汇添富) | 1 | 100% | +0.3% |
| 芯片宽泛 | 159995 芯片 | 1 | 100% | +0.1% |
| 中韩半导体 | 513310 中韩半导体 | 3 | 33% | -10.5% |
| 能源资源 | 518880 黄金、561360 石油 | 3 | 67% | -10.6% |

## 结论

本模式在非复利收益口径上超过上一版最佳模式。优势来自更严格的主线持续性确认和更敏捷的强者替换；邻近参数中 `sw0.01~0.02`、`min4~6`、`pg20%~25%/dd8%` 均高于现有非复利基准。风险是 `mainline_persist >= 0.15` 会推迟早期主线捕捉，因此应继续前向观察。
