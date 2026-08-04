# mx-entry-timing · 妙想买点日级回测

验证「妙想模拟盘买点是否近乎日内最高点，是否有更好买点」的一次性研究。仅出结论，
不改任何现有功能（不动 cron / 交易代码 / 不下单 / 不调 LLM）。

## 结论速览（详见 research-notes-*.md）

- 35 笔实际买入 100% 高于当日今开，均值落在当日振幅 0.66 分位 → 确证「开盘追涨买高位」。
- 换成「今开买 / 昨收买」：T+3 平均收益从 ~0% → +4.5%~5.0%，胜率 40% → 50%。
- 「延后一天买」无改善；「回踩不破今开再买」反而更差（漏强票、接弱票）。
- 建议方向：把 0933 买点前移到开盘一线（集合竞价/开盘首笔/挂≤今开限价），不追涨、不等回踩。

## 数据与口径

- 样本：`backend/data/stock-agent.sqlite` 的 `sim_trades`（妙想镜像战法）side=buy。
- 日线：腾讯 fqkline（前复权，本机可达；东财 push2his / 内网 :9119 在本机不可达）。
- 持有期：从各候选买点计到 T+3 / T+5 收盘，隔离买点因素。
- 局限：日级近似，无法刻画 09:30–09:33 分时路径；精修需分钟级前瞻实验。

## 运行

```bash
python3 mode/mx-entry-timing/entry-timing-backtest.py --selftest  # 纯函数自检
python3 mode/mx-entry-timing/entry-timing-backtest.py             # 实跑并生成 research-notes-<date>.md
```

环境变量：`SA_DB`（sqlite 路径，默认 backend/data/stock-agent.sqlite）、`SA_CACHE`（日线缓存目录）。
