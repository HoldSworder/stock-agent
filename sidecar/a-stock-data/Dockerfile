FROM python:3.12-slim

WORKDIR /app

# 不装 apt 包（Debian 镜像源在国内极慢）：依赖全是 manylinux wheel，无需编译；
# urllib 的 HTTPS 证书改用 certifi（见 app.py 启动时设置 SSL_CERT_FILE），不依赖系统 ca-certificates。
# pip 走清华镜像加速（国内拉 PyPI 快很多）。
COPY requirements.txt .
RUN pip install --no-cache-dir --prefer-binary \
    -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# 先放抽取器与 vendor 原文，构建期生成 astock_functions.py（上游升级=换 vendor 重 build）
COPY extract.py .
COPY vendor ./vendor
RUN python extract.py

COPY app.py .

# HOME 指向持久卷：mootdx 配置(~/.mootdx) 与北向自缓存(~/.tradingagents) 落盘不丢
ENV HOME=/data
# 东财统一限流间隔（秒），批量任务可调大
ENV EM_MIN_INTERVAL=1.0
RUN mkdir -p /data

EXPOSE 9119
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9119"]
