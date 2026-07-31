/**
 * Schema migration on an EXISTING database.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op once a table exists, so every column
 * added after the first release has to be ALTERed in explicitly. Without that,
 * an upgraded install reads and writes columns that are not there — which
 * surfaces as a SQLite error on the first task, not at boot. This suite runs
 * the real `Db` constructor against a database created by the OLD schema.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, type RunRow } from '../src/db';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The `runs` table exactly as it shipped BEFORE task support. */
const OLD_RUNS_SCHEMA = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
    budget_cents INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    coasty_run_id TEXT,
    machine_id TEXT,
    task TEXT NOT NULL,
    status TEXT NOT NULL,
    cua_version TEXT NOT NULL,
    max_steps INTEGER NOT NULL,
    budget_cents INTEGER NOT NULL,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    steps_completed INTEGER NOT NULL DEFAULT 0,
    result_json TEXT,
    error_json TEXT,
    awaiting_human_reason TEXT,
    webhook_secret TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
`;

function legacyDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cowork-migrate-'));
  dirs.push(dir);
  const path = join(dir, 'cowork.sqlite');
  const raw = new DatabaseSync(path);
  raw.exec(OLD_RUNS_SCHEMA);
  raw
    .prepare('INSERT INTO users (id, email, budget_cents, created_at) VALUES (?, ?, ?, ?)')
    .run('usr_old', 'old@example.com', 500, '2026-01-01T00:00:00.000Z');
  raw
    .prepare(
      `INSERT INTO runs (id, user_id, kind, coasty_run_id, machine_id, task, status,
        cua_version, max_steps, budget_cents, cost_cents, steps_completed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'r_legacy',
      'usr_old',
      'coasty',
      'run_legacy',
      'mch_legacy',
      'an older run',
      'succeeded',
      'v3',
      25,
      500,
      15,
      3,
      '2026-01-01T00:00:00.000Z',
    );
  raw.close();
  return path;
}

const newRow = (over: Partial<RunRow> = {}): RunRow => ({
  id: 'r_new',
  user_id: 'usr_old',
  kind: 'task',
  coasty_run_id: 'run_new',
  machine_id: null,
  task: 'a managed task',
  status: 'queued',
  cua_version: 'v5',
  max_steps: 150,
  budget_cents: 500,
  cost_cents: 0,
  steps_completed: 0,
  result_json: null,
  error_json: null,
  awaiting_human_reason: null,
  webhook_secret: null,
  created_at: '2026-07-30T00:00:00.000Z',
  finished_at: null,
  machine_json: JSON.stringify({
    mode: 'automatic',
    status: 'provisioning',
    id: null,
    cleanup: 'always',
    cleanup_status: 'pending',
  }),
  deadline_seconds: 3600,
  action_policy_json: JSON.stringify({ max_actions: 5 }),
  ...over,
});

describe('Db migration onto a pre-task database', () => {
  it('adds the new columns instead of failing to boot', () => {
    const path = legacyDbPath();
    const db = new Db(path);
    try {
      const columns = (
        db.sql.prepare('PRAGMA table_info(runs)').all() as unknown as { name: string }[]
      ).map((c) => c.name);
      expect(columns).toContain('machine_json');
      expect(columns).toContain('deadline_seconds');
      expect(columns).toContain('action_policy_json');
    } finally {
      db.close();
    }
  });

  it('preserves existing rows, with the new columns reading as null', () => {
    const path = legacyDbPath();
    const db = new Db(path);
    try {
      const row = db.getRun('usr_old', 'r_legacy');
      expect(row?.task).toBe('an older run');
      expect(row?.cost_cents).toBe(15);
      expect(row?.machine_json ?? null).toBeNull();
      expect(row?.deadline_seconds ?? null).toBeNull();
      expect(row?.action_policy_json ?? null).toBeNull();
    } finally {
      db.close();
    }
  });

  it('accepts a task run written by the new code', () => {
    const path = legacyDbPath();
    const db = new Db(path);
    try {
      db.insertRun(newRow());
      const row = db.getRun('usr_old', 'r_new');
      expect(row?.kind).toBe('task');
      expect(row?.deadline_seconds).toBe(3600);
      expect(JSON.parse(row!.machine_json!)).toMatchObject({ cleanup_status: 'pending' });
      expect(JSON.parse(row!.action_policy_json!)).toEqual({ max_actions: 5 });
    } finally {
      db.close();
    }
  });

  it('is idempotent — re-opening the same database does not re-ALTER or throw', () => {
    const path = legacyDbPath();
    new Db(path).close();
    const second = new Db(path);
    try {
      const columns = (
        second.sql.prepare('PRAGMA table_info(runs)').all() as unknown as { name: string }[]
      ).map((c) => c.name);
      // Exactly one of each, not duplicated by a second ALTER.
      expect(columns.filter((c) => c === 'machine_json')).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('can update machine_id and machine_json on an existing task run', () => {
    // The provisioning reconcile does exactly this, and it is the write that
    // would have blown up on an unmigrated database.
    const path = legacyDbPath();
    const db = new Db(path);
    try {
      db.insertRun(newRow());
      db.updateRun('r_new', {
        machine_id: 'mch_provisioned',
        machine_json: JSON.stringify({
          mode: 'automatic',
          status: 'released',
          id: 'mch_provisioned',
          cleanup: 'always',
          cleanup_status: 'terminated',
        }),
      });
      const row = db.getRun('usr_old', 'r_new');
      expect(row?.machine_id).toBe('mch_provisioned');
      expect(JSON.parse(row!.machine_json!).cleanup_status).toBe('terminated');
    } finally {
      db.close();
    }
  });
});

describe('Db migration on a fresh database', () => {
  it('creates the columns up front, with no ALTER needed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cowork-fresh-'));
    dirs.push(dir);
    const db = new Db(join(dir, 'new.sqlite'));
    try {
      db.upsertUser('fresh@example.com', 500);
      const columns = (
        db.sql.prepare('PRAGMA table_info(runs)').all() as unknown as { name: string }[]
      ).map((c) => c.name);
      expect(columns).toEqual(expect.arrayContaining(['machine_json', 'deadline_seconds']));
    } finally {
      db.close();
    }
  });
});
