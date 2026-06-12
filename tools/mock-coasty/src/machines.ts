/**
 * Machines: instant sandbox VMs for test keys, the $0.20 provisioning gate for
 * live keys, lifecycle transitions with documented INVALID_STATE semantics,
 * generated-PNG screenshots, an in-memory FS, and canned terminal/browser ops.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from './ctx';
import { bodyHash, generatePng, hex, nowIso, requestId, sendError } from './util';
import type { MachineRec } from './state';

const BROWSER_OPS = new Set([
  'open',
  'navigate',
  'click',
  'type',
  'dom',
  'clickables',
  'state',
  'info',
  'scroll',
  'close',
  'screenshot',
  'wait',
  'list-tabs',
  'open-tab',
  'close-tab',
  'switch-tab',
]);

function publicMachine(m: MachineRec): Record<string, unknown> {
  return {
    id: m.id,
    display_name: m.display_name,
    status: m.status,
    os_type: m.os_type,
    provider: m.provider,
    desktop_enabled: m.desktop_enabled,
    cpu_cores: m.cpu_cores,
    memory_gb: m.memory_gb,
    storage_gb: m.storage_gb,
    public_ip: m.public_ip,
    is_test: m.is_test,
    created_at: m.created_at,
    metadata: m.metadata,
    ttl_minutes: m.ttl_minutes,
  };
}

export function registerMachineRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { state } = ctx;

  function getMachineOr404(
    id: string,
    reply: Parameters<typeof sendError>[0],
  ): MachineRec | undefined {
    const machine = state.machines.get(id);
    if (!machine || machine.status === 'terminated') {
      void sendError(reply, 404, 'MACHINE_NOT_FOUND', `No machine '${id}' in this key's namespace`);
      return undefined;
    }
    return machine;
  }

  app.post('/v1/machines', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const displayName = body.display_name;
    if (typeof displayName !== 'string' || displayName.length === 0 || displayName.length > 64) {
      return sendError(reply, 422, 'VALIDATION_ERROR', 'display_name is required (1-64 chars)');
    }
    const osType = (body.os_type as string) ?? 'linux';
    if (!['linux', 'windows'].includes(osType)) {
      return sendError(reply, 422, 'VALIDATION_ERROR', "os_type must be 'linux' or 'windows'");
    }
    if (body.ttl_minutes !== undefined && body.ttl_minutes !== null) {
      const ttl = body.ttl_minutes;
      if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 5 || ttl > 10080) {
        return sendError(reply, 422, 'VALIDATION_ERROR', 'ttl_minutes must be an integer 5-10080');
      }
    }

    const idemHeader = request.headers['idempotency-key'];
    const idemKey = Array.isArray(idemHeader) ? idemHeader[0] : idemHeader;
    const hash = bodyHash(body);
    if (idemKey) {
      const existing = state.idempotency.get(`machines:${idemKey}`);
      if (existing) {
        if (existing.bodyHash !== hash) {
          return sendError(
            reply,
            422,
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was reused with a different body',
          );
        }
        void reply.header('X-Coasty-Idempotent-Replay', 'true');
        return reply.status(existing.status).send(existing.payload);
      }
    }

    const isTest = request.keyKind === 'test';
    if (!isTest && state.walletCents < 20) {
      return sendError(
        reply,
        402,
        'INSUFFICIENT_CREDITS',
        `Provisioning requires a wallet balance of at least 20 credits; you have ${state.walletCents}.`,
        {
          required: 20,
          balance: state.walletCents,
        },
      );
    }

    const machine: MachineRec = {
      id: isTest ? `mch_test_${hex(4)}` : randomUUID(),
      display_name: displayName,
      status: isTest ? 'running' : 'creating',
      os_type: osType as 'linux' | 'windows',
      provider: (body.provider as string) === 'azure' ? 'azure' : 'aws',
      desktop_enabled: Boolean(body.desktop_enabled ?? false),
      cpu_cores: (body.cpu_cores as number) ?? 2,
      memory_gb: (body.memory_gb as number) ?? 4,
      storage_gb: (body.storage_gb as number) ?? 20,
      public_ip: '203.0.113.7',
      is_test: isTest,
      created_at: nowIso(),
      metadata: (body.metadata as Record<string, string>) ?? {},
      ttl_minutes: (body.ttl_minutes as number | null) ?? null,
      files: new Map(),
      frame: 0,
    };
    state.machines.set(machine.id, machine);
    if (!isTest) {
      // Live provisioning becomes 'running' shortly after (simulated).
      const timer = state.addTimer(
        setTimeout(() => {
          if (machine.status === 'creating') machine.status = 'running';
          state.timers.delete(timer);
        }, ctx.opts.tickMs * 2),
      );
    }

    const payload = {
      machine: publicMachine(machine),
      connection: {
        public_ip: machine.public_ip,
        ssh_port: 22,
        ssh_username: machine.os_type === 'windows' ? 'Administrator' : 'ubuntu',
        vnc_port: 5900,
        websocket_port: 8080,
        has_ssh_key: true,
        has_vnc_password: true,
      },
      request_id: requestId(),
    };
    if (idemKey)
      state.idempotency.set(`machines:${idemKey}`, { bodyHash: hash, status: 201, payload });
    return reply.status(201).send(payload);
  });

  app.get('/v1/machines', async (request, reply) => {
    const query = request.query as { limit?: string };
    const limit = query.limit !== undefined ? Number(query.limit) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return sendError(reply, 400, 'INVALID_LIMIT', 'limit must be between 1 and 200', {
        actual: limit,
        min: 1,
        max: 200,
      });
    }
    const data = [...state.machines.values()]
      .filter((m) => m.status !== 'terminated')
      .slice(0, limit)
      .map(publicMachine);
    return { object: 'list', data, has_more: false, request_id: requestId() };
  });

  // Static route BEFORE /v1/machines/:id (documented route-order nuance).
  app.get('/v1/machines/pricing', async () => ({
    runtime_hourly_cents: {
      linux_running: 5,
      windows_running: 9,
      stopped: 1,
      creating: 0,
      terminated: 0,
    },
    one_time_cents: { snapshot: 1 },
    provisioning_gate_cents: 20,
    request_id: requestId(),
  }));

  app.get('/v1/machines/:id', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    return publicMachine(machine);
  });

  app.delete('/v1/machines/:id', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    machine.status = 'terminated';
    return {
      machine_id: machine.id,
      status: 'terminated',
      message: 'Machine terminated',
      request_id: requestId(),
    };
  });

  app.post('/v1/machines/:id/start', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    if (machine.status !== 'stopped') {
      return sendError(
        reply,
        409,
        'INVALID_STATE',
        `Cannot start a machine in state '${machine.status}'`,
        {
          current_state: machine.status,
          allowed_from: ['stopped'],
        },
      );
    }
    machine.status = 'running';
    return {
      machine_id: machine.id,
      status: 'running',
      message: 'Machine started',
      request_id: requestId(),
    };
  });

  app.post('/v1/machines/:id/stop', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    if (machine.status !== 'running') {
      return sendError(
        reply,
        409,
        'INVALID_STATE',
        `Cannot stop a machine in state '${machine.status}'`,
        {
          current_state: machine.status,
          allowed_from: ['running'],
        },
      );
    }
    machine.status = 'stopped';
    return {
      machine_id: machine.id,
      status: 'stopped',
      message: 'Machine stopped',
      request_id: requestId(),
    };
  });

  app.post('/v1/machines/:id/restart', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    if (machine.status !== 'running') {
      return sendError(
        reply,
        409,
        'INVALID_STATE',
        `Cannot restart a machine in state '${machine.status}'`,
        {
          current_state: machine.status,
          allowed_from: ['running'],
        },
      );
    }
    return {
      machine_id: machine.id,
      status: 'running',
      message: 'Machine restarted',
      request_id: requestId(),
    };
  });

  app.patch('/v1/machines/:id', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    const body = (request.body ?? {}) as { ttl_minutes?: unknown };
    const ttl = body.ttl_minutes;
    if (
      typeof ttl !== 'number' ||
      !Number.isInteger(ttl) ||
      (ttl !== 0 && (ttl < 5 || ttl > 10080))
    ) {
      return sendError(
        reply,
        422,
        'VALIDATION_ERROR',
        'ttl_minutes must be 0 (clear) or an integer 5-10080',
      );
    }
    machine.ttl_minutes = ttl === 0 ? null : ttl;
    return publicMachine(machine);
  });

  app.post('/v1/machines/:id/snapshot', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    if (request.keyKind !== 'test') {
      if (state.walletCents < 1) {
        return sendError(reply, 402, 'INSUFFICIENT_CREDITS', 'Snapshot needs 1 credit', {
          required: 1,
          balance: state.walletCents,
        });
      }
      state.walletCents -= 1;
      state.recordUsage('machines', 1);
      void reply.header('X-Credits-Charged', '1');
      void reply.header('X-Credits-Remaining', String(state.walletCents));
    } else {
      void reply.header('X-Credits-Charged', '0');
    }
    return {
      machine_id: machine.id,
      snapshot_id: `snap_${hex(4)}`,
      name: `${machine.display_name}-snapshot`,
      created_at: nowIso(),
      credits_charged: request.keyKind === 'test' ? 0 : 1,
      request_id: requestId(),
    };
  });

  app.get('/v1/machines/:id/screenshot', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    machine.frame++;
    const png = generatePng(320, 180, machine.frame);
    return {
      machine_id: machine.id,
      image_b64: png.toString('base64'),
      mime_type: 'image/png',
      width: 320,
      height: 180,
      captured_at: nowIso(),
      request_id: requestId(),
    };
  });

  app.get('/v1/machines/:id/connection', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    void reply.header('Cache-Control', 'no-store');
    return {
      ssh_private_key_pem:
        '-----BEGIN OPENSSH PRIVATE KEY-----\nMOCKMOCKMOCK\n-----END OPENSSH PRIVATE KEY-----',
      vnc_password: `vnc-${hex(4)}`,
      websocket_url: `ws://${machine.public_ip}:8080`,
      devtools_url: `http://${machine.public_ip}:9222`,
    };
  });

  function requireRunning(machine: MachineRec, reply: Parameters<typeof sendError>[0]): boolean {
    if (machine.status !== 'running') {
      void sendError(
        reply,
        409,
        'INVALID_STATE',
        `Machine is '${machine.status}', actions need 'running'`,
        {
          current_state: machine.status,
          allowed_from: ['running'],
        },
      );
      return false;
    }
    return true;
  }

  function runAction(
    machine: MachineRec,
    command: string,
    parameters: Record<string, unknown>,
  ): Record<string, unknown> {
    if (command === 'MOCK_ERROR') {
      return { success: false, result: null, error: 'mock action error' };
    }
    return { success: true, result: { success: true, ...parameters }, error: null };
  }

  app.post('/v1/machines/:id/actions', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    if (!requireRunning(machine, reply)) return reply;
    const body = (request.body ?? {}) as {
      command?: unknown;
      parameters?: Record<string, unknown>;
    };
    if (typeof body.command !== 'string' || body.command.length === 0) {
      return sendError(reply, 422, 'VALIDATION_ERROR', 'command is required');
    }
    const outcome = runAction(machine, body.command, body.parameters ?? {});
    return {
      machine_id: machine.id,
      command: body.command,
      ...outcome,
      duration_ms: 12,
      screenshot: null,
      request_id: requestId(),
    };
  });

  app.post('/v1/machines/:id/actions/batch', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    if (!requireRunning(machine, reply)) return reply;
    const body = (request.body ?? {}) as {
      steps?: { command: string; parameters?: Record<string, unknown> }[];
      stop_on_error?: boolean;
    };
    if (!Array.isArray(body.steps) || body.steps.length === 0 || body.steps.length > 50) {
      return sendError(reply, 422, 'VALIDATION_ERROR', 'steps must contain 1-50 actions');
    }
    const stopOnError = body.stop_on_error ?? true;
    const results: Record<string, unknown>[] = [];
    let failed = 0;
    let aborted = false;
    for (const step of body.steps) {
      const outcome = runAction(machine, step.command, step.parameters ?? {});
      results.push({
        machine_id: machine.id,
        command: step.command,
        ...outcome,
        duration_ms: 8,
        screenshot: null,
        request_id: requestId(),
      });
      if (!outcome.success) {
        failed++;
        if (stopOnError) {
          aborted = true;
          break;
        }
      }
    }
    return {
      machine_id: machine.id,
      results,
      completed_count: results.length - failed,
      failed_count: failed,
      aborted,
      request_id: requestId(),
    };
  });

  app.post('/v1/machines/:id/browser/:op', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    if (!requireRunning(machine, reply)) return reply;
    const { op } = request.params as { op: string };
    if (!BROWSER_OPS.has(op)) {
      return sendError(reply, 404, 'NOT_FOUND', `Unknown browser op '${op}'`, {
        valid_options: [...BROWSER_OPS],
      });
    }
    const body = (request.body ?? {}) as { parameters?: Record<string, unknown> };
    return {
      machine_id: machine.id,
      command: `browser_${op}`,
      success: true,
      result: { op, ...(body.parameters ?? {}) },
      error: null,
      duration_ms: 20,
      screenshot: null,
      request_id: requestId(),
    };
  });

  app.post('/v1/machines/:id/terminal', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    if (!requireRunning(machine, reply)) return reply;
    const body = (request.body ?? {}) as {
      command?: unknown;
      cwd?: string | null;
      session_id?: string | null;
    };
    if (
      typeof body.command !== 'string' ||
      body.command.length === 0 ||
      body.command.length > 8192
    ) {
      return sendError(reply, 422, 'VALIDATION_ERROR', 'command is required (1-8192 chars)');
    }
    let output: string;
    const echo = body.command.match(/^echo\s+(.+)$/);
    if (echo) output = echo[1]!;
    else if (body.command === 'pwd') output = body.cwd ?? '/home/ubuntu';
    else output = `mock: executed: ${body.command}`;
    return {
      machine_id: machine.id,
      output: output.slice(0, 5000),
      exit_code: 0,
      duration_ms: 15,
      session_id: body.session_id ?? null,
      request_id: requestId(),
    };
  });

  app.post('/v1/machines/:id/files/:op', async (request, reply) => {
    const machine = getMachineOr404((request.params as { id: string }).id, reply);
    if (!machine) return reply;
    const { op } = request.params as { op: string };
    const body = (request.body ?? {}) as { parameters?: Record<string, unknown> };
    const params = body.parameters ?? {};
    const path = typeof params.path === 'string' ? params.path : '';
    const files = machine.files;
    switch (op) {
      case 'write':
        files.set(path, String(params.content ?? ''));
        return { success: true, path, request_id: requestId() };
      case 'append':
        files.set(path, (files.get(path) ?? '') + String(params.content ?? ''));
        return { success: true, path, request_id: requestId() };
      case 'edit': {
        const current = files.get(path);
        if (current === undefined)
          return sendError(reply, 404, 'NOT_FOUND', `No file at '${path}'`);
        files.set(
          path,
          current.replace(String(params.old_text ?? ''), String(params.new_text ?? '')),
        );
        return { success: true, path, request_id: requestId() };
      }
      case 'read': {
        const content = files.get(path);
        if (content === undefined)
          return sendError(reply, 404, 'NOT_FOUND', `No file at '${path}'`);
        return { path, content, request_id: requestId() };
      }
      case 'exists':
        return { path, exists: files.has(path), request_id: requestId() };
      case 'list':
      case 'list-directory': {
        const prefix = path.endsWith('/') ? path : `${path}/`;
        const entries = [...files.keys()].filter((p) => p.startsWith(prefix) || p === path);
        return { path, entries, request_id: requestId() };
      }
      case 'delete': {
        if (!files.delete(path)) return sendError(reply, 404, 'NOT_FOUND', `No file at '${path}'`);
        return { success: true, path, request_id: requestId() };
      }
      case 'delete-directory': {
        const prefix = path.endsWith('/') ? path : `${path}/`;
        for (const key of [...files.keys()]) if (key.startsWith(prefix)) files.delete(key);
        return { success: true, path, request_id: requestId() };
      }
      case 'download':
      case 'list-downloads':
        return { path, downloads: [], request_id: requestId() };
      default:
        return sendError(reply, 404, 'NOT_FOUND', `Unknown file op '${op}'`);
    }
  });
}
