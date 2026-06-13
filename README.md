# stock-agent · 选股 Agent 平台

自托管的 A 股选股 / 选板块 / 模拟交易平台。用任意 OpenAI 兼容模型驱动 agent，直连妙想（东方财富）官方接口作为工具，内置定时任务、聊天交互、战法模拟与复盘，结果可推送 Telegram。Docker 部署，数据落 SQLite。

## 技术栈

- 后端：Node + TypeScript + Fastify + Drizzle(better-sqlite3) + croner + OpenAI SDK（指向任意 OpenAI 兼容服务）
- 前端：Vue 3 + Vite + Element Plus + Pinia
- 共享：`shared/` 前后端公用 DTO 类型
- 部署：单 docker-compose，群晖 Container Manager 可直接拉起

## 目录

```
backend/   Fastify 服务、agent 循环、妙想客户端、调度器、SQLite
frontend/  Vue3 WebUI（对话 / 任务 / 复盘 / 战法模拟 / 设置）
shared/    前后端共享类型
```

## 本地开发

本项目固定使用 **Node 22**（见 `.nvmrc`）。`better-sqlite3` 是原生模块，其 ABI 与 Node 大版本绑定；用其它 Node 版本启动后端会报 `ERR_DLOPEN_FAILED` 导致进程崩溃、`/api` 全部 500。

```bash
nvm use                # 切到 .nvmrc 指定的 Node 22
pnpm install
cp .env.example .env   # 填入 DeepSeek / 妙想 / Telegram 配置（也可启动后在设置页填）
pnpm dev               # 同时起后端(8787) 与前端(5173)
```

前端开发地址 http://localhost:5173 ，已配置 `/api`、`/ws` 代理到后端。

> 若切换过 Node 版本（如 nvm 在 v22/v24 间切换）后后端报 `NODE_MODULE_VERSION` 不匹配，在 Node 22 下执行 `pnpm fix:native` 重建原生模块即可。

## Docker / 群晖部署

```bash
cp .env.example .env   # 填配置
docker compose up -d --build
```

访问 http://<群晖IP>:8787 。SQLite 持久化在 `./data`。

## 使用流程

1. 打开「设置」，填入模型 Base URL / API Key / 模型名（任意 OpenAI 兼容服务）、妙想 EM_API_KEY / MX_APIKEY、Telegram（可选），点「测试连通性」。
2. 「定时任务」中内置了从 openclaw 迁移的股票任务（**默认禁用**），逐个核对 prompt 与 cron 后启用。
3. 「对话」里可直接与 agent 交互选股、查数据；「运行 / 复盘」看每次运行的完整轨迹；「战法模拟」按战法跟踪模拟交易流水与盈亏。
4. 「真实持仓」展示同花顺账本的真实持仓（现价 / 成本 / 当日盈亏，红涨绿跌），数据源见下。

## 真实持仓接入

真实持仓直连同花顺投资账本接口，自给自足，无需 OpenViking / portfolio-sync：

- `stock_position` 接口取持仓账本（股数、成本、现金），`pass_quotes` 接口取实时现价/昨收，用实时报价重算现价与当日盈亏（同花顺账本内嵌的现价/当日盈亏是上次上传的静态快照，可能滞后多日，故不直接采用）。
- **场外基金（蚂蚁财富等）**：`account_list` 取账本的基金账户（`manFund`，如「支付宝」拿到 `fundId`），`fund/v1/merge_fund`（POST，参数 `from_id=pcweb&fundid={fundId}`）取该账户逐只基金持仓；同花顺侧已算好份额 `fundcount`、成本净值 `percost`、最新净值 `fundnav`、市值 `fundvalue`、持有盈亏 `posprofit/pospercent`，口径与账户汇总一致，直接采用，无需外接估值。基金为手动账户，需先在「同花顺投资账本」App 的对应账户里录入持仓，系统才能读到。
- 配置 `THS_COOKIE`（`.10jqka.com.cn` 域 Cookie 整串）/ `THS_USER_ID`（同花顺 UID）/ `THS_FUND_KEYS`（资金账户 key，逗号分隔），见 `.env.example`，也可在设置页填。Cookie 需手动维护，失效后重新登录导出。
- agent 工具 `real_positions` 实时拉取并归一化后镜像落 `positions` 表（`account=real`），供「真实持仓」页与 `GET /api/positions/real` 使用。基金估值失败或账户为空时只读返回，不影响股票部分。
- **只读，不下单**；「真实持仓-1440-卖点检查」任务用它做卖点研判与提醒。

## 说明

- 所有定时任务默认 `Asia/Shanghai` 时区、关闭推理（thinking=off），沿用 openclaw 最佳实践。
- 妙想接口契约基于官方 skill 文档整理，真实字段映射需在配置 key 后联调校正（见 `backend/src/miaoxiang/client.ts`）。
- openclaw 侧不受影响，本平台与其并行运行。
