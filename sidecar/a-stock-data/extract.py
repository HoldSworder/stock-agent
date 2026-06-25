#!/usr/bin/env python3
"""从 vendor/SKILL.md 抽取可运行的 Python 函数，生成 astock_functions.py。

上游 a-stock-data 把每个端点写成「一个 ```python 代码块」，块内是 def + 末尾
`# 用法` 示例（示例是顶层执行语句，直接 import 会触发网络调用）。

抽取规则（务必与 README 的「上游跟进策略」一致）：
  1. 只保留「含顶层 def」的代码块（纯示例/纯 mootdx 内联片段不含 def → 跳过，
     这些 mootdx 内联能力由 app.py 的 wrapper 单独实现）。
  2. 每块在第一个顶层 `# 用法` 注释处截断，丢掉会执行网络调用的示例行。
  3. 按文档顺序拼接，模块级常量/helper（UA / EM_SESSION / REPORT_API 等）随其
     所在块（块内都带 def）一并保留。

上游升级流程：覆盖 vendor/SKILL.md → 更新 UPSTREAM.md 的 SHA → 重跑本脚本 →
跑 /selfcheck 看端点通过率。详见 UPSTREAM.md。
"""
from __future__ import annotations

import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE / "vendor" / "SKILL.md"
OUT = HERE / "astock_functions.py"

# 顶层 def（行首，无缩进）
_DEF_RE = re.compile(r"^def\s+\w+\s*\(")
# 顶层「# 用法」示例分隔符（含 `# 用法`, `# 用法:`, `# 用法 1:` 等）
_USAGE_RE = re.compile(r"^#\s*用法")

HEADER = '''# -*- coding: utf-8 -*-
# 本文件由 extract.py 从 vendor/SKILL.md 自动生成，请勿手改。
# 来源：simonlin1212/a-stock-data（Apache-2.0），见 vendor/LICENSE 与 UPSTREAM.md。
# 重新生成：python extract.py
'''


def _python_blocks(md: str) -> list[list[str]]:
    """返回所有 ```python ... ``` 代码块（每块为行列表，不含围栏）。"""
    blocks: list[list[str]] = []
    lines = md.splitlines()
    i = 0
    while i < len(lines):
        if lines[i].strip() == "```python":
            j = i + 1
            buf: list[str] = []
            while j < len(lines) and lines[j].strip() != "```":
                buf.append(lines[j])
                j += 1
            blocks.append(buf)
            i = j + 1
        else:
            i += 1
    return blocks


def _truncate_at_usage(block: list[str]) -> list[str]:
    """在第一个顶层 `# 用法` 处截断（丢弃其后的示例行）。"""
    for idx, ln in enumerate(block):
        if _USAGE_RE.match(ln):
            return block[:idx]
    return block


def _has_top_level_def(block: list[str]) -> bool:
    return any(_DEF_RE.match(ln) for ln in block)


def main() -> None:
    if not SKILL.exists():
        raise SystemExit(f"找不到 {SKILL}，请先 vendor 上游 SKILL.md")
    md = SKILL.read_text(encoding="utf-8")
    kept: list[str] = []
    n_blocks = 0
    for block in _python_blocks(md):
        trimmed = _truncate_at_usage(block)
        if not _has_top_level_def(trimmed):
            continue  # 纯示例 / mootdx 内联片段，跳过（wrapper 在 app.py 实现）
        n_blocks += 1
        # 去掉尾部空行后追加一个空行分隔
        while trimmed and not trimmed[-1].strip():
            trimmed.pop()
        kept.append("\n".join(trimmed))
    body = HEADER + "\n\n" + "\n\n\n".join(kept) + "\n"
    OUT.write_text(body, encoding="utf-8")
    defs = len(re.findall(r"^def\s+\w+", body, re.M))
    print(f"[extract] {n_blocks} 个含 def 的代码块 → {defs} 个函数 → {OUT}")


if __name__ == "__main__":
    main()
