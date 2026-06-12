/**
 * Complete typed surface of the Coasty Computer Use API.
 * Source of truth: https://coasty.ai/docs/llms.txt (snapshot 2026-06-11).
 *
 * Note on action params: the docs' Reference table and its code examples disagree on
 * some param names (`wait`: `ms` vs `seconds`; `key_press`: `key` vs `keys`; `scroll`:
 * `direction/amount` vs `clicks`; `drag`: `from_x…` vs `x1…`). We model both shapes and
 * provide {@link normalizeAction} to canonicalize to the Reference shape.
 */

// ── Engine / shared ───────────────────────────────────────────────────────────

export type CuaVersion = 'v1' | 'v3' | 'v4';

export type PredictStatus = 'continue' | 'done' | 'fail';

/** Usage block attached to billed inference responses. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  credits_charged: number;
  cost_cents: number;
}

/** Generic paginated list envelope (`GET /v1/runs`, etc.). */
export interface ListResponse<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
  request_id?: string;
}

// ── Actions ───────────────────────────────────────────────────────────────────

export type CuaActionType =
  | 'click'
  | 'type_text'
  | 'key_press'
  | 'key_combo'
  | 'scroll'
  | 'drag'
  | 'move'
  | 'wait'
  | 'done'
  | 'fail'
  | 'raw';

export interface ClickParams {
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
  clicks?: number;
}
export interface TypeTextParams {
  text: string;
}
/** Reference shape is `{key}`; examples use `{keys}` (array, pressed in order). */
export interface KeyPressParams {
  key?: string;
  keys?: string[] | string;
}
export interface KeyComboParams {
  keys: string[];
}
/** Reference shape `{x,y,direction,amount}`; examples use `{clicks}` (+up/−down). */
export interface ScrollParams {
  x?: number;
  y?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  clicks?: number;
}
/** Reference shape `{from_x,from_y,to_x,to_y}`; examples use `{x1,y1,x2,y2}`. */
export interface DragParams {
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  button?: 'left' | 'right' | 'middle';
}
export interface MoveParams {
  x: number;
  y: number;
}
/** Reference shape `{ms}`; examples use `{seconds}`. */
export interface WaitParams {
  ms?: number;
  seconds?: number;
}
export interface DoneParams {
  [key: string]: never;
}
export interface FailParams {
  reason?: string;
}
export interface RawParams {
  code: string;
}

export type CuaActionParamsMap = {
  click: ClickParams;
  type_text: TypeTextParams;
  key_press: KeyPressParams;
  key_combo: KeyComboParams;
  scroll: ScrollParams;
  drag: DragParams;
  move: MoveParams;
  wait: WaitParams;
  done: DoneParams;
  fail: FailParams;
  raw: RawParams;
};

/** A single GUI action returned by the model. */
export type CuaAction = {
  [K in CuaActionType]: {
    action_type: K;
    params: CuaActionParamsMap[K];
    description?: string;
    raw_code?: string;
  };
}[CuaActionType];

// ── Canonical (normalized) actions ────────────────────────────────────────────

export type CanonicalAction =
  | {
      action_type: 'click';
      x: number;
      y: number;
      button: 'left' | 'right' | 'middle';
      clicks: number;
    }
  | { action_type: 'type_text'; text: string }
  | { action_type: 'key_press'; keys: string[] }
  | { action_type: 'key_combo'; keys: string[] }
  | {
      action_type: 'scroll';
      x?: number;
      y?: number;
      direction: 'up' | 'down' | 'left' | 'right';
      amount: number;
    }
  | {
      action_type: 'drag';
      from_x: number;
      from_y: number;
      to_x: number;
      to_y: number;
      button: 'left' | 'right' | 'middle';
    }
  | { action_type: 'move'; x: number; y: number }
  | { action_type: 'wait'; ms: number }
  | { action_type: 'done' }
  | { action_type: 'fail'; reason?: string }
  | { action_type: 'raw'; code: string };

/**
 * Canonicalize any documented action-param variant to the Reference-table shape.
 * Throws on unknown action types so executors fail loudly instead of no-oping.
 */
