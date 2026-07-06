#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""因子目录 + IC 导出（只读）。

复用 etf-mainline-factor-sweep-research.py 已算好的因子面板 U，产出 webui「因子探索」页
所需的单一 artifact：backend/data/factor-catalog.json，包含三块：

- catalog : 每个因子的分类 / 中文名 / 介绍 / 公式 / 方向 / IC 统计（5日+10日）
- snapshot: 最新交易日每只 ETF 的全因子值（供当前榜单 / 因子组合实验前端打分）
- meta    : 样本范围、生成时间、口径说明

设计原则：不修改原脚本、不写入 backtest-data，原脚本日志重定向到临时目录。
IC = 每个交易日跨全部 ETF 的「因子值 vs 未来 N 日收益」斯皮尔曼秩相关，对时间求均值。

运行：
  python3 mode/etf-mainline-factor-sweep/factor_export.py
"""
import os
import sys
import math
import json
import tempfile
from datetime import datetime, timezone, timedelta

# 原脚本输出重定向到临时目录，避免覆盖真实 backtest-data
_TMP_OUT = tempfile.mkdtemp(prefix='factor_export_')
os.environ.setdefault('SA_MODE_OUT_DIR', _TMP_OUT)
os.environ['SA_RESEARCH_TRADE_LOG'] = f'{_TMP_OUT}/t.md'
os.environ['SA_RUNNER_TRADE_LOG'] = f'{_TMP_OUT}/r.md'
os.environ['SA_RESEARCH_SUMMARY_LOG'] = f'{_TMP_OUT}/s.md'

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_PATH = os.environ.get(
    'SA_FACTOR_CATALOG',
    os.path.join(REPO_ROOT, 'backend', 'data', 'factor-catalog.json'),
)
sys.path.insert(0, HERE)

_real_stdout = sys.stdout
try:
    sys.stdout = open(os.devnull, 'w')
    import importlib
    research = importlib.import_module('etf-mainline-factor-sweep-research')
finally:
    sys.stdout.close()
    sys.stdout = _real_stdout

U = research.U  # {code: (name, {date: {factor: value}})}

FWD_HORIZONS = [5, 10]
MIN_NAMES_PER_DAY = 8
EXCLUDE = {
    'o', 'h', 'l', 'c', 'amount', 'nopen',
    'ma20', 'ma30', 'ma60', 'ma120', 'atr20', 'atr60',
    'low10prev', 'low20prev', 'hi20prev', 'hi60prev', 'hi120prev',
    'above60', 'above120', 'theme_member_count',
}

# ---- 分类（与 README 16 族对齐的关键词归类） ----
CATEGORIES = [
    ('cross_rank', '横截面排名', ['rank_pct', 'rank_jump', 'rank_quality', 'rank_surge', 'rank_ensemble', 'cross_rank', 'early_rank']),
    ('theme', '主题/板块宽度', ['theme_', 'width_blend', 'width_stable', 'mainline_width']),
    ('persist', '持续性主线', ['persist', 'continuity', 'fresh_mainline']),
    ('rs', '相对强弱 RS', ['rs20', 'rs30', 'rs60', 'rs90', 'rs120', 'rs_accel', 'combo', 'mom_rs']),
    ('trend_quality', '趋势质量', ['trend_quality', 'slope', 'accel20']),
    ('momentum', '动量', ['mom20', 'mom25', 'mom30', 'mom35', 'mom40', 'mom45', 'mom50', 'mom55', 'mom60', 'mom90', 'mom120', 'mom126', 'mom252', 'abs13612', 'abs_mom', 'abs_accel', 'sprint', 'multi_mom', 'balanced_momentum', 'barbell', 'acceleration_curve', 'mom30_z', 'normalized_momentum']),
    ('breakout', '突破/位置', ['breakout', 'pos60', 'pos120', 'early_breakout', 'early_accel', 'early_trend', 'high_reclaim', 'recovery_breakout', 'channel_width', 'new_high']),
    ('ma', '均线/趋势结构', ['dist_ma', 'ma_stack', 'ma_ribbon', 'streak_above', 'streak_up']),
    ('volume', '量能/成交额', ['vol_ratio', 'amount_', 'turnover', 'vol_dryup', 'obv', 'pvt', 'mfi']),
    ('volatility', '波动/收缩', ['atr', 'range_contract', 'intraday_range', 'vol20', 'inv_vol', 'quiet_trend', 'boll_width', 'boll_squeeze', 'volatility_expansion']),
    ('candle', 'K线结构', ['close_location', 'body_pct', 'shadow', 'gap_', 'candle_strength', 'squeeze_breakout', 'gap_momentum']),
    ('path', '路径质量/风险调整', ['up_ratio', 'efficiency', 'sharpe', 'sortino', 'path_mdd', 'ulcer', 'skew', 'tail_loss', 'calmar', 'smooth_mom', 'drawdown', 'downside_control', 'path_quality', 'recovery_from_low', 'dd_from_high']),
    ('residual', '基准残差(剥离大盘)', ['beta', 'corr30', 'corr60', 'alpha30', 'alpha60', 'alpha90', 'residual_mom', 'alpha_trend', 'independent_trend', 'low_beta']),
    ('indicator', '经典技术指标', ['rsi', 'stoch', 'kdj', 'willr', 'boll_pctb', 'macd', 'di20', 'dmi', 'adx', 'cci', 'aroon', 'reg_', 'regression', 'swing_strength', 'oversold', 'uptrend_pullback']),
    ('lifecycle', '趋势寿命/过热', ['trend_age', 'mature_trend', 'anti_exhaustion', 'short_over_mid_heat']),
    ('consistency', '多周期一致性', ['term_structure', 'multi_period', 'multi_mom_quality']),
    ('composite', '复合主线/集成', ['mainline_core', 'mainline_early', 'mainline_persist', 'mainline_quality', 'confirm_stack', 'ensemble', 'regime_trend', 'benchmark_risk']),
]
CATEGORY_INTRO = {
    '横截面排名': '把因子在全 ETF 池里的相对名次作为信号。IC 体检里这一簇整体最高，因为 IC 本身就是横截面排序的度量。适合分散多持仓选股，但对单仓押龙头打法增益有限。',
    '主题/板块宽度': '统计同主题 ETF 的整体强度与宽度（多少只站上均线、放量、突破）。用来判断「是不是真主线」而非单只噪声。IC 普遍偏高。',
    '持续性主线': '衡量一只 ETF 或主题是否持续处在强势前排。强调「新晋强势」优于「长期拥挤」。',
    '相对强弱 RS': 'ETF 相对沪深300的阶段强弱，回答「是否跑赢大盘」。可靠的确认项，但单独排序在小池子里不占优。',
    '趋势质量': '在动量基础上叠加趋势斜率、MA60 上方质量并惩罚高波动。你回测的核心打法所在簇，最擅长单仓押中最强主升龙头。',
    '动量': '不同回看窗口的绝对涨幅。最基础、最稳健的主线信号，是大多数复合因子的底座。',
    '突破/位置': '阶段新高突破与区间相对位置，捕捉主升刚确认的右侧入场点。',
    '均线/趋势结构': '价格与多条均线的距离、均线多头排列、连续站上均线天数，描述趋势的结构强度。',
    '量能/成交额': '成交量/成交额的放大与承接，以及 OBV/PVT/MFI 等量价累积。多为确认项，难单独承担主线选择。',
    '波动/收缩': 'ATR、年化波动、布林带宽与波动收缩。低波趋势偏防御，波动收缩后常伴突破。',
    'K线结构': '日内收盘位置、实体强弱、上下影线、跳空。其中跳空动量确认有边际增量。',
    '路径质量/风险调整': '上涨日比例、趋势效率、夏普/索提诺、阶段回撤。适合做风险解释，但过度奖励顺滑会压低主升捕捉。',
    '基准残差(剥离大盘)': '剥离大盘 beta 后的独立强势（alpha / 残差动量）。回答「是不是脱离大盘的独立主线」。',
    '经典技术指标': 'RSI、MACD、KDJ、布林、DMI/ADX、Aroon 等常见指标的近似实现，多数没有提供超过趋势质量的增量。',
    '趋势寿命/过热': '连续上涨天数、动量 z-score、过热惩罚等，对主升中后段做衰竭修正。',
    '多周期一致性': '多个回看窗口动量的一致性与期限结构斜率。',
    '复合主线/集成': '把多个确认项加权堆叠成的综合分。简单集成往往稀释主信号，未突破单因子最优。',
    '其他': '未归入上述族的因子。',
}

# ---- 关键因子精修文案（其余走分类级介绍兜底） ----
FACTOR_DOC = {
    'mom30': {'cn': '30日动量', 'desc': '过去30个交易日的涨幅。最基础的中线主线信号，也是趋势质量族的底座。', 'formula': 'close / close[-30] - 1'},
    'mom30_trend_quality_smooth': {'cn': '30日趋势质量(平滑)', 'desc': '你回测的冠军因子：30日动量叠加MA20/60斜率与MA60上方质量，并惩罚ATR波动。最擅长单仓押中最强主升龙头。', 'formula': 'mom30 + 0.15*max(MA20/MA60-1,0) + 0.15*max(close/MA60-1,0) - 0.15*ATR20/close'},
    'gap_momentum_score': {'cn': '跳空动量确认', 'desc': '在趋势质量基础上加入跳空、实体确认并惩罚上影线。次开10bp口径的鲁棒最佳，作为趋势质量的执行确认项。', 'formula': 'trend_quality + 跳空/实体确认 - 上影线惩罚'},
    'anti_exhaustion_score': {'cn': '过热衰竭修正', 'desc': '趋势质量的过热修正版，对连续大涨、动量过热的标的做衰减，收盘口径小幅改善。', 'formula': 'mom30_trend_quality_smooth - 过热惩罚'},
    'rs90': {'cn': '90日相对强弱', 'desc': 'ETF相对沪深300过去90日的超额强弱，慢速但稳健，回答是否持续跑赢大盘。', 'formula': '(close/close[-90]) / (HS300/HS300[-90]) - 1'},
    'theme_width': {'cn': '主题宽度', 'desc': '同主题ETF的整体强度宽度：多少只站上MA120、动量为正、突破。判断是否真主线。', 'formula': '0.35*站上MA120比例 + 0.30*动量>8%比例 + 0.20*突破比例 + 0.15*平均动量'},
    'cross_rank_blend': {'cn': '横截面排名混合', 'desc': 'IC体检榜首：多个横截面分位的混合。排序全场最准，适合分散多持仓，但单仓回测会被稀释。', 'formula': '多分位加权混合'},
    'mom30_width_stable': {'cn': '动量+主题宽度(稳健)', 'desc': '30日动量叠加主题宽度，并对极端放量做轻惩罚。横截面IC很高的主线确认因子。', 'formula': 'mom30 + 0.20*theme_width - 0.04*max(amount_ratio20-2,0)'},
    'tq_rank_pct': {'cn': '趋势质量分位', 'desc': '趋势质量在全ETF池中的横截面分位，与绝对趋势质量高度一致但更可比。', 'formula': 'rank(trend_quality) / N'},
    'ulcer30': {'cn': '溃疡指数(30日)', 'desc': '近30日回撤痛苦度。IC显著为负，是稳定的反向信号：回撤越痛，未来越弱，适合做排雷减分项。', 'formula': 'sqrt(mean(回撤平方))，方向为负'},
    'turnover_proxy': {'cn': '换手代理', 'desc': '成交活跃度代理。IC显著为负：过度拥挤反而跑输，适合做减分项。', 'formula': '成交额/流通规模代理，方向为负'},
    'willr14': {'cn': '威廉指标(14)', 'desc': '超买超卖指标。在ETF主线上IC为负，越超买未来越弱。', 'formula': '(最高-收盘)/(最高-最低)，方向为负'},
    'fresh_mainline_score': {'cn': '新晋强势主线', 'desc': '强调最近10日进入前排、不过度奖励长期拥挤的主线分，IC较高。', 'formula': '趋势质量 + 近期排名跃迁'},
    'pvt_confirm_score': {'cn': '量价累积确认', 'desc': '趋势质量叠加OBV/PVT量价累积斜率确认，与跳空动量同档。', 'formula': 'trend_quality + OBV/PVT 斜率确认'},
}


def categorize(name):
    for _key, label, kws in CATEGORIES:
        if any(kw in name for kw in kws):
            return label
    return '其他'


def rankdata(xs):
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(xs):
        j = i
        while j + 1 < len(xs) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def pearson(a, b):
    n = len(a)
    if n < 3:
        return None
    ma = sum(a) / n
    mb = sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((x - mb) ** 2 for x in b)
    if va <= 0 or vb <= 0:
        return None
    cov = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    return cov / math.sqrt(va * vb)


def spearman(a, b):
    return pearson(rankdata(a), rankdata(b))


# ---- 未来收益 ----
fwd = {}
all_dates = set()
for code, (name, by) in U.items():
    dates = sorted(by.keys())
    closes = [by[d]['c'] for d in dates]
    fmap = {}
    for i, d in enumerate(dates):
        all_dates.add(d)
        hh = {}
        for h in FWD_HORIZONS:
            hh[h] = (closes[i + h] / closes[i] - 1.0) if (i + h < len(dates) and closes[i] > 0) else None
        fmap[d] = hh
    fwd[code] = fmap

trading_days = sorted(all_dates)

# ---- 候选因子 ----
factor_names = set()
for code, (name, by) in U.items():
    for d, row in by.items():
        for k, v in row.items():
            if k in EXCLUDE or isinstance(v, bool):
                continue
            if isinstance(v, (int, float)):
                factor_names.add(k)
factor_names = sorted(factor_names)


def ic_stats(fac, h):
    daily = []
    for d in trading_days:
        xs, ys = [], []
        for code, (name, by) in U.items():
            row = by.get(d)
            if not row or fac not in row:
                continue
            fv = row[fac]
            if fv is None or isinstance(fv, bool) or not isinstance(fv, (int, float)):
                continue
            if math.isnan(fv) or math.isinf(fv):
                continue
            fr = fwd[code][d][h]
            if fr is None:
                continue
            xs.append(fv)
            ys.append(fr)
        if len(xs) >= MIN_NAMES_PER_DAY:
            ic = spearman(xs, ys)
            if ic is not None:
                daily.append(ic)
    if len(daily) < 30:
        return None
    n = len(daily)
    mean_ic = sum(daily) / n
    std = math.sqrt(sum((x - mean_ic) ** 2 for x in daily) / n) or 1e-9
    icir = mean_ic / std
    return {
        'days': n,
        'meanIc': round(mean_ic, 4),
        'icir': round(icir, 3),
        't': round(icir * math.sqrt(n), 2),
        'posRate': round(sum(1 for x in daily if x > 0) / n, 3),
    }


def cluster_of(name, ic5):
    if ic5 is not None and ic5['meanIc'] <= -0.02 and abs(ic5['t']) >= 2:
        return '反向信号'
    cat = categorize(name)
    if cat in ('横截面排名', '主题/板块宽度', '持续性主线'):
        return '横截面/主题强度'
    return '绝对趋势动量'


def strength(ic):
    if ic is None:
        return 'na'
    if abs(ic['t']) >= 3 and abs(ic['meanIc']) >= 0.03:
        return 'strong'
    if abs(ic['t']) >= 2 and abs(ic['meanIc']) >= 0.02:
        return 'ok'
    return 'weak'


catalog = []
for fac in factor_names:
    ic5 = ic_stats(fac, 5)
    ic10 = ic_stats(fac, 10)
    if ic5 is None and ic10 is None:
        continue
    doc = FACTOR_DOC.get(fac, {})
    cat = categorize(fac)
    direction = 'neg' if (ic10 and ic10['meanIc'] < 0) else 'pos'
    catalog.append({
        'name': fac,
        'cn': doc.get('cn', fac),
        'category': cat,
        'desc': doc.get('desc', CATEGORY_INTRO.get(cat, '')),
        'formula': doc.get('formula', ''),
        'direction': direction,
        'cluster': cluster_of(fac, ic5),
        'strength': strength(ic5),
        'ic5': ic5,
        'ic10': ic10,
    })

# 按 5 日 mean_ic 降序，便于前端默认排序
catalog.sort(key=lambda r: (r['ic5']['meanIc'] if r['ic5'] else -1), reverse=True)

# ---- 最新交易日快照 ----
last_day = trading_days[-1]
# 若最后一日数据稀疏，回退到覆盖最广的近一日
for cand in reversed(trading_days[-6:]):
    cover = sum(1 for code, (name, by) in U.items() if cand in by)
    if cover >= MIN_NAMES_PER_DAY:
        last_day = cand
        break

snapshot = []
snapshot_factors = [c['name'] for c in catalog]
for code, (name, by) in U.items():
    row = by.get(last_day)
    if not row:
        continue
    values = {}
    for fac in snapshot_factors:
        v = row.get(fac)
        if isinstance(v, bool) or v is None:
            continue
        if isinstance(v, (int, float)) and not (math.isnan(v) or math.isinf(v)):
            values[fac] = round(v, 6)
    snapshot.append({'code': code, 'name': name, 'values': values})

snapshot.sort(key=lambda r: r['name'])

now = datetime.now(timezone(timedelta(hours=8)))
artifact = {
    'meta': {
        'generatedAt': now.isoformat(),
        'sampleEtfCount': len(U),
        'tradingDays': len(trading_days),
        'factorCount': len(catalog),
        'snapshotDate': last_day,
        'horizons': FWD_HORIZONS,
        'categoryIntro': CATEGORY_INTRO,
        'caveats': [
            '全样本 IC，尚未做 walk-forward 样本外验证，绝对数值仅供横向比较。',
            '通过强信号门槛的因子彼此高度相关，真实独立信号约为三簇，不是同等数量的独立 alpha。',
            'IC 衡量「排对全场」的能力，与你单仓押龙头的回测口径不同：高 IC 适合分散多持仓，趋势质量族更擅长单仓主升捕捉。',
        ],
    },
    'catalog': catalog,
    'snapshot': snapshot,
}

os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
with open(OUT_PATH, 'w', encoding='utf-8') as f:
    json.dump(artifact, f, ensure_ascii=False, indent=2)

print(f'已写出 {OUT_PATH}')
print(f'  因子 {len(catalog)} 个 | 快照 {len(snapshot)} 只 ETF | 快照日 {last_day} | 交易日 {len(trading_days)}')
print(f'  强信号(5日) {sum(1 for c in catalog if c["strength"] == "strong")} | 反向簇 {sum(1 for c in catalog if c["cluster"] == "反向信号")}')
