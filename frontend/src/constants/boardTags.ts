import type {
  BoardActionTag,
  BoardExposureStatus,
  BoardMainlineStage,
  BoardStageAction,
} from '@stock-agent/shared';

// 板块作战台标签的语义色单一来源（避免驾驶舱 / 作战台 / 暴露面板各写一份而漂移）。
// 动作标签遵循 A 股「红=积极/进攻，绿=消极/防守」：进攻类 danger(红)、防守类 success(绿)、中性 warning/info。
// 状态标签为「风险语义色」（非涨跌色）：在主线=success、退潮=warning、拥挤=danger、无关联=info。

/** el-tag 语义类型 */
export type ElTagType = 'success' | 'warning' | 'danger' | 'info' | 'primary';

/** 操盘动作标签 → el-tag 语义色（单一来源） */
export const ACTION_TAG_TYPE: Record<BoardActionTag, ElTagType> = {
  加仓候选: 'danger',
  试错: 'danger',
  持有: 'warning',
  观察: 'info',
  等待: 'info',
  减仓: 'success',
  回避: 'success',
};

/** 主线生命周期阶段 → 展示文案（来自 breadth 确定性锚） */
export const STAGE_LABEL: Record<BoardMainlineStage, string> = {
  advancing: '主升',
  brewing: '酝酿',
  diverging: '分歧',
  fading: '退幕',
  none: '未达标',
};

/**
 * 阶段允许的开仓动作 → 展示文案（硬路由）。
 * 只收紧不放大：酝酿只给试仓额度，主升才允许追领涨，分歧一律只减不加，退幕只退出。
 */
export const STAGE_ACTION_LABEL: Record<BoardStageAction, string> = {
  lead: '可追领涨',
  probe: '可试仓',
  hold_only: '只减不加',
  exit_only: '只退出',
  none: '不参与',
};

/** 暴露状态 → 展示文案 */
export const EXPO_STATUS_LABEL: Record<BoardExposureStatus, string> = {
  mainline: '在主线',
  fading: '退潮',
  crowded: '拥挤',
  none: '无主线',
};

/** 暴露状态 → 风险语义色（非涨跌色：在主线=success 稳、退潮=warning、拥挤=danger 需警惕） */
export const EXPO_STATUS_TYPE: Record<BoardExposureStatus, ElTagType> = {
  mainline: 'success',
  fading: 'warning',
  crowded: 'danger',
  none: 'info',
};