export function normalizeAction(action: CuaAction): CanonicalAction {
  const p = action.params ?? {};
  switch (action.action_type) {
    case 'click': {
      const c = p as ClickParams;
      return {
        action_type: 'click',
        x: c.x,
        y: c.y,
        button: c.button ?? 'left',
        clicks: c.clicks ?? 1,
      };
    }
    case 'type_text':
      return { action_type: 'type_text', text: (p as TypeTextParams).text };
    case 'key_press': {
      const k = p as KeyPressParams;
      const keys =
        k.keys !== undefined
          ? Array.isArray(k.keys)
            ? k.keys
            : [k.keys]
          : k.key !== undefined
            ? [k.key]
            : [];
      return { action_type: 'key_press', keys };
    }
    case 'key_combo':
      return { action_type: 'key_combo', keys: (p as KeyComboParams).keys ?? [] };
    case 'scroll': {
      const s = p as ScrollParams;
      if (s.clicks !== undefined && s.direction === undefined) {
        // pyautogui convention: positive = up, negative = down
        return {
          action_type: 'scroll',
          x: s.x,
          y: s.y,
          direction: s.clicks >= 0 ? 'up' : 'down',
          amount: Math.abs(s.clicks),
        };
      }
      return {
        action_type: 'scroll',
        x: s.x,
        y: s.y,
        direction: s.direction ?? 'down',
        amount: s.amount ?? Math.abs(s.clicks ?? 3),
      };
    }
    case 'drag': {
      const d = p as DragParams;
      const from_x = d.from_x ?? d.x1;
      const from_y = d.from_y ?? d.y1;
      const to_x = d.to_x ?? d.x2;
      const to_y = d.to_y ?? d.y2;
      if (
        from_x === undefined ||
        from_y === undefined ||
        to_x === undefined ||
        to_y === undefined
      ) {
        throw new Error(
          'drag action missing coordinates (expected from_x/from_y/to_x/to_y or x1/y1/x2/y2)',
        );
      }
      return { action_type: 'drag', from_x, from_y, to_x, to_y, button: d.button ?? 'left' };
    }
    case 'move':
      return { action_type: 'move', x: (p as MoveParams).x, y: (p as MoveParams).y };
    case 'wait': {
      const w = p as WaitParams;
      const ms = w.ms ?? (w.seconds !== undefined ? w.seconds * 1000 : 1000);
      return { action_type: 'wait', ms };
    }
    case 'done':
      return { action_type: 'done' };
    case 'fail':
      return { action_type: 'fail', reason: (p as FailParams).reason };
    case 'raw':
      return { action_type: 'raw', code: (p as RawParams).code };
    default: {
      const unknown = action as { action_type: string };
      throw new Error(`Unknown action_type: ${unknown.action_type}`);
    }
  }
}

// ── Core inference: /v1/predict ───────────────────────────────────────────────

export interface TrajectoryStep {
  screenshot: string;
  actions?: CuaAction[];
  reasoning?: string;
}

export interface PredictRequest {
  screenshot: string;
  instruction: string;
  cua_version?: CuaVersion;
  system_prompt?: string | null;
  instructions?: string | null;
  screen_width?: number;
  screen_height?: number;
  trajectory?: TrajectoryStep[];
  max_actions?: number;
  tools?: string[] | null;
  include_reasoning?: boolean;
  include_raw_code?: boolean;
}

