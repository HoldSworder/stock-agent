# 敏捷止盈非复利主线龙头回测摘要

- 回测区间: 2025-01-02 至 2026-06-26
- ETF池: 55 只
- 最大持仓: 1（满足最大持仓不超过 3）；同主题重复持仓天然为 0。
- 推荐配置: `agile-profit-flat|anti_exhaustion_score|above60|4d|min6|sw0|top2|pg15%|dd6%|mainline_persist>=0.15`
- 机制: 候选需 `mainline_persist >= 0.15`；每 4 个交易日复核；最小持有 6 个交易日；更强候选出现即可替换；持仓跌出 Top2、跌破 MA120、或单笔浮盈超过 15% 后从峰值回撤 6% 时退出。
- 全段收益: 复利 `822.6%` / 非复利(等权) `243.5%`；最大回撤 `-19.2%`；交易 `57`；交易记录 `trades_agile_profit_flat_leader.md`。
- 执行口径: 次开 10bp 复利 `733.4%` / 非复利 `233.5%`。
- 说明: 本模式按系统展示的收盘口径 `flatReturn` 优先，收盘非复利高于 `高持续主线非复利龙头` 的 `236.5%`；但次开10bp非复利略低于其 `234.6%`，因此实盘执行需额外观察滑点。

## 候选复核

| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 敏捷止盈非复利主线龙头-全段 | 822.6% | 243.5% | 356.6% | -19.2% | 57 | 0.99 | 5 | 1 |

## 参数对照（按收盘非复利收益排序）

| 策略 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 | 备注 |
|---|---:|---:|---:|---:|---:|---:|---|
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0\|top1\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% | 推荐 |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0\|top3\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0\|top4\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0.01\|top1\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0.02\|top1\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0.035\|top1\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0\|top1\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0\|top3\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0\|top4\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0.01\|top1\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0.02\|top1\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0.035\|top1\|pg15%\|dd6%\|mainline_persist>=0.15 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.01\|top2\|pg20%\|dd8%\|mainline_persist>=0.15 | 764.0% | 236.5% | -23.6% | 49 | 744.6% | 234.6% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.01\|top2\|pg25%\|dd8%\|mainline_persist>=0.15 | 764.0% | 236.5% | -23.6% | 49 | 744.6% | 234.6% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.01\|top2\|pg20%\|dd8%\|mainline_persist>=0.15 | 764.0% | 236.5% | -23.6% | 49 | 744.6% | 234.6% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.01\|top2\|pg25%\|dd8%\|mainline_persist>=0.15 | 764.0% | 236.5% | -23.6% | 49 | 744.6% | 234.6% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.01\|top2\|pg30%\|dd10%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 49 | 690.2% | 227.8% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.01\|top3\|pg30%\|dd10%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 49 | 690.2% | 227.8% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0.01\|top4\|pg30%\|dd10%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 49 | 690.2% | 227.8% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.01\|top2\|pg30%\|dd10%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 49 | 690.2% | 227.8% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.01\|top3\|pg30%\|dd10%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 49 | 690.2% | 227.8% |  |
| agile-profit-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0.01\|top4\|pg30%\|dd10%\|mainline_persist>=0.15 | 721.0% | 231.3% | -23.6% | 49 | 690.2% | 227.8% |  |

## 分段复核

| 区间 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 |
|---|---:|---:|---:|---:|---:|---:|
| 2025H1 | 44.7% | 41.2% | -19.2% | 19 | 43.3% | 40.4% |
| 2025H2 | 96.2% | 73.4% | -16.0% | 19 | 99.5% | 75.2% |
| 2026H1 | 100.5% | 79.1% | -27.0% | 21 | 97.8% | 77.9% |

## 成交/成本敏感性

| 口径 | 收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 |
|---|---:|---:|---:|---:|---:|---:|
| 收盘0bp | 822.6% | 243.5% | 356.6% | -19.2% | 57 | 0.99 |
| 次开0bp | 783.2% | 239.2% | 343.2% | -19.2% | 57 | 0.99 |
| 收盘5bp | 796.2% | 240.6% | 347.7% | -19.2% | 57 | 0.99 |
| 次开5bp | 758.0% | 236.4% | 334.5% | -19.2% | 57 | 0.99 |
| 次开10bp | 733.4% | 233.5% | 326.0% | -19.2% | 57 | 0.99 |

## 收益集中度

| 主题 | 涉及标的 | 交易次数 | 胜率 | 组合贡献 |
|---|---|---:|---:|---:|
| 全球芯片 | 501225 全球芯片 | 2 | 100% | +215.2% |
| 半导体设备 | 159516 半导体设备 | 1 | 100% | +196.9% |
| 通信 | 515880 通信 | 3 | 100% | +142.4% |
| 军工航天 | 159206 卫星 | 2 | 50% | +139.1% |
| 中韩半导体 | 513310 中韩半导体 | 3 | 67% | +44.5% |
| 港股创新药 | 159567 港股创新药、513120 港股创新药(广发) | 5 | 80% | +43.7% |
| 人工智能 | 159363 创业板人工智能、515980 人工智能(华富) | 2 | 100% | +25.9% |
| 能源资源 | 518880 黄金、561360 石油 | 3 | 100% | +15.8% |
| 金融 | 513090 香港证券 | 1 | 100% | +14.2% |
| 恒生科技 | 159740 恒生科技 | 2 | 100% | +12.0% |
| 芯片宽泛 | 159995 芯片 | 1 | 100% | +4.5% |
| 信创软件 | 560850 信创(汇添富) | 1 | 100% | +2.2% |
| 科创芯片 | 588200 科创芯片 | 1 | 100% | +0.8% |
| 电池储能 | 561910 电池 | 1 | 0% | -9.1% |
| 光伏龙头 | 560980 光伏龙头 | 1 | 0% | -25.6% |

## 结论

本模式是收盘口径 flatReturn 优先的进攻版本。它通过更敏捷的盈利保护提高非复利主指标，但次开10bp口径没有同步创新高，因此更适合继续观察而不是替代所有执行场景。
