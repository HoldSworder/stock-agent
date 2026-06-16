<script setup lang="ts">
import { ref } from 'vue';

type Section = 'short' | 'mid' | 'theme' | 'rotation';

const visible = ref(false);
const active = ref<Section>('short');

function open(section: Section = 'short') {
  active.value = section;
  visible.value = true;
}

defineExpose({ open });
</script>

<template>
  <el-drawer v-model="visible" title="强势方法论 · 指标口径" size="440px" direction="rtl">
    <div class="mt">
      <el-segmented
        v-model="active"
        :options="[
          { label: '短线强势', value: 'short' },
          { label: '中线强势', value: 'mid' },
          { label: '市场主线', value: 'theme' },
          { label: 'ETF轮动', value: 'rotation' },
        ]"
        block
      />

      <!-- 短线强势：选股 -->
      <section v-show="active === 'short'" class="sec">
        <h4>短线强势 · 选股 /screener</h4>
        <p class="lead">全市场横截面多因子，T+0 ~ 数日级。回答「今天哪些票短线强」。</p>
        <ul>
          <li><b>数据</b>当日全市场快照：涨幅、换手、量比、成交额、PE/PB、市值、所属行业。不取个股历史 K 线。</li>
          <li><b>三层漏斗</b>硬筛(L1 区间剔除) → 多因子打分(L2a 横截面) → 可选 LLM 横向排序。</li>
          <li><b>因子</b>动量 / 活跃度 / 流动性 / 题材热度 / 估值 / 市值，按策略权重加权出综合分。</li>
          <li><b>理想点</b>动量、活跃度用「理想点曲线」——距理想值越近分越高，<b>主动回避一字追涨</b>，不是越高越好。</li>
          <li><b>题材热度</b>所属行业当日涨幅榜 + 资金净流入榜热度，题材关键词命中再加分。</li>
        </ul>
        <p class="tip">综合分点开可见各因子「score×权重=贡献」；策略口径见结果头「硬筛口径」。</p>
      </section>

      <!-- 中线强势：大盘·行业中线强弱 -->
      <section v-show="active === 'mid'" class="sec">
        <h4>中线强势 · 大盘「行业中线强弱」Tab</h4>
        <p class="lead">均线趋势级，周 / 月级。回答「哪些行业、概念中线趋势强，该不该跟随」。</p>
        <ul>
          <li><b>取数面</b>东财行业 + 概念「今日涨幅榜 + 60日中线强势榜」合并去重，让多日强但今日平淡的板块也纳入，不只看当天。</li>
          <li><b>多日口径</b>60日涨幅(f24)为<b>板块级真实</b>多日强弱；20日动能 / 趋势 / 年线偏离为<b>龙头个股代理</b>（板块日 K 不可得时以领涨/龙头个股 K 线近似）。</li>
          <li><b>趋势分级</b>多头排列(现价≥MA20≥MA60≥MA250) / 趋势向上(现价&gt;MA60 且 MA20≥MA60) / 走弱(跌破 MA60 的 3%) / 震荡。</li>
          <li><b>强度 0-100</b>趋势基分(多头72 / 向上58 / 震荡44 / 走弱24) + 龙头动能 + 板块60日持续 + 年线偏离修正；动量排名按「龙头动能 0.6 + 板块60日 0.4」融合键，<b>非当日涨幅</b>。</li>
          <li><b>agent 过滤</b>「板块主线研判」读此确定性底稿，过滤出可信主线 / 值得跟踪行业 / 应剔除噪声，结论置于 Tab 顶部并进今日计划。</li>
        </ul>
        <p class="tip">强度数字点开可见趋势基分 / 龙头动能 / 板块60日持续 / 年线偏离四项构成，及趋势分级的均线依据。</p>
      </section>

      <!-- 市场主线：大盘·市场主线 Tab -->
      <section v-show="active === 'theme'" class="sec">
        <h4>市场主线 · 大盘「市场主线」Tab</h4>
        <p class="lead">以真实板块归并出「主线强弱」。回答「当前主线是谁、多强、退潮没」。</p>
        <ul>
          <li><b>主源</b>东财行业 / 概念「今日涨幅榜 + 60日中线强势榜」+ 主力净流入（今日排名分 + 资金净流入加成 + 60日中线加成合成强度，持续型主线不漏沉淀）。</li>
          <li><b>证据 overlay</b>复盘计划重点板块、热点话题仅为已有板块主线补证据（不再凭关键词凭空造主线，杜绝噪声）。</li>
          <li><b>多源叠加</b>强度取各源最高提示，每新增一个来源 +8 协同加成（0-100 裁剪）。</li>
          <li><b>退潮归档</b>按最近出现日空闲天数：≥5 天转「退潮中」，≥10 天「归档」，保留历史不删除。</li>
        </ul>
        <p class="tip">卡片的来源标签 + 证据要点即强度依据；Tab 顶部「板块主线研判」为 agent 过滤后的结论。</p>
      </section>

      <!-- ETF 行业轮动：ETF 页·行业轮动 Tab -->
      <section v-show="active === 'rotation'" class="sec">
        <h4>ETF 行业轮动 · ETF 页「行业轮动」Tab</h4>
        <p class="lead">中线赛道级，双周 / 月级。回答「哪些 ETF 赛道该进攻、该等回踩、该回避」。</p>
        <ul>
          <li><b>标的池</b>ETF 跟踪池 + 主题赛道代表 ETF（去重），覆盖宽基 / 科技 / 新能源 / 医药 / 红利等主流方向。</li>
          <li><b>相对强弱 RS</b>ETF 近 60 日收益 − 沪深300 近 60 日收益，正=跑赢基准才算真强（剔除「水涨船高」假强）。</li>
          <li><b>5 态</b>破位(跌破 MA60) / 过热(分位≥85 且年线偏离≥25% 且 20日陡升) / 加速(20日动能显著快于60日且 RS 为正) / 回踩(贴 MA20 且短期回落) / 上升。</li>
          <li><b>强度 0-100</b>状态基分(加速70 / 上升60 / 回踩52 / 过热40 / 破位22) + 相对强弱 RS + 双动量 + 主力净流入加成。</li>
          <li><b>agent 过滤</b>「ETF行业轮动研判」读此确定性轮动榜，过滤出该进攻 / 该等回踩 / 该回避赛道，结论置于 Tab 顶部并进今日计划第六源。</li>
        </ul>
        <p class="tip">纪律：涨幅靠后≠该卖（看趋势与 RS）；过热≠还能涨（应等回踩而非追高）；不读研报景气，只信确定性量价与资金。</p>
      </section>

      <!-- 我该看哪个 -->
      <section class="guide">
        <h4>我该看哪个</h4>
        <div class="guide-row"><span class="gk">想找今天的强势票</span><span class="gv">选股 /screener</span></div>
        <div class="guide-row"><span class="gk">判断行业/概念中线趋势</span><span class="gv">大盘 · 行业中线强弱</span></div>
        <div class="guide-row"><span class="gk">看当前主线与退潮</span><span class="gv">大盘 · 市场主线</span></div>
        <div class="guide-row"><span class="gk">看 ETF 赛道该进攻/回避</span><span class="gv">ETF · 行业轮动</span></div>
        <p class="note">确定性强弱均为代码层计算（均线 / 分位 / 理想点 / 动量 / 资金），可复现可审计；中线主线再经「板块主线研判」agent 过滤后进今日计划。</p>
      </section>
    </div>
  </el-drawer>
</template>

<style scoped>
.mt {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.sec h4,
.guide h4 {
  margin: 0 0 6px;
  font-size: 14px;
}
.lead {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: var(--el-text-color-secondary);
}
.sec ul {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sec li {
  font-size: 12.5px;
  line-height: 1.55;
}
.sec li b {
  color: var(--el-color-primary);
  margin-right: 4px;
}
.tip {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  padding: 8px 10px;
  border-radius: 6px;
}
.guide {
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 14px;
}
.guide-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12.5px;
  padding: 5px 0;
}
.gk {
  color: var(--el-text-color-regular);
}
.gv {
  color: var(--el-color-primary);
  font-weight: 600;
}
.note {
  margin: 10px 0 0;
  font-size: 11.5px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}
</style>
