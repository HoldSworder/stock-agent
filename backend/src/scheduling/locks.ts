import { and, eq, lte } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { nowIso } from '../util';

// 作业互斥锁：基于 SQLite 主键唯一约束实现的轻量分布式锁，防止同一 key 的任务被
// 中央调度 / 模块调度 / 手动触发等多入口在同一时间窗并发重复执行（重复研判 / 重复推送 / 重复模拟交易）。
// croner 的 protect 只能防单进程内同一 job 重入；本锁覆盖跨入口、跨进程（dev 双开）场景。

/** 尝试获取锁：成功返回 true。已被未过期的锁占用则返回 false（不阻塞、不重试）。 */
function acquire(key: string, owner: string, ttlSec: number): boolean {
  const now = new Date();
  const nowStr = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSec * 1000).toISOString();

  // 先清理已过期的同 key 锁，避免持有者异常退出后死锁
  db.delete(schema.jobLocks)
    .where(and(eq(schema.jobLocks.lockKey, key), lte(schema.jobLocks.expiresAt, nowStr)))
    .run();

  try {
    const res = db
      .insert(schema.jobLocks)
      .values({ lockKey: key, owner, expiresAt, createdAt: nowStr })
      .onConflictDoNothing()
      .run();
    // better-sqlite3 driver: changes=1 表示插入成功（抢到锁），=0 表示已被占用
    return (res as { changes?: number }).changes === 1;
  } catch {
    return false;
  }
}

/** 释放锁（仅释放自己持有的，避免误删他人抢占的同 key 锁） */
function release(key: string, owner: string): void {
  db.delete(schema.jobLocks)
    .where(and(eq(schema.jobLocks.lockKey, key), eq(schema.jobLocks.owner, owner)))
    .run();
}

/**
 * 在互斥锁保护下执行 fn。抢锁成功才执行并返回结果；未抢到（同 key 在跑）返回 null 并跳过。
 * ttlSec 应略大于任务最长预期运行时长，过期后允许抢占以防死锁。
 */
export async function withJobLock<T>(
  key: string,
  opts: { owner: string; ttlSec: number },
  fn: () => Promise<T>,
): Promise<T | null> {
  if (!acquire(key, opts.owner, opts.ttlSec)) {
    console.warn(`[lock] 作业 ${key} 已在运行（owner=${opts.owner} 未抢到锁），跳过本次触发`);
    return null;
  }
  try {
    return await fn();
  } finally {
    release(key, opts.owner);
  }
}
