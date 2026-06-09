# 多阶段构建：构建前端 -> 装配后端运行镜像
# 注意：构建上下文为仓库根目录（见 docker-compose.yml 的 context: .）

FROM node:22-bookworm AS build
WORKDIR /app
RUN corepack enable

# 先拷依赖清单，利用层缓存
COPY package.json pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY shared/package.json ./shared/
RUN pnpm install

# 拷源码并构建前端（产物输出到 backend/public）
COPY shared ./shared
COPY backend ./backend
COPY frontend ./frontend
RUN pnpm --filter ./frontend build

# ===== 运行阶段 =====
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 复制整个工作区（含已编译的 better-sqlite3 与 tsx）
COPY --from=build /app /app
WORKDIR /app/backend
EXPOSE 8787
CMD ["node", "--import", "tsx", "src/server.ts"]
