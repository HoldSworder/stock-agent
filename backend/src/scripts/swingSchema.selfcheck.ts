// 波段模块建表自检：在**临时库**上跑一遍 migrate 的 DDL，确认表真的建得出来且列齐。
//
// 为什么要单独一条：生产靠 migrate.ts 的 DDL 字符串运行时自建表，不走 drizzle-kit。
// 也就是说 DDL 里的语法错误、与 schema.ts 的字段不一致，都不会被 tsc 发现——
// 只会在容器启动时炸，或者更糟：表建出来了但少一列，直到某次写入才报错。
//
// 判据：7 张表全部存在，且关键列一个不少。
// 用临时库而非生产库：自检不该有副作用，也不该依赖本机已有的库状态。
//
// 运行：cd backend && ./node_modules/.bin/tsx src/scripts/swingSchema.selfcheck.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

/** 期望的表与其关键列（与 schema.ts 保持一致） */
const EXPECT: ReadonlyArray<{ table: string; cols: readonly string[] }> = [
  {
    table: 'swing_rule_versions',
    cols: ['version', 'rule_hash', 'rule_manifest', 'activated_at', 'eligible_from_trade_date', 'status'],
  },
  {
    table: 'swing_runs',
    cols: ['id', 'trade_date', 'rule_version', 'mode', 'status', 'failures', 'data_as_of'],
  },
  {
    table: 'swing_snapshots',
    cols: [
      'id', 'run_id', 'trade_date', 'code', 'name', 'period', 'asset_type', 'track', 'category',
      'is_track_proxy', 'grade', 'divergence_strength', 'zone_low', 'zone_high',
      'initial_stop', 'atr14', 'close', 'watch_levels', 'rationale', 'bar_time',
      'market_phase', 'rule_version', 'rule_hash', 'validation_eligible', 'created_at',
    ],
  },
  {
    table: 'swing_advice_state',
    cols: [
      'id', 'code', 'name', 'source', 'rule_version', 'direction', 'status',
      'zone_low', 'zone_high', 'initial_stop', 'current_stop', 'layers', 'target_pct',
      'avg_cost', 'peak_price', 'first_r_hit', 'first_layer_trade_date', 'state_version',
    ],
  },
  {
    table: 'swing_advice_events',
    cols: ['id', 'state_id', 'code', 'kind', 'signal_key', 'pct_before', 'pct_after', 'price', 'reason', 'trade_date'],
  },
  {
    table: 'swing_validation_samples',
    cols: [
      'id', 'rule_version', 'rule_hash', 'code', 'direction', 'kind', 'event_key',
      'block_key', 'trade_date', 'bar_time', 'base_price', 'atr14', 'target_price',
      'invalid_price', 'market_phase', 'track', 'outcome',
    ],
  },
  {
    table: 'swing_validation_results',
    cols: [
      'id', 'rule_version', 'rule_hash', 'direction', 'verdict', 'event_count',
      'trade_date_count', 'block_count', 'real_rate', 'control_rate', 'edge',
      'edge_lower', 'shortfalls',
    ],
  },
];

const line = (s: string): void => console.log(s);

/** 从 migrate.ts 源码里抽出 DDL 字符串，避免 import 时连生产库 */
function readDdl(): string {
  const src = readFileSync(new URL('../db/migrate.ts', import.meta.url), 'utf8');
  const m = src.match(/const DDL = `([\s\S]*?)\n`;/);
  if (!m) throw new Error('未能从 migrate.ts 抽出 DDL 常量，正则需同步');
  return m[1];
}

function main(): void {
  let failed = 0;
  const dir = mkdtempSync(join(tmpdir(), 'swing-schema-'));
  const dbPath = join(dir, 'probe.db');
  try {
    const ddl = readDdl();
    const db = new Database(dbPath);
    db.exec(ddl);
    line('DDL 执行成功（无语法错误）');
    line('');

    for (const { table, cols } of EXPECT) {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (rows.length === 0) {
        line(`FAIL 表 ${table} 不存在`);
        failed += 1;
        continue;
      }
      const have = new Set(rows.map((r) => r.name));
      const missing = cols.filter((c) => !have.has(c));
      if (missing.length > 0) {
        line(`FAIL 表 ${table} 缺列 [${missing.join(', ')}]`);
        failed += 1;
      } else {
        line(`ok   表 ${table}（${rows.length} 列）`);
      }
    }

    // 幂等性：容器每次启动都会跑 DDL，必须能重复执行
    db.exec(ddl);
    line('');
    line('ok   DDL 重复执行无报错（幂等）');

    // 事件表的幂等键必须真的唯一，否则同一信号会重复建仓
    db.prepare(
      `INSERT INTO swing_advice_events (id, state_id, code, kind, signal_key, trade_date, rule_version, created_at)
       VALUES ('e1','s1','159516','open_layer1','k1','2026-09-04','v1','2026-09-04T15:40:00+08:00')`,
    ).run();
    let dupBlocked = false;
    try {
      db.prepare(
        `INSERT INTO swing_advice_events (id, state_id, code, kind, signal_key, trade_date, rule_version, created_at)
         VALUES ('e2','s1','159516','open_layer1','k1','2026-09-04','v1','2026-09-04T15:40:00+08:00')`,
      ).run();
    } catch {
      dupBlocked = true;
    }
    if (dupBlocked) {
      line('ok   同一 signal_key 的重复事件被唯一索引拦住');
    } else {
      line('FAIL 同一 signal_key 可重复插入，重启后会重复建仓');
      failed += 1;
    }

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  line('');
  line(failed === 0 ? 'PASS 建表自检通过' : `FAIL ${failed} 项不达标`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
