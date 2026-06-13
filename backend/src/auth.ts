import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from './db/client';

// 全局访问密码：哈希存 SQLite settings 表，绝不进 getPublicSettings 明文视图。
// 登录换取无状态 token = sha256(存储哈希串)：重启不失效、改密自动失效。

const PASSWORD_KEY = 'auth_password';

/** 读取存储的密码哈希串（格式 salt:scryptHash，十六进制），未设置返回空串 */
function readStoredHash(): string {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, PASSWORD_KEY))
    .get();
  return row?.value ?? '';
}

/** 是否已设置访问密码（即是否开启鉴权） */
export function isAuthEnabled(): boolean {
  return readStoredHash().length > 0;
}

/** 设置 / 修改访问密码 */
export function setPassword(plain: string): void {
  const trimmed = plain.trim();
  if (!trimmed) throw new Error('密码不能为空');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(trimmed, salt, 64).toString('hex');
  const value = `${salt}:${hash}`;
  const now = new Date().toISOString();
  db.insert(schema.settings)
    .values({ key: PASSWORD_KEY, value, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value, updatedAt: now },
    })
    .run();
}

/** 校验明文密码是否匹配 */
export function verifyPassword(plain: string): boolean {
  const stored = readStoredHash();
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const computed = scryptSync(plain.trim(), salt, 64).toString('hex');
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 由当前存储哈希派生无状态访问 token */
export function issueToken(): string {
  const stored = readStoredHash();
  if (!stored) return '';
  return createHash('sha256').update(stored).digest('hex');
}

/** 校验访问 token 是否有效 */
export function verifyToken(token: string): boolean {
  const expected = issueToken();
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
