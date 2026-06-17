import type { DragonOverview, DragonStock } from '@stock-agent/shared';
import { getDragonRanking } from '../market/eastmoney';

// S6 龙头/连板梯队服务层：确定性组装龙头辨识总览（连板梯队 + 龙头分层），
// 纯只读、不下单、不调 LLM。数据源为东财涨停池（push2ex），龙头辨识为规则化合成。

/** 龙头梯队总览（确定性只读） */
export async function buildDragonOverview(): Promise<DragonOverview> {
  return getDragonRanking();
}

/** 龙头梯队文本摘要（注入 agent 研判/决策的确定性底稿） */
export function formatDragonForAgent(ov: DragonOverview): string {
  const lines: string[] = [
    `连板梯队龙头辨识（${ov.asOf.slice(0, 10)}${ov.stale ? '·数据降级' : ''}）`,
    `涨停 ${ov.limitUpCount} 只 ｜最高 ${ov.maxStreak} 连板 ｜炸板率 ${ov.brokenRate.toFixed(1)}%`,
  ];
  if (ov.topDragon) {
    const d = ov.topDragon;
    lines.push(
      `总龙头：${d.name}(${d.code}) ${d.streak}连板` +
        `${d.firstSealTime ? `·封板${d.firstSealTime}` : ''}` +
        `${d.sealFund != null ? `·封单${d.sealFund}亿` : ''}（龙头分${d.dragonScore}）`,
    );
  }
  for (const tier of ov.tiers.slice(0, 6)) {
    const top = tier.stocks
      .slice(0, 4)
      .map((s) => `${s.name}${s.role === '总龙头' ? '👑' : ''}(${s.dragonScore})`)
      .join(' ');
    lines.push(`${tier.streak}板×${tier.count}：${top}`);
  }
  return lines.join('\n');
}

/** 单只个股在梯队中的龙头状态文本（决策注入；不在涨停池返回提示） */
export function formatStockDragon(d: DragonStock | null): string {
  if (!d) return '该标的当日不在涨停梯队中。';
  return (
    `连板梯队定位：${d.name}(${d.code}) ${d.streak}连板 ｜角色【${d.role}】 ｜龙头分 ${d.dragonScore}` +
    `${d.firstSealTime ? ` ｜首封 ${d.firstSealTime}` : ''}` +
    `${d.sealFund != null ? ` ｜封单 ${d.sealFund}亿` : ''}` +
    `${d.turnoverRate != null ? ` ｜换手 ${d.turnoverRate.toFixed(2)}%` : ''}`
  );
}
