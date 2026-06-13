import { getValue } from '../settings';

// Telegram 推送。遵循用户偏好：
//   - 禁止 Markdown 表格（Telegram 渲染错位），用竖排清单
//   - 纯文本发送，避免 Markdown 转义问题

// Telegram 单条消息上限 4096 字符，留余量按 4000 切分
const TG_LIMIT = 4000;

/** 按上限切分长文本，优先在换行边界切，避免单条超限被拒 */
function splitText(text: string, limit = TG_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    // 单行本身超长：先冲掉缓冲，再硬切该行
    if (line.length > limit) {
      if (buf) {
        chunks.push(buf);
        buf = '';
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (buf.length + line.length + 1 > limit) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export async function sendTelegram(text: string): Promise<{ ok: boolean; message: string }> {
  const token = getValue('telegramBotToken');
  const chatId = getValue('telegramChatId');
  const threadId = getValue('telegramThreadId');
  if (!token || !chatId) {
    return { ok: false, message: 'Telegram 未配置（缺 bot token 或 chat id）' };
  }

  const chunks = splitText(text);
  try {
    for (const chunk of chunks) {
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      };
      if (threadId) payload.message_thread_id = Number(threadId);

      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { ok: boolean; description?: string };
      if (!data.ok) return { ok: false, message: data.description || '发送失败' };
    }
    return { ok: true, message: `已推送 Telegram（${chunks.length} 条）` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
