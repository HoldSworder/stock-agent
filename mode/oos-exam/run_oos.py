#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""走出样本考试：拿规则定版之后才发生的行情，重放固定参数。

# 这件事的性质

mode/ 下的 ETF 轮动策略回测区间统一截止 2026-06-26。06-27 之后的行情是规则写完
之后才发生的，作者当时看不见。所以拿这段数据重放**不是回测，是考试**——
它的全部价值来自「作者不可能偷看答案」。

# 最重要的约束：绝不重新扫参

各研究脚本是参数扫描型的：直接运行会在几十组参数里自己挑最优（top[:30]、
best_outer、best_cfg）。**在没见过的数据上重新扫参，整场考试就作废**——
那是在新数据上再挑一次最优，叫过拟合不叫考试。而且这种错误从输出上看不出来，
只会得到一组好看的数字。

所以本脚本：
  · 只 exec 各研究脚本的**定义区**（扫描区起始行之前），拿到 build_rank / run
  · 硬编码各自 README「推荐候选」那一行的参数，见下方 PLANS
  · 只调 run(rank, cfg, start, end)，不触碰任何遍历参数组合的代码路径

# 两个起点

规则脚本 2026-07-06 才提交入库。git 只能证明入库后没改过，证明不了入库版本与
06-26 跑回测时一致。所以跑两个起点：
  · 06-27 起——样本更长，但前 10 个交易日可能被污染
  · 07-07 起——干净，样本更短
如果 06-27 起跑的成绩明显好于 07-07 起跑，说明那 10 天里可能有「看了后续行情
再调参」的情况。这个对照本身是产出的一部分。

# 判生死的标准

不看绝对收益——两个半月的收益噪声太大，市场整体下跌时会全军覆没、误杀好规则。
看两条：
  1. 这段区间的最大回撤是否超出该规则自己历史上最差的水平（两套都是 -19.2%）
  2. 能否跑赢「拿住最强 ETF 不动」，跑不赢就是在做负功

收益只报非复利（每笔等额、不滚利）。复利会被后期大行情放大而失真。