export interface PredictResponse {
  request_id: string;
  status: PredictStatus;
  reasoning?: string | null;
  actions: CuaAction[];
  raw_code?: string[];
  usage: Usage;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface CreateSessionRequest {
  cua_version?: CuaVersion;
  screen_width?: number;
  screen_height?: number;
  max_trajectory_length?: number;
  system_prompt?: string | null;
  instructions?: string | null;
  tools?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreateSessionResponse {
  session_id: string;
  cua_version: CuaVersion;
  screen_size: string;
  created_at: string;
  expires_at: string;
}

export interface SessionPredictRequest {
  screenshot: string;
  instruction: string;
  include_reasoning?: boolean;
  include_raw_code?: boolean;
}

export interface SessionPredictResponse {
  request_id: string;
  session_id: string;
  step: number;
  actions: CuaAction[];
  raw_code?: string[];
  reasoning?: string | null;
  status: PredictStatus;
  usage: Usage;
}

export interface SessionInfoResponse {
  session_id: string;
  cua_version: CuaVersion;
  screen_size: string;
  step_count: number;
  created_at: string;
  expires_at: string;
  total_credits_used: number;
}

// ── Ground / Parse / Models / Usage ───────────────────────────────────────────

export interface GroundRequest {
  screenshot: string;
  element: string;
  screen_width?: number;
  screen_height?: number;
}

export interface GroundResponse {
  x: number;
  y: number;
  usage: Usage;
}

export interface ParseRequest {
  code: string;
}

export interface ParseResponse {
  actions: CuaAction[];
}

export interface ModelsResponse {
  models: { id: string; description: string }[];
  cua_versions: { id: string; description: string; avg_step_time?: string; features?: string[] }[];
  action_types: string[];
}

export interface UsageResponse {
  period: string;
  total_requests: number;
  total_credits: number;
  total_cost_cents: number;
  breakdown: Record<string, { requests: number; credits: number }>;
  balance: number;
  wallet_balance_cents: number;
  wallet_balance_usd: number;
}

// ── Task Runs ─────────────────────────────────────────────────────────────────

export type RunStatus =
  | 'queued'
  | 'running'
  | 'awaiting_human'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export type OnAwaitingHuman = 'pause' | 'fail' | 'cancel';

export interface CreateRunRequest {
  machine_id: string;
  task: string;
  cua_version?: CuaVersion;
  instructions?: string | null;
  system_prompt?: string | null;
  max_steps?: number;
  deadline_seconds?: number | null;
  on_awaiting_human?: OnAwaitingHuman;
  awaiting_human_timeout_seconds?: number | null;
  webhook_url?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RunResult {
  passed: boolean;
  status: string;
  summary: string;
  verdict?: string;
}

export interface RunError {
  code: string;
  message: string;
}

/** The Run object (`agent.run`). `webhook_secret` is returned ONCE on create. */
export interface Run {
  id: string;
  object: 'agent.run';
  status: RunStatus;
  machine_id: string;
  task: string;
  cua_version: CuaVersion;
  instructions: string | null;
  max_steps: number;
  on_awaiting_human: OnAwaitingHuman;
  steps_completed: number;
  credits_charged: number;
  cost_cents: number;
  result: RunResult | null;
  error: RunError | null;
  awaiting_human_reason: string | null;
  metadata: Record<string, unknown> | null;
  webhook_url: string | null;
  webhook_secret?: string | null;
  created_at: string | null;
  started_at: string | null;
  awaiting_human_since: string | null;
  finished_at: string | null;
  request_id: string | null;
}

export interface ResumeRunRequest {
  note?: string;
}

// ── Run events (SSE) ──────────────────────────────────────────────────────────

export type RunEventType =
  | 'status'
  | 'text'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'awaiting_human'
  | 'resumed'
  | 'step'
  | 'billing'
  | 'error'
  | 'done';

export interface RunEvent<T = Record<string, unknown>> {
  seq: number;
  type: RunEventType | string;
  data: T;
  created_at?: string;
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

export type RunWebhookEventType =
  | 'run.awaiting_human'
  | 'run.succeeded'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.timed_out';

export interface RunWebhookPayload {
  event: RunWebhookEventType | string;
  run: Run;
  created_at?: string;
}

// ── Workflows (DSL version 2026-06-01) ───────────────────────────────────────

export type ConditionOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'gt'
  | 'lte'
  | 'gte'
  | 'contains'
  | 'truthy'
  | 'falsy'
  | 'exists'
  | 'and'
  | 'or'
  | 'not';

export type Condition =
  | { op: 'eq' | 'ne' | 'lt' | 'gt' | 'lte' | 'gte' | 'contains'; left: unknown; right: unknown }
  | { op: 'truthy' | 'falsy' | 'exists'; value: unknown }
  | { op: 'and' | 'or'; conditions: Condition[] }
  | { op: 'not'; condition: Condition };

export interface TaskStep {
  id: string;
  type: 'task';
  task: string;
  machine_id?: string;
  cua_version?: CuaVersion;
  instructions?: string;
  system_prompt?: string;
  max_steps?: number;
  save_as?: string;
  on_awaiting_human?: OnAwaitingHuman;
}
export interface AssertStep {
  id: string;
  type: 'assert';
  condition: Condition;
  message?: string;
}
export interface IfStep {
  id: string;
  type: 'if';
  condition: Condition;
  then: WorkflowStep[];
  else?: WorkflowStep[];
}
export interface LoopStep {
  id: string;
  type: 'loop';
  count?: number;
  while?: Condition;
  body: WorkflowStep[];
  max_iterations?: number;
}
export interface ParallelStep {
  id: string;
  type: 'parallel';
  branches: WorkflowStep[][];
}
export interface HumanApprovalStep {
  id: string;
  type: 'human_approval';
  message?: string;
  timeout_seconds?: number;
}
export interface RetryStep {
  id: string;
  type: 'retry';
  body: WorkflowStep[];
  max_attempts: number;
}
export interface SucceedStep {
  id: string;
  type: 'succeed';
  output?: Record<string, unknown>;
}
export interface FailStep {
  id: string;
  type: 'fail';
  message?: string;
}

export type WorkflowStep =
  | TaskStep
  | AssertStep
  | IfStep
  | LoopStep
  | ParallelStep
  | HumanApprovalStep
  | RetryStep
  | SucceedStep
  | FailStep;

export type WorkflowStepType = WorkflowStep['type'];

export interface WorkflowDefinition {
  steps: WorkflowStep[];
  output?: Record<string, unknown>;
}

/** Result a `task` step binds under its `save_as` / id. */
export interface TaskStepResult {
  status: string;
  passed: boolean;
  result: unknown;
  run_id: string;
  steps: number;
  error: RunError | null;
  /** Extension: cost attributed to this task (used for budget guards). */
  costCents?: number;
}

export interface InputsSchemaEntry {
  type: string;
  required?: boolean;
  default?: unknown;
}

export interface CreateWorkflowRequest {
  name: string;
  slug: string;
  definition: WorkflowDefinition;
  inputs_schema?: Record<string, InputsSchemaEntry> | object | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateWorkflowRequest {
  name?: string;
  definition?: WorkflowDefinition;
  inputs_schema?: Record<string, InputsSchemaEntry> | object | null;
  description?: string | null;
  status?: 'active' | 'archived';
  metadata?: Record<string, unknown> | null;
}

export interface Workflow {
  id: string;
  object: 'workflow';
  name: string;
  slug: string;
  version: number;
  dsl_version: string;
  definition: WorkflowDefinition;
  inputs_schema: Record<string, InputsSchemaEntry> | object | null;
  description: string | null;
  status: 'active' | 'archived';
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  request_id?: string | null;
}

export interface StartWorkflowRunRequest {
  inputs?: Record<string, unknown> | null;
  machine_id?: string | null;
  budget_cents?: number | null;
  max_iterations?: number | null;
  deadline_seconds?: number | null;
  webhook_url?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Ad-hoc runs only. */
  definition?: WorkflowDefinition | null;
  inputs_schema?: Record<string, InputsSchemaEntry> | object | null;
}

export type WorkflowRunStatus = RunStatus;

export interface WorkflowRun {
  id: string;
  object: 'workflow.run';
  status: WorkflowRunStatus;
  workflow_id: string | null;
  workflow_version: number | null;
  machine_id: string | null;
  inputs: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: RunError | null;
  awaiting_human_reason: string | null;
  awaiting_step_id: string | null;
  iterations_used: number;
  spent_cents: number;
  budget_cents: number;
  webhook_url?: string | null;
  webhook_secret?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  request_id: string | null;
}

export interface ResumeWorkflowRunRequest {
  approved: boolean;
  note?: string;
}

// ── Machines ──────────────────────────────────────────────────────────────────

export type MachineStatus =
  | 'creating'
  | 'running'
  | 'stopped'
  | 'stopping'
  | 'starting'
  | 'restarting'
  | 'suspended'
  | 'suspended_for_billing'
  | 'error'
  | 'terminated';

export type MachineOsType = 'linux' | 'windows';

export interface CreateMachineRequest {
  display_name: string;
  os_type?: MachineOsType;
  desktop_enabled?: boolean;
  provider?: 'aws' | 'azure' | 'auto';
  cpu_cores?: number | null;
  memory_gb?: number | null;
  storage_gb?: number | null;
  restore_from_snapshot?: boolean | null;
  ttl_minutes?: number | null;
  metadata?: Record<string, string> | null;
}

export interface Machine {
  id: string;
  display_name: string;
  status: MachineStatus;
  os_type: MachineOsType;
  provider: string;
  desktop_enabled: boolean;
  cpu_cores: number;
  memory_gb: number;
  storage_gb: number;
  public_ip: string | null;
  is_test: boolean;
  created_at: string;
  metadata: Record<string, string>;
  ttl_minutes?: number | null;
}

export interface MachineConnectionSummary {
  public_ip: string | null;
  ssh_port: number;
  ssh_username: string;
  vnc_port: number;
  websocket_port: number;
  has_ssh_key: boolean;
  has_vnc_password: boolean;
}

export interface CreateMachineResponse {
  machine: Machine;
  connection: MachineConnectionSummary;
  request_id: string;
}

export interface MachineConnectionDetails {
  ssh_private_key_pem: string;
  vnc_password: string;
  websocket_url: string;
  devtools_url: string;
}

export interface MachineLifecycleResponse {
  machine_id: string;
  status: string;
  message?: string;
  request_id: string;
}

export interface SnapshotResponse {
  machine_id: string;
  snapshot_id: string;
  name: string;
  created_at: string;
  credits_charged: number;
  request_id: string;
}

export interface MachineScreenshotResponse {
  machine_id: string;
  image_b64: string;
  mime_type: string;
  width: number;
  height: number;
  captured_at: string;
  request_id: string;
}

export interface MachineActionRequest {
  command: string;
  parameters?: Record<string, unknown>;
  timeout_ms?: number | null;
}

export interface MachineActionResponse {
  machine_id: string;
  command: string;
  success: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  duration_ms: number;
  screenshot: string | null;
  request_id: string;
}

export interface MachineActionsBatchRequest {
  steps: MachineActionRequest[];
  stop_on_error?: boolean;
}

export interface MachineActionsBatchResponse {
  machine_id: string;
  results: MachineActionResponse[];
  completed_count: number;
  failed_count: number;
  aborted: boolean;
  request_id: string;
}

export type MachineBrowserOp =
  | 'open'
  | 'navigate'
  | 'click'
  | 'type'
  | 'dom'
  | 'clickables'
  | 'state'
  | 'info'
  | 'scroll'
  | 'close'
  | 'screenshot'
  | 'wait'
  | 'list-tabs'
  | 'open-tab'
  | 'close-tab'
  | 'switch-tab';

export interface MachineTerminalRequest {
  command: string;
  timeout_ms?: number;
  session_id?: string | null;
  cwd?: string | null;
}

export interface MachineTerminalResponse {
  machine_id: string;
  output: string;
  exit_code: number;
  duration_ms?: number;
  session_id?: string | null;
  request_id: string;
}

export type MachineFileOp =
  | 'read'
  | 'exists'
  | 'list'
  | 'list-directory'
  | 'download'
  | 'list-downloads'
  | 'write'
  | 'edit'
  | 'append'
  | 'delete'
  | 'delete-directory';

export interface MachinePricingResponse {
  [key: string]: unknown;
}

// ── Error envelope ────────────────────────────────────────────────────────────

export type CoastyErrorCode =
  | 'INVALID_API_KEY'
  | 'INSUFFICIENT_SCOPE'
  | 'INSUFFICIENT_CREDITS'
  | 'WALLET_EXHAUSTED'
  | 'VALIDATION_ERROR'
  | 'INVALID_SCREENSHOT'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_LIMIT'
  | 'INVALID_STATUS_FILTER'
  | 'NOT_FOUND'
  | 'MACHINE_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'WORKFLOW_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'NOT_AWAITING_HUMAN'
  | 'RESUME_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'INVALID_STATE'
  | 'FEATURE_NOT_AVAILABLE'
  | 'INTERNAL_ERROR'
  | 'PREDICTION_FAILED'
  | 'GROUNDING_FAILED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'GUARD_EXCEEDED'
  | 'RATE_LIMITED'
  | 'INVALID_SIGNATURE'
  | (string & {});

export type CoastyErrorType =
  | 'auth_error'
  | 'billing_error'
  | 'validation_error'
  | 'not_found_error'
  | 'state_error'
  | 'rate_limit_error'
  | 'server_error'
  | (string & {});

export interface CoastyErrorBody {
  error: {
    code: CoastyErrorCode;
    message: string;
    type: CoastyErrorType;
    request_id: string;
    suggestion?: string;
    docs_url?: string;
    support?: string;
    required_scope?: string;
    current_scopes?: string[];
    required?: number;
    balance?: number;
    retry_after?: number;
    valid_options?: string[];
    examples?: unknown[];
    details?: unknown;
    current_state?: string;
    allowed_from?: string[];
    actual?: number;
    min?: number;
    max?: number;
  };
}
