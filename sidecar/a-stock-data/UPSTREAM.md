# 上游同步说明（a-stock-data）

本 sidecar 的取数逻辑来自上游开源仓库，**逐字 vendor + 构建期自动抽取**，几乎免手抄。

- 上游：https://github.com/simonlin1212/a-stock-data （Apache-2.0）
- vendor 文件：`vendor/SKILL.md`（上游原文）、`vendor/LICENSE`
- **当前钉定 commit：** `e40d0655793437aacf8f38f9fc1db0628d50a632`
- 抽取器：`extract.py` → 生成 `astock_functions.py`（不手改、不入库，构建期生成）

## 工作机制

上游把每个端点写成一个 ```python 代码块（块内 `def` + 末尾 `# 用法` 示例）。
`extract.py`：
1. 只保留「含顶层 `def`」的代码块；
2. 每块在第一个顶层 `# 用法` 处截断，丢掉会执行网络调用的示例行；
3. 按文档顺序拼接成 `astock_functions.py`。

mootdx 的 K线/盘口/逐笔/财务/F10 在上游是「内联片段（无 def）」，由 `app.py` 的 wrapper 实现，不走抽取。

## 升级到上游新版本

```bash
# 1. 拉取上游最新 SKILL.md + LICENSE（替换 <SHA> 为目标 commit）
SHA=$(gh api repos/simonlin1212/a-stock-data/commits/main --jq '.sha')
gh api repos/simonlin1212/a-stock-data/contents/SKILL.md?ref=$SHA --jq '.content' | base64 -d > vendor/SKILL.md
gh api repos/simonlin1212/a-stock-data/contents/LICENSE?ref=$SHA --jq '.content' | base64 -d > vendor/LICENSE

# 2. 更新本文件「当前钉定 commit」为 $SHA

# 3. 重新生成函数模块
python extract.py

# 4. 看上游 CHANGELOG 是否新增/重命名端点 → 同步 app.py 的 _SPEC 注册表

# 5. 重建镜像并冒烟
docker compose build a-stock-data && docker compose up -d a-stock-data
curl -s http://localhost:9119/selfcheck | jq '{ok, total_tested}'
```

## 注意

- 上游接口"烂得快"（cls.cn 已 404 下线、百度 PAE 失效改东财 slist 等先例）。升级后**务必跑 `/selfcheck`** 看哪些端点 error，对照上游 CHANGELOG 处理。
- `_SPEC` 用 `getattr(af, name, None)` 解析函数：上游若删/改函数名，对应端点会自动从 manifest 消失而非崩溃，便于平滑过渡。
