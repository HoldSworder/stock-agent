# ETF RS90 Top3 精细去重模式

这是一次独立归档的 ETF 交易模式研究包，原始参照文档仍保留在 `docs/`：

- `docs/etf-mainline-rotation-strategy.md`
- `docs/etf-trend-strategy-blueprint.md`

## 推荐模式

当前推荐执行候选：

```text
周频 Top3 RS90 + 精细主题去重
每 5 个交易日检查一次
最多持仓 3 只
同一主题 family 只保留最强 ETF
半导体细分赛道允许并存：半导体设备 / 科创芯片 / 全球芯片 / 中韩半导体 / 宽泛芯片
仍在目标名单内的持仓继续持有，不机械再平衡
```

核心结果：

| 方案 | 收益 | 回撤 | 交易 | 均仓 | 空槽日 |
|---|---:|---:|---:|---:|---:|
| 精细去重 RS90 | +206% | -19% | 101 | 3.00 | 0 |
| 精细去重 次日开盘 | +209% | -19% | 101 | 3.00 | 0 |
| 精细去重 2025 | +76% | -19% | 69 | 3.00 | 0 |
| 精细去重 2026 | +59% | -17% | 35 | 3.00 | 0 |

## 文件说明

| 文件 | 用途 |
|---|---|
| `etf-broad-strategy-search-2026-06-26.md` | 广义策略搜索结论，包含推荐模式、风险和对比 |
| `etf-strategy-research.py` | 跳出原框架的策略族研究脚本，生成 RS90 Top3 和精细去重回测 |
| `etf-mainline-rotation-improvement-2026-06-26.md` | 原框架内优化记录，作为备选对照 |
| `backtest-data/trades_rs90_top3_family.md` | 推荐精细去重版完整交易记录 |
| `backtest-data/trades_rs90_top3.md` | 原始 Top3 高集中版完整交易记录 |

> 原框架内优化版（金叉/追涨 + RS动量门禁 + Supertrend 出场 + 主线轮换）已独立归档为 `mode/etf-mainline-rotation/`，作为备选对照模式查阅。

## 复现

从项目根目录运行：

```bash
python3 mode/etf-rs90-top3/etf-strategy-research.py
```

如需把交易记录直接写回本模式包：

```bash
SA_RESEARCH_TRADE_LOG=mode/etf-rs90-top3/backtest-data/trades_rs90_top3.md \
SA_RESEARCH_FAMILY_TRADE_LOG=mode/etf-rs90-top3/backtest-data/trades_rs90_top3_family.md \
python3 mode/etf-rs90-top3/etf-strategy-research.py
```

## 重要风险

- `RS90` 是相对沪深300的 90 日强弱，不是下行通道过滤器。
- 当前样本下 `空槽日=0`，不能证明策略具备熊市自动降仓能力。
- 盈利高度集中在少数标的和少数主线阶段上，不能把 2025/2026 的强趋势结果外推为常态收益。
