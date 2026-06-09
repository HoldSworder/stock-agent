import { desc, eq } from 'drizzle-orm';
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
