# stock-agent · 选股 Agent 平台

自托管的 A 股选股 / 选板块 / 模拟交易平台。用任意 OpenAI 兼容模型驱动 agent，直连妙想（东方财富）官方接口作为工具，内置定时任务、聊天交互、选股结果结构化留痕与复盘，结果可推送 Telegram。Docker 部署，数据落 SQLite。

## 技术栈

- 后端：Node + TypeScript + Fastify + Drizzle(better-sqlite3) + croner + OpenAI SDK（指向任意 OpenAI 兼容服务）
- 前端：Vue 3 + Vite + Element Plus + Pinia
- 共享：`shared/` 前后端公用 DTO 类型
- 部署：单 docker-compose，群晖 Container Manager 可直接拉起

## 目录

```
backend/   Fastify 服务、agent 循环、妙想客户端、调度器、SQLite
frontend/  Vue3 WebUI（对话 / 任务 / 复盘 / 留痕 / 设置）
shared/    前后端共享类型
```

## 本地开发

```bash
pnpm install
cp .env.example .env   # 填入 DeepSeek / 妙想 / Telegram 配置（也可启动后在设置页填）
pnpm dev               # 同时起后端(8787) 与前端(5173)
```

前端开发地址 http://localhost:5173 ，已配置 `/api`、`/ws` 代理到后端。

## Docker / 群晖部署

```bash
cp .env.example .env   # 填配置
docker compose up -d --build
```

访问 http://<群晖IP>:8787 。SQLite 持久化在 `./data`。

## 使用流程

1. 打开「设置」，填入模型 Base URL / API Key / 模型名（任意 OpenAI 兼容服务）、妙想 EM_API_KEY / MX_APIKEY、Telegram（可选），点「测试连通性」。
2. 「定时任务」中内置了从 openclaw 迁移的股票任务（**默认禁用**），逐个核对 prompt 与 cron 后启用。
3. 「对话」里可直接与 agent 交互选股、查数据；「运行 / 复盘」看每次运行的完整轨迹；「选股留痕」按日期复盘历史选股。
4. 「真实持仓」展示同花顺账本的真实持仓（现价 / 成本 / 当日盈亏，红涨绿跌），数据源见下。

## 真实持仓接入

真实持仓复用 LXC 上已有的 `portfolio-sync`：它用同花顺投资账本 cookie 拉持仓、用妙想校正当日盈亏，把含结构化 JSON 的 Markdown 快照写入 OpenViking（`viking://.../events/YYYY/MM/DD/portfolio_snapshot.md`）。

本平台只读消费该快照：

- 配置 `OPENVIKING_*`（Base URL / API Key / Account / User / 快照前缀，见 `.env.example`，也可在设置页填）。
- agent 工具 `real_positions` 按日期回溯读取最新快照，解析归一化后镜像落 `positions` 表（`account=real`），供「真实持仓」页与 `GET /api/positions/real` 使用。
- **只读，不下单**；「真实持仓-1440-卖点检查」任务用它做卖点研判与提醒。

## 说明

- 所有定时任务默认 `Asia/Shanghai` 时区、关闭推理（thinking=off），沿用 openclaw 最佳实践。
- 妙想接口契约基于官方 skill 文档整理，真实字段映射需在配置 key 后联调校正（见 `backend/src/miaoxiang/client.ts`）。
- openclaw 侧不受影响，本平台与其并行运行。