运行：cd mode/oos-exam && python3 run_oos.py
"""
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]

# 输出到本目录，绝不碰各模式 backtest-data/ 里的既有产物
OUT = HERE
OUT.mkdir(parents=True, exist_ok=True)

# 各研究脚本内部会写日志文件，重定向到临时目录，避免污染既有产物
TMP = tempfile.mkdtemp(prefix='oos_exam_')
os.environ.setdefault('SA_MODE_OUT_DIR', TMP)
for name in (
    'SA_RESEARCH_TRADE_LOG',
    'SA_RUNNER_TRADE_LOG',
    'SA_RUNNER_MAINLINE_TRADE_LOG',
    'SA_TQ_TRADE_LOG',
    'SA_RESEARCH_SUMMARY_LOG',
):
    os.environ[name] = f'{TMP}/{name}.md'

# 考试区间。终点取最后一个已收录交易日
OOS_END = '2026-09-12'
STARTS = [
    ('06-27 起（样本更长，前 10 个交易日可能被污染）', '2026-06-27'),
    ('07-07 起（规则入库之后，干净）', '2026-07-07'),
]

# 各模式的推荐参数，逐字对应其 README 的「推荐候选」那一行。
#
# split_at：该脚本参数扫描区的起始行内容，据此切出定义区。
#   切错会导致 exec 时把扫描也跑一遍，那就是重新扫参——
#   所以下面对切割结果做了断言，切不干净直接报错退出。
PLANS = [
    {
        'name': '主题优先非复利主线龙头 theme-first',
        'dir': 'etf-mainline-theme-first-flat-leader',
        'script': 'etf-mainline-theme-first-flat-leader-research.py',
        'split_at': '\ntheme_keys = (',
        # theme=mainline_quality_score|leader=mainline_quality_score|mainline_persist>=0.15
        # |theme_breadth_above120>=0.50|theme_amount_power>=0.10|members>=1
        'outer': ('mainline_quality_score', 'mainline_quality_score', 0.15, 0.50, 0.10, 1),
        # 4d|min8|themeTop3|pg15%|dd6%|exit=ma120
        'cfg': (4, 8, 3, 0.15, 0.06, 'ma120'),
        # 回测基线（2025-01-02 ~ 2026-06-26，收盘 0bp）
        'baseline': {'flat': 232.5, 'mdd': -19.2, 'trades': 54},
        'params_note': 'theme=mainline_quality_score|leader=mainline_quality_score|'
                       'mainline_persist>=0.15|theme_breadth_above120>=0.50|'
                       'theme_amount_power>=0.10|members>=1|4d|min8|themeTop3|pg15%|dd6%|exit=ma120',
    },
    {
        'name': '主题宽度确认非复利主线龙头 breadth-confirmed（回测第一名）',
        'dir': 'etf-mainline-breadth-confirmed-flat-leader',
        'script': 'etf-mainline-breadth-confirmed-flat-leader-research.py',
        'split_at': '\ntests = []',
        # 这套的入口是 run_mode，全部参数都是关键字默认值，
        # 且默认值逐项等于 README 的推荐配置（4d/min6/sw0/top2/pg15%/dd6%/
        # persist>=0.15/breadth>=0.30/exit=ma120），所以不传任何参数即为推荐配置。
        'entry': 'run_mode',
        'baseline': {'flat': 248.1, 'mdd': -19.2, 'trades': 57},
        'params_note': 'breadth-confirmed-flat|anti_exhaustion_score|above60|4d|min6|sw0|top2|'
                       'pg15%|dd6%|mainline_persist>=0.15|theme_breadth_above120>=0.30'
                       '（= run_mode 的默认参数，未传任何覆盖）',
    },
]


BASE_SCRIPT = REPO / 'mode' / 'etf-mainline-factor-sweep' / 'etf-mainline-factor-sweep-research.py'
BASE_WIN_LINE = "WIN = ('2025-01-01', '2026-06-26')"


def patched_base_script() -> Path:
    """把基座的取数区间延长到考试终点，写到临时文件。

    基座里 WIN 的终点写死在 2026-06-26，它同时决定「取多少数据」和「days 有哪些日子」。
    不延长的话，考试区间里一个交易日都没有，跑出来是 0 笔交易。

    **不改原文件**：WIN 被所有依赖基座的研究脚本共享，改它会让那些脚本的既有产物
    无法复现。所以在内存里替换、写到临时文件，原文件一个字节都不动。
    """
    text = BASE_SCRIPT.read_text(encoding='utf-8')
    if BASE_WIN_LINE not in text:
        raise SystemExit(
            f'基座里找不到 {BASE_WIN_LINE!r}，脚本可能改过。'
            f'不要猜测区间常量的新写法，先人工确认。'
        )
    # 只动终点，起点保留——策略要用起点之后的历史算均线与动量
    patched = text.replace(BASE_WIN_LINE, f"WIN = ('2025-01-01', '{OOS_END}')")
    out = Path(TMP) / 'base_patched.py'
    out.write_text(patched, encoding='utf-8')
    return out


def load_defs(script_path: Path, split_at: str) -> dict:
    """exec 研究脚本的定义区，拿到 build_rank / run / U / days。

    只取 split_at 之前的部分。若 split_at 不在文件里，说明脚本结构变了，
    此时宁可报错退出，也不能把整个文件 exec 一遍——那会连参数扫描一起跑。
    """
    text = script_path.read_text(encoding='utf-8')
    # 让它去读区间已延长的基座副本，而不是仓库里那份
    base_line_old = "SWEEP = REPO / 'mode' / 'etf-mainline-factor-sweep' / 'etf-mainline-factor-sweep-research.py'"
    if base_line_old not in text:
        raise SystemExit(f'{script_path.name} 里找不到基座引用行，脚本结构可能变了')
    text = text.replace(base_line_old, f"SWEEP = Path({str(patched_base_script())!r})")
    if split_at not in text:
        raise SystemExit(
            f'切不出定义区：{script_path.name} 里找不到 {split_at!r}。\n'
            f'脚本结构可能变了。不要改成 exec 整个文件——那会重新扫参，考试作废。'
        )
    prefix = text.split(split_at, 1)[0]
    # 二次确认：定义区里不该出现扫描产物
    for banned in ('top = sorted(', 'best_outer', 'best_cfg'):
        if banned in prefix:
            raise SystemExit(f'定义区里出现了扫描代码 {banned!r}，切割位置不对')
    ns = {'__file__': str(script_path), '__name__': 'oos_exam_defs'}
    old = sys.stdout
    try:
        sys.stdout = open(os.devnull, 'w')
        exec(compile(prefix, str(script_path), 'exec'), ns)
    finally:
        sys.stdout.close()
        sys.stdout = old
    return ns


def buy_and_hold_strongest(ns: dict, start: str, end: str) -> dict:
    """基准：区间起点买入当时最强的那只 ETF，持有到区间结束。

    「最强」的口径：**起点前 60 个交易日涨幅最大者**，且该标的在起点与终点都有行情。
    没有用规则自己的强度分，理由是那个分数本身就是被考的对象之一——
    拿它挑基准，等于让考生自己出题。用一个朴素、与规则无关的口径更公允。
    """
    U = ns['U']
    days = ns['days']
    active = [d for d in days if start <= d <= end]
    if not active:
        return {'code': '', 'name': '', 'flat': 0.0, 'mdd': 0.0, 'note': '区间内没有交易日'}
    d0, d1 = active[0], active[-1]
    # 起点之前的第 60 个交易日
    before = [d for d in days if d < d0]
    d_ref = before[-60] if len(before) >= 60 else (before[0] if before else d0)

    best = None
    for code, (name, by_date) in U.items():
        r0, r1, rref = by_date.get(d0), by_date.get(d1), by_date.get(d_ref)
        if not r0 or not r1 or not rref:
            continue
        c0, c1, cref = r0.get('c'), r1.get('c'), rref.get('c')
        if not (c0 and c1 and cref) or cref <= 0 or c0 <= 0:
            continue
        mom = c0 / cref - 1
        if best is None or mom > best[0]:
            best = (mom, code, name, c0, c1, by_date)
    if best is None:
        return {'code': '', 'name': '', 'flat': 0.0, 'mdd': 0.0, 'note': '没有同时满足起终点行情的标的'}

    mom, code, name, c0, c1, by_date = best
    # 期间最大回撤，按日收盘计
    peak = c0
    mdd = 0.0
    for d in active:
        c = (by_date.get(d) or {}).get('c')
        if not c:
            continue
        peak = max(peak, c)
        mdd = min(mdd, (c / peak - 1) * 100)
    return {
        'code': code,
        'name': name,
        'flat': (c1 / c0 - 1) * 100,
        'mdd': mdd,
        'note': f'起点前 60 交易日涨幅 {mom * 100:+.1f}% 为当时最强',
    }


def normalize(res: dict) -> dict:
    """两套脚本的返回字段名不同，归一成同一套再判定。

    theme-first 用 flat / held，breadth-confirmed 用 flat_ret / avgheld。
    不归一会在取字段时 KeyError，或者更糟——取到 None 而静默算出错误结论。
    """
    flat = res.get('flat', res.get('flat_ret'))
    held = res.get('held', res.get('avgheld'))
    if flat is None or held is None:
        raise SystemExit(f'回测返回里找不到非复利收益或均仓字段，实际字段：{sorted(res)}')
    return {'flat': flat, 'mdd': res['mdd'], 'trades': res['trades'], 'held': held}


def verdict(res: dict, baseline: dict, bh: dict) -> str:
    """按两条标准判生死。不看绝对收益。"""
    reasons = []
    dead = False
    if res['mdd'] < baseline['mdd']:
        dead = True
        reasons.append(
            f"回撤 {res['mdd']:.1f}% 超出它历史上最差的 {baseline['mdd']:.1f}%，"
            f"说明遇到了设计范围之外的情况"
        )
    else:
        reasons.append(f"回撤 {res['mdd']:.1f}% 未超出历史最差 {baseline['mdd']:.1f}%")
    if res['flat'] < bh['flat']:
        dead = True
        reasons.append(
            f"非复利 {res['flat']:.1f}% 跑输「拿住最强 ETF 不动」的 {bh['flat']:.1f}%，"
            f"折腾换来的是负收益"
        )
    else:
        reasons.append(f"非复利 {res['flat']:.1f}% 跑赢不动持有的 {bh['flat']:.1f}%")
    return ('判死：' if dead else '判活：') + '；'.join(reasons)


def main() -> None:
    lines = ['# 走出样本考试', '']
    lines.append(f'考试区间终点 {OOS_END}。收益只报非复利（每笔等额、不滚利）。')
    lines.append('')
    lines.append('判生死不看绝对收益，看两条：回撤是否超出该规则历史最差、能否跑赢拿住最强 ETF 不动。')
    lines.append('')

    for plan in PLANS:
        script = REPO / 'mode' / plan['dir'] / plan['script']
        print(f"[oos] 加载 {plan['name']} ...", file=sys.stderr)
        ns = load_defs(script, plan['split_at'])

        # 两类入口：build_rank + run（theme-first 那种），或全默认参数的 run_mode
        if plan.get('entry') == 'run_mode':
            run_mode = ns['run_mode']
            def do(start: str):
                return run_mode(plan['name'], start=start, end=OOS_END, log=True)
        else:
            rank = ns['build_rank'](*plan['outer'])
            cfg = plan['cfg']
            def do(start: str, rank=rank, cfg=cfg, run=ns['run']):
                return run(rank, cfg, start, OOS_END, log=True)

        lines.append(f"## {plan['name']}")
        lines.append('')
        lines.append(f"参数（抄自 README 推荐配置，未重新扫参）：`{plan['params_note']}`")
        lines.append('')
        b = plan['baseline']
        lines.append(f"回测基线（2025-01-02 ~ 2026-06-26）：非复利 {b['flat']}%、"
                     f"最大回撤 {b['mdd']}%、{b['trades']} 笔")
        lines.append('')
        lines.append('| 起点 | 非复利收益 | 最大回撤 | 交易笔数 | 均仓 | 不动持有基准 | 判定 |')
        lines.append('|---|---:|---:|---:|---:|---|---|')

        for label, start in STARTS:
            res = normalize(do(start))
            bh = buy_and_hold_strongest(ns, start, OOS_END)
            v = verdict(res, b, bh)
            bh_cell = (f"{bh['name']}({bh['code']}) {bh['flat']:+.1f}%"
                       if bh['code'] else bh['note'])
            lines.append(
                f"| {label} | {res['flat']:+.1f}% | {res['mdd']:.1f}% | {res['trades']} | "
                f"{res['held']:.2f} | {bh_cell} | {v} |"
            )
            print(f"[oos] {label}: flat={res['flat']:+.1f}% mdd={res['mdd']:.1f}% "
                  f"trades={res['trades']} bh={bh_cell}", file=sys.stderr)
        lines.append('')

    out = OUT / 'oos_exam.md'
    out.write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(f'[oos] 报告写入 {out}', file=sys.stderr)


if __name__ == '__main__':
    main()
