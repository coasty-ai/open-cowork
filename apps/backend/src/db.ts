/**
 * Persistence: a repository layer over `node:sqlite` (zero native deps — see
 * DECISIONS.md D4). Every table carries user_id so multi-user is a policy
 * change, not a schema change. Event streams get a per-stream monotonic `seq`
 * for SSE replay (`Last-Event-ID`).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface UserRow {
  id: string;
  email: string;
  budget_cents: number;
  created_at: string;
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  expires_at: number;
}

export interface RunRow {
  id: string;
  user_id: string;
  kind: 'coasty' | 'local';
  coasty_run_id: string | null;
  machine_id: string | null;
  task: string;
  status: string;
  cua_version: string;
  max_steps: number;
  budget_cents: number;
  cost_cents: number;
  steps_completed: number;
  result_json: string | null;
  error_json: string | null;
  awaiting_human_reason: string | null;
  webhook_secret: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface WorkflowRunRow {
  id: string;
  user_id: string;
  coasty_workflow_run_id: string;
  workflow_id: string | null;
  status: string;
  budget_cents: number;
  spent_cents: number;
  awaiting_step_id: string | null;
  webhook_secret: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface EventRow {
  stream_kind: string;
  stream_id: string;
  seq: number;
  type: string;
  data_json: string;
  created_at: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class Db {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        budget_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
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
      CREATE INDEX IF NOT EXISTS idx_runs_user ON runs(user_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_coasty ON runs(coasty_run_id) WHERE coasty_run_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        coasty_workflow_run_id TEXT NOT NULL UNIQUE,
        workflow_id TEXT,
        status TEXT NOT NULL,
        budget_cents INTEGER NOT NULL DEFAULT 0,
        spent_cents INTEGER NOT NULL DEFAULT 0,
        awaiting_step_id TEXT,
        webhook_secret TEXT,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        stream_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (stream_kind, stream_id, seq)
      );
    `);
  }

  close(): void {
    this.sql.close();
  }

  // ── users + sessions ────────────────────────────────────────────────────────

  upsertUser(email: string, defaultBudgetCents: number): UserRow {
    const existing = this.sql.prepare('SELECT * FROM users WHERE email = ?').get(email) as
      | UserRow
      | undefined;
    if (existing) return existing;
    const user: UserRow = {
      id: `usr_${randomUUID().slice(0, 8)}`,
      email,
      budget_cents: defaultBudgetCents,
      created_at: new Date().toISOString(),
    };
    this.sql
      .prepare('INSERT INTO users (id, email, budget_cents, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, user.email, user.budget_cents, user.created_at);
    return user;
  }

  getUser(id: string): UserRow | undefined {
    return this.sql.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  setUserBudget(id: string, budgetCents: number): void {
    this.sql.prepare('UPDATE users SET budget_cents = ? WHERE id = ?').run(budgetCents, id);
  }

  createSession(userId: string, token: string, ttlSeconds: number): void {
    this.sql
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), userId, Math.floor(Date.now() / 1000) + ttlSeconds);
  }

  /** Returns the user for a valid, unexpired token; undefined otherwise. */
  userForToken(token: string): UserRow | undefined {
    const row = this.sql
      .prepare('SELECT * FROM sessions WHERE token_hash = ?')
      .get(hashToken(token)) as SessionRow | undefined;
    if (!row) return undefined;
    if (row.expires_at < Math.floor(Date.now() / 1000)) {
      this.sql.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return undefined;
    }
    return this.getUser(row.user_id);
  }

  // ── runs ────────────────────────────────────────────────────────────────────

  insertRun(run: RunRow): void {
    this.sql
      .prepare(
        `INSERT INTO runs (id, user_id, kind, coasty_run_id, machine_id, task, status, cua_version,
          max_steps, budget_cents, cost_cents, steps_completed, result_json, error_json,
          awaiting_human_reason, webhook_secret, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.user_id,
        run.kind,
        run.coasty_run_id,
        run.machine_id,
        run.task,
        run.status,
        run.cua_version,
        run.max_steps,
        run.budget_cents,
        run.cost_cents,
        run.steps_completed,
        run.result_json,
        run.error_json,
        run.awaiting_human_reason,
        run.webhook_secret,
        run.created_at,
        run.finished_at,
      );
  }

  getRun(userId: string, id: string): RunRow | undefined {
    return this.sql.prepare('SELECT * FROM runs WHERE id = ? AND user_id = ?').get(id, userId) as
      | RunRow
      | undefined;
  }

  getRunByCoastyId(coastyRunId: string): RunRow | undefined {
    return this.sql.prepare('SELECT * FROM runs WHERE coasty_run_id = ?').get(coastyRunId) as
      | RunRow
      | undefined;
  }

  listRuns(userId: string, opts: { status?: string; limit?: number } = {}): RunRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    if (opts.status) {
      return this.sql
        .prepare(
          'SELECT * FROM runs WHERE user_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(userId, opts.status, limit) as unknown as RunRow[];
    }
    return this.sql
      .prepare('SELECT * FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, limit) as unknown as RunRow[];
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        RunRow,
        | 'status'
        | 'cost_cents'
        | 'steps_completed'
        | 'result_json'
        | 'error_json'
        | 'awaiting_human_reason'
        | 'finished_at'
      >
    >,
  ): void {
    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (fields.length === 0) return;
    const sets = fields.map((f) => `${f} = ?`).join(', ');
    const values = fields.map((f) => patch[f] ?? null);
    this.sql
      .prepare(`UPDATE runs SET ${sets} WHERE id = ?`)
      .run(...(values as (string | number | null)[]), id);
  }

  /** Total spend on runs for a user in the current calendar month (UTC). */
  monthSpendCents(userId: string): number {
    const monthPrefix = new Date().toISOString().slice(0, 7);
    const row = this.sql
      .prepare(
        `SELECT COALESCE(SUM(cost_cents), 0) AS total FROM runs WHERE user_id = ? AND created_at LIKE ?`,
      )
      .get(userId, `${monthPrefix}%`) as { total: number };
    return row.total;
  }

  // ── workflow runs ───────────────────────────────────────────────────────────

  insertWorkflowRun(row: WorkflowRunRow): void {
    this.sql
      .prepare(
        `INSERT INTO workflow_runs (id, user_id, coasty_workflow_run_id, workflow_id, status,
          budget_cents, spent_cents, awaiting_step_id, webhook_secret, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.user_id,
        row.coasty_workflow_run_id,
        row.workflow_id,
        row.status,
        row.budget_cents,
        row.spent_cents,
        row.awaiting_step_id,
        row.webhook_secret,
        row.created_at,
        row.finished_at,
      );
  }

  getWorkflowRun(userId: string, id: string): WorkflowRunRow | undefined {
    return this.sql
      .prepare('SELECT * FROM workflow_runs WHERE id = ? AND user_id = ?')
      .get(id, userId) as WorkflowRunRow | undefined;
  }

  getWorkflowRunByCoastyId(coastyId: string): WorkflowRunRow | undefined {
    return this.sql
      .prepare('SELECT * FROM workflow_runs WHERE coasty_workflow_run_id = ?')
      .get(coastyId) as WorkflowRunRow | undefined;
  }

  listWorkflowRuns(userId: string, limit = 50): WorkflowRunRow[] {
    return this.sql
      .prepare('SELECT * FROM workflow_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(userId, Math.min(Math.max(limit, 1), 200)) as unknown as WorkflowRunRow[];
  }

  updateWorkflowRun(
    id: string,
    patch: Partial<
      Pick<WorkflowRunRow, 'status' | 'spent_cents' | 'awaiting_step_id' | 'finished_at'>
    >,
  ): void {
    const fields = Object.keys(patch) as (keyof typeof patch)[];
    if (fields.length === 0) return;
    const sets = fields.map((f) => `${f} = ?`).join(', ');
    const values = fields.map((f) => patch[f] ?? null);
    this.sql
      .prepare(`UPDATE workflow_runs SET ${sets} WHERE id = ?`)
      .run(...(values as (string | number | null)[]), id);
  }

  // ── events ──────────────────────────────────────────────────────────────────

  /** Append an event; seq is assigned atomically per stream. Returns the seq. */
  appendEvent(streamKind: string, streamId: string, type: string, data: unknown): number {
    const row = this.sql
      .prepare(
        'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM events WHERE stream_kind = ? AND stream_id = ?',
      )
      .get(streamKind, streamId) as { maxSeq: number };
    const seq = row.maxSeq + 1;
    this.sql
      .prepare(
        'INSERT INTO events (stream_kind, stream_id, seq, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(streamKind, streamId, seq, type, JSON.stringify(data ?? {}), new Date().toISOString());
    return seq;
  }

  /** Insert an event with a KNOWN seq (mirroring upstream); ignores duplicates. */
  ingestEvent(
    streamKind: string,
    streamId: string,
    seq: number,
    type: string,
    data: unknown,
  ): boolean {
    const result = this.sql
      .prepare(
        'INSERT OR IGNORE INTO events (stream_kind, stream_id, seq, type, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(streamKind, streamId, seq, type, JSON.stringify(data ?? {}), new Date().toISOString());
    return result.changes > 0;
  }

  eventsAfter(streamKind: string, streamId: string, afterSeq: number): EventRow[] {
    return this.sql
      .prepare(
        'SELECT * FROM events WHERE stream_kind = ? AND stream_id = ? AND seq > ? ORDER BY seq ASC',
      )
      .all(streamKind, streamId, afterSeq) as unknown as EventRow[];
  }
}
