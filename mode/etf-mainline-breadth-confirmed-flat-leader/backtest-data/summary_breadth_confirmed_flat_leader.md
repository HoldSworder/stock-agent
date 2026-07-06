# 主题宽度确认非复利主线龙头回测摘要

- 回测区间: 2025-01-02 至 2026-06-26
- ETF池: 55 只
- 最大持仓: 1（满足最大持仓不超过 3）；同主题重复持仓天然为 0。
- 推荐配置: `breadth-confirmed-flat|anti_exhaustion_score|above60|4d|min6|sw0|top2|pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30`
- 机制: 候选需 `mainline_persist >= 0.15` 且 `theme_breadth_above120 >= 0.30`；每 4 个交易日复核；最小持有 6 个交易日；持仓跌出 Top2、跌破 MA120、或单笔浮盈超过 15% 后从峰值回撤 6% 时退出。
- 全段收益: 复利 `865.8%` / 非复利(等权) `248.1%`；最大回撤 `-19.2%`；交易 `57`；交易记录 `trades_breadth_confirmed_flat_leader.md`。
- 执行口径: 次开 10bp 复利 `737.6%` / 非复利 `233.9%`。
- 说明: 本模式用主题宽度确认替代单一 ETF 孤立强势确认，收盘 `flatReturn` 高于敏捷止盈非复利主线龙头的 `243.5%`。

## 候选复核

| 策略 | 复利收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 | 空槽日 | 最大持仓 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 主题宽度确认非复利主线龙头-全段 | 865.8% | 248.1% | 371.1% | -19.2% | 57 | 0.99 | 5 | 1 |

## 参数对照（按收盘非复利收益排序）

| 策略 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 | 备注 |
|---|---:|---:|---:|---:|---:|---:|---|
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15\|theme_breadth_above120>=0.30 | 865.8% | 248.1% | -19.2% | 57 | 737.6% | 233.9% | 推荐 |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15\|theme_breadth_above120>=0.30 | 865.8% | 248.1% | -19.2% | 57 | 737.6% | 233.9% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15\|theme_breadth_above120>=0.40 | 865.8% | 248.1% | -19.2% | 57 | 737.6% | 233.9% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15\|theme_breadth_above120>=0.40 | 865.8% | 248.1% | -19.2% | 57 | 737.6% | 233.9% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15\|theme_breadth_above120>=0.50 | 865.8% | 248.1% | -19.2% | 57 | 737.6% | 233.9% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15\|theme_breadth_above120>=0.50 | 865.8% | 248.1% | -19.2% | 57 | 737.6% | 233.9% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15\|theme_breadth_above120>=0.20 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|4d\|min8\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15\|theme_breadth_above120>=0.20 | 822.6% | 243.5% | -19.2% | 57 | 733.4% | 233.5% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min8\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15\|theme_breadth_above120>=0.30 | 720.8% | 231.4% | -27.0% | 51 | 685.3% | 227.1% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min8\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15\|theme_breadth_above120>=0.40 | 720.8% | 231.4% | -27.0% | 51 | 685.3% | 227.1% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min8\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.15\|theme_breadth_above120>=0.50 | 720.8% | 231.4% | -27.0% | 51 | 685.3% | 227.1% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0\|top2\|pg20%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.30 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0\|top2\|pg25%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.30 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0\|top2\|pg20%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.30 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0\|top2\|pg25%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.30 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0\|top2\|pg20%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.40 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0\|top2\|pg25%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.40 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0\|top2\|pg20%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.40 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0\|top2\|pg25%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.40 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0\|top2\|pg20%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.50 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min4\|sw0\|top2\|pg25%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.50 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0\|top2\|pg20%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.50 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|3d\|min6\|sw0\|top2\|pg25%\|dd8%\|mainline_persist>=0.15\|theme_breadth_above120>=0.50 | 698.1% | 228.5% | -23.6% | 55 | 654.8% | 223.3% |  |
| breadth-confirmed-flat\|anti_exhaustion_score\|above60\|4d\|min6\|sw0\|top2\|pg15%\|dd6%\|mainline_persist>=0.12\|theme_breadth_above120>=0.30 | 689.1% | 227.8% | -19.4% | 59 | 613.7% | 217.9% |  |

## 分段复核

| 区间 | 收盘复利 | 收盘非复利 | 最大回撤 | 交易 | 次开10bp收益 | 次开10bp非复利 |
|---|---:|---:|---:|---:|---:|---:|
| 2025H1 | 51.5% | 45.8% | -19.2% | 19 | 44.0% | 40.9% |
| 2025H2 | 96.2% | 73.4% | -16.0% | 19 | 99.5% | 75.2% |
| 2026H1 | 100.5% | 79.1% | -27.0% | 21 | 97.8% | 77.9% |

## 成交/成本敏感性

| 口径 | 收益 | 非复利收益 | 年化 | 最大回撤 | 交易 | 均仓 |
|---|---:|---:|---:|---:|---:|---:|
| 收盘0bp | 865.8% | 248.1% | 371.1% | -19.2% | 57 | 0.99 |
| 次开0bp | 787.7% | 239.6% | 344.7% | -19.2% | 57 | 0.99 |
| 收盘5bp | 838.1% | 245.2% | 361.9% | -19.2% | 57 | 0.99 |
| 次开5bp | 762.3% | 236.8% | 336.0% | -19.2% | 57 | 0.99 |
| 次开10bp | 737.6% | 233.9% | 327.4% | -19.2% | 57 | 0.99 |

## 收益集中度

| 主题 | 涉及标的 | 交易次数 | 胜率 | 组合贡献 |
|---|---|---:|---:|---:|
| 全球芯片 | 501225 全球芯片 | 2 | 100% | +225.3% |
| 半导体设备 | 159516 半导体设备 | 1 | 100% | +206.1% |
| 通信 | 515880 通信 | 3 | 100% | +149.1% |
| 军工航天 | 159206 卫星 | 2 | 50% | +145.6% |
| 港股创新药 | 159567 港股创新药、513120 港股创新药(广发) | 5 | 100% | +55.1% |
| 中韩半导体 | 513310 中韩半导体 | 3 | 67% | +46.6% |
| 人工智能 | 159363 创业板人工智能、515980 人工智能(华富) | 2 | 100% | +27.1% |
| 金融 | 513090 香港证券 | 1 | 100% | +14.9% |
| 能源资源 | 518880 黄金、561360 石油 | 3 | 67% | +12.8% |
| 恒生科技 | 159740 恒生科技 | 2 | 100% | +12.0% |
| 芯片宽泛 | 159995 芯片 | 1 | 100% | +4.5% |
| 信创软件 | 560850 信创(汇添富) | 1 | 100% | +2.2% |
| 科创芯片 | 588200 科创芯片 | 1 | 100% | +0.8% |
| 电池储能 | 561910 电池 | 1 | 0% | -9.5% |
| 光伏龙头 | 560980 光伏龙头 | 1 | 0% | -26.8% |

## 结论

主题宽度确认把当前最佳模式的价格主线判断推进了一步：候选不只自己强，还要求同主题已有一定 MA120 宽度。该规则提升了系统 flatReturn，但次开10bp非复利仍未显著突破，实盘应继续观察成交滑点。
