<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Warning, VideoPause, VideoPlay } from '@element-plus/icons-vue';
import { api } from '@/api';
import type { SafetyState } from '@stock-agent/shared';

/**
 * 安全总闸：急停 + 三个自动下单开关。
 *
 * 原先常驻驾驶舱第一屏。挪到设置页的理由是**它管的东西和你每天的交易无关**——
 * 这个闸只拦系统自己下的模拟单，你在券商里的真实持仓它一点都管不到。
 * 一个平时不需要碰、碰了也不影响今天买卖的东西，不该占着首屏最值钱的位置。
 *
 * 没有删：拉闸是出事时要立刻找得到的东西，所以留在设置页第一个 Tab 的最上方。
 */

const safety = ref<SafetyState | null>(null);
const acting = ref(false);

async function load(): Promise<void> {
  try {
    safety.value = await api.safety.state();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  }
}

onMounted(load);

async function doKill(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      '拉下安全总闸后，系统的自动模拟下单会全部停住。真实持仓不受影响，仍需你自己在券商处理。',
      '急停',
      { confirmButtonText: '拉闸', cancelButtonText: '取消', inputPlaceholder: '原因（可不填）' },
    );
    acting.value = true;
    safety.value = await api.safety.kill(value || undefined);
    ElMessage.success('已拉下安全总闸');
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}

async function doResume(): Promise<void> {
  try {
    await ElMessageBox.confirm('确认解除安全总闸？解除后将恢复受各自动开关约束的模拟下单。', '解除急停', {
      confirmButtonText: '解除',
      cancelButtonText: '取消',
    });
    acting.value = true;
    safety.value = await api.safety.resume();
    ElMessage.success('已解除安全总闸');
  } catch (e) {
    if (e !== 'cancel') ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}

/** 三个开关走同一条更新路径，只有字段与提示语不同 */
async function toggle(
  field: 'autoLocalSimEnabled' | 'autoExternalSimEnabled' | 'allowManualForceTrade',
  on: boolean,
  label: string,
): Promise<void> {
  try {
    acting.value = true;
    safety.value = await api.safety.update({ [field]: on });
    ElMessage.success(`${on ? '已开启' : '已关闭'}${label}`);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : String(e));
  } finally {
    acting.value = false;
  }
}
</script>

<template>
  <div v-if="safety" class="safety-bar" :class="{ killed: safety.killSwitch }">
    <div class="safety-state">
      <el-icon class="safety-ic">
        <Warning v-if="safety.killSwitch" />
        <VideoPlay v-else />
      </el-icon>
      <div>
        <div class="safety-title">
          {{ safety.killSwitch ? '安全总闸已拉下（急停中）' : '安全总闸正常' }}
          <!-- 必须点明管辖范围：这个闸只拦系统自己下的模拟单，
               券商里的真实持仓它一点都管不到。以为拉了闸就不用管止损，是会亏钱的误解 -->
          <span class="safety-scope">只管系统下的模拟单，管不到你在券商的真实持仓</span>
        </div>
        <div class="safety-meta">
          <span class="sw">
            自动本地模拟
            <el-switch
              :model-value="safety.autoLocalSimEnabled"
              :disabled="acting || safety.killSwitch"
              size="small"
              @change="(v: boolean) => toggle('autoLocalSimEnabled', v, '自动本地模拟')"
            />
          </span>
          <span class="sep">/</span>
          <span class="sw">
            自动外部模拟
            <el-switch
              :model-value="safety.autoExternalSimEnabled"
              :disabled="acting || safety.killSwitch"
              size="small"
              @change="(v: boolean) => toggle('autoExternalSimEnabled', v, '自动外部（妙想）模拟')"
            />
          </span>
          <span class="sep">/</span>
          <span class="sw">
            手动强制成交
            <el-switch
              :model-value="safety.allowManualForceTrade"
              :disabled="acting || safety.killSwitch"
              size="small"
              @change="(v: boolean) => toggle('allowManualForceTrade', v, '手动强制成交')"
            />
          </span>
          <span class="sep">/</span>
          <el-popover placement="bottom-start" :width="440" trigger="hover">
            <template #reference>
              <span class="gate-help">闸门流向 &amp; 全部开关位置 ⓘ</span>
            </template>
            <div class="gate-map">
              <div class="gm-title">自动模拟下单 —— 逐层放行（任一层关 = 拒单）</div>
              <ol>
                <li>① <b>未急停</b><span class="gm-loc">本页 · 急停按钮</span></li>
                <li>② <b>自动本地 / 外部模拟</b> 开<span class="gm-loc">本页 · 安全条开关</span></li>
                <li>
                  ③ <b>自动模拟总闸</b> + 该战法 <b>白名单</b> 同时开
                  <span class="gm-loc">「战法」页 · 总闸在「用之后的新数据检验」区，白名单在战法编辑弹窗</span>
                </li>
                <li>④ <b>交易日 + 交易时段</b><span class="gm-loc">系统自动判定，无开关</span></li>
              </ol>
              <div class="gm-title">手动强制成交（本页开关）</div>
              <div class="gm-note">
                仅放开「非交易日 / 非交易时段」校验，供收盘后按收盘价补录手动单；急停拉下时仍一票否决，与本闸无关。
              </div>
            </div>
          </el-popover>
          <template v-if="safety.killSwitch && safety.killReason">
            <span class="sep">/</span><span>原因 {{ safety.killReason }}</span>
          </template>
        </div>
        <div v-if="!safety.autoLocalSimEnabled" class="safety-hint">
          开启后，定时任务（尾盘 1445 / 妙想 0933）方可自动为本地战法账户建仓；还需在「中枢 · 调度」启用对应任务，并在「战法」页开自动模拟总闸 + 战法白名单。仅影响虚拟战法账户，绝不触及真实持仓。
        </div>
      </div>
    </div>
    <el-button
      v-if="!safety.killSwitch"
      type="danger"
      :icon="VideoPause"
      :loading="acting"
      @click="doKill"
    >
      急停
    </el-button>
    <el-button v-else type="success" :icon="VideoPlay" :loading="acting" @click="doResume">
      解除急停
    </el-button>
  </div>
</template>

<style scoped>
.safety-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  margin-bottom: 16px;
  border-radius: 8px;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
}
.safety-bar.killed {
  background: var(--el-color-danger-light-9);
  border-color: var(--el-color-danger-light-5);
}
.safety-state {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.safety-ic {
  margin-top: 2px;
  font-size: 20px;
}
.safety-title {
  font-weight: 600;
}
.safety-scope {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.safety-meta {
  margin-top: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.sw {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.sep {
  color: var(--el-border-color);
}
.gate-help {
  cursor: help;
  text-decoration: underline dotted;
}
.gate-map ol {
  margin: 4px 0;
  padding-left: 20px;
}
.gate-map li {
  margin-bottom: 4px;
}
.gm-title {
  font-weight: 600;
  margin-top: 6px;
}
.gm-loc {
  margin-left: 6px;
  color: var(--el-text-color-secondary);
}
.gm-note {
  color: var(--el-text-color-regular);
}
.safety-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
