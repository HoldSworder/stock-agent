# a-stock-data sidecar 群晖独立部署

本服务是**独立基础设施容器**（与 aktools 一样），不进 stock-agent 主 compose。
stock-agent 后端只在「数据源」页填它暴露的地址来调用。

## 前置

- 部署在**国内出口**的机器（mootdx 走通达信 TCP 7709，海外/隧道环境会全超时）。群晖 DS920+ 在家庭国内出口，合适。
- NAS 已装 Docker + Compose v2。

## 一次性部署

```bash
# 1. 把本目录拷到 NAS（Mac 上执行）
rsync -av --exclude data --exclude .venv-test \
  sidecar/a-stock-data/ router-root:/volume1/docker/a-stock-data/

# 2. NAS 上构建并启动（amd64 原生构建）
ssh router-root 'cd /volume1/docker/a-stock-data && /usr/local/bin/docker compose up -d --build'

# 3. 验证
ssh router-root 'curl -s http://127.0.0.1:9119/health'
ssh router-root 'curl -s http://127.0.0.1:9119/selfcheck | head -c 800'
```

## 后端接入

数据源页「a-stock-data（mootdx sidecar）」→ Base URL 填：

```
http://<NAS局域网IP>:9119      # 例：http://192.168.31.144:9119
```

后端容器经局域网 IP 访问宿主发布的 9119 端口；填好后点健康检查应通过。

## 升级（跟随上游）

见 `UPSTREAM.md`：换 `vendor/SKILL.md` + 更新钉定 SHA → NAS 上 `docker compose up -d --build`（构建期自动重跑 `extract.py`）→ 跑 `/selfcheck` 看通过率。

## 运维

```bash
ssh router-root 'cd /volume1/docker/a-stock-data && /usr/local/bin/docker compose logs -f --tail 100'
ssh router-root 'cd /volume1/docker/a-stock-data && /usr/local/bin/docker compose restart'
```
