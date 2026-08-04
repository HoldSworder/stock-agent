import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import type { ChatMessage, ChatSession, MessageRole } from '@stock-agent/shared';
import { db, schema } from './db/client';
import { newId, nowIso } from './util';

export function listSessions(): ChatSession[] {
  return db
    .select()
    .from(schema.chatSessions)
    .orderBy(desc(schema.chatSessions.updatedAt))
    .all();
}

export function createSession(title = '新对话'): ChatSession {
  const id = newId();
  const now = nowIso();
  db.insert(schema.chatSessions)
    .values({ id, title, createdAt: now, updatedAt: now })
    .run();
  return { id, title, createdAt: now, updatedAt: now };
}

/** 取会话（含 refCode，用于 /ws/chat 判定是否为标的专属会话） */
export function getSession(id: string): ChatSession | undefined {
  return db.select().from(schema.chatSessions).where(eq(schema.chatSessions.id, id)).get();
}

/** 按 refCode 取标的专属会话（同 code 靠唯一索引保证至多一条，取最近更新的兜底历史脏数据） */
function findSymbolSession(code: string): ChatSession | undefined {
  return db
    .select()
    .from(schema.chatSessions)
    .where(eq(schema.chatSessions.refCode, code))
    .orderBy(desc(schema.chatSessions.updatedAt))
    .get();
}

/**
 * 标的专属长期跟踪会话：按 refCode find-or-create。
 * 标题固定为「代码 名称」，不被首轮提问覆盖，方便在 /chat 会话列表里认出来。
 */
export function getOrCreateSymbolSession(code: string, name = ''): ChatSession {
  const exist = findSymbolSession(code);
  if (exist) {
    // 名称后补（首次由代码唤起时可能拿不到名称），标题一并刷新
    if (name && exist.refName !== name) {
      const title = `${code} ${name}`;
      db.update(schema.chatSessions)
        .set({ refName: name, title })
        .where(eq(schema.chatSessions.id, exist.id))
        .run();
      return { ...exist, refName: name, title };
    }
    return exist;
  }
  const now = nowIso();
  const row = {
    id: newId(),
    title: name ? `${code} ${name}` : code,
    createdAt: now,
    updatedAt: now,
    refCode: code,
    refName: name || null,
  };
  // ref_code 上有唯一索引：并发下后到者插入冲突时静默跳过，再重查拿到先到者建的那条，
  // 避免同一标的建出两个会话（前端两处入口几乎同时唤起过）。
  db.insert(schema.chatSessions).values(row).onConflictDoNothing().run();
  return findSymbolSession(code) ?? row;
}

export function deleteSession(id: string): void {
  db.delete(schema.chatMessages).where(eq(schema.chatMessages.sessionId, id)).run();
  db.delete(schema.chatSessions).where(eq(schema.chatSessions.id, id)).run();
}

/**
 * 清理无任何消息的空壳会话。
 * 标的专属会话（refCode 非空）豁免：它由弹窗 find-or-create 先建后用，
 * 清掉会让前端持有的 sessionId 变成孤儿，消息落库却挂不上会话。
 */
export function pruneEmptySessions(): void {
  const withMessages = db
    .selectDistinct({ sessionId: schema.chatMessages.sessionId })
    .from(schema.chatMessages);
  db.delete(schema.chatSessions)
    .where(
      and(notInArray(schema.chatSessions.id, withMessages), isNull(schema.chatSessions.refCode)),
    )
    .run();
}

export function touchSession(id: string, title?: string): void {
  db.update(schema.chatSessions)
    .set({ updatedAt: nowIso(), ...(title ? { title } : {}) })
    .where(eq(schema.chatSessions.id, id))
    .run();
}

export function listMessages(sessionId: string): ChatMessage[] {
  return db
    .select()
    .from(schema.chatMessages)
    .where(eq(schema.chatMessages.sessionId, sessionId))
    .orderBy(schema.chatMessages.createdAt)
    .all()
    .map((m) => ({ ...m, role: m.role as MessageRole }));
}

export function addMessage(
  sessionId: string,
  role: MessageRole,
  content: string,
): ChatMessage {
  const id = newId();
  const now = nowIso();
  db.insert(schema.chatMessages)
    .values({ id, sessionId, role, content, createdAt: now })
    .run();
  return { id, sessionId, role, content, createdAt: now };
}
