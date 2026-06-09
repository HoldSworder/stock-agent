import { getValue } from '../settings';

// Telegram 推送。遵循用户偏好：
//   - 禁止 Markdown 表格（Telegram 渲染错位），用竖排清单
//   - 纯文本发送，避免 Markdown 转义问题

export async function sendTelegram(text: string): Promise<{ ok: boolean; message: string }> {
  const token = getValue('telegramBotToken');
  const chatId = getValue('telegramChatId');
  const threadId = getValue('telegramThreadId');
  if (!token || !chatId) {
    return { ok: false, message: 'Telegram 未配置（缺 bot token 或 chat id）' };
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (threadId) payload.message_thread_id = Number(threadId);

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { ok: boolean; description?: string };
    if (!data.ok) return { ok: false, message: data.description || '发送失败' };
    return { ok: true, message: '已推送 Telegram' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
