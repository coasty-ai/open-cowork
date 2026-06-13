/**
 * Machine routes: provision/manage Coasty cloud machines with spend safety
 * (confirmCostCents handshake + the $0.20 provisioning gate), live screenshot
 * proxy for the screen view, an allowlisted action passthrough for manual
 * takeover, and the inference proxy the desktop LocalExecutor loop uses.
 *
 * Terminal/file/raw-browser-JS commands are intentionally NOT exposed to
 * clients: they require elevated Coasty scopes and would widen the client
 * trust boundary (see SECURITY.md).
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  machineRuntimeCentsPerHour,
  PRICING,
  type CoastyClient,
  type Machine,
} from '@open-cowork/core';
import type { BackendConfig } from '../config';
import type { Db } from '../db';
import { AppError } from '../errors';

export interface MachineRouteDeps {
  config: BackendConfig;
  db: Db;
  coasty: CoastyClient;
}

/** Manual-takeover commands clients may send to a machine. Nothing else. */
const ALLOWED_COMMANDS = new Set([
  'click',
  'type',
  'key_press',
  'key_combo',
  'scroll',
  'drag',
  'move',
  'wait',
  'screenshot',
]);

export function registerMachineRoutes(app: FastifyInstance, deps: MachineRouteDeps): void {
  const { coasty } = deps;

  app.get('/api/machines', async () => {
    const res = await coasty.listMachines({ limit: 100 });
    const machines: Machine[] = Array.isArray((res as { data?: Machine[] }).data)
      ? (res as { data: Machine[] }).data
      : ((res as { machines?: Machine[] }).machines ?? []);
    return { machines };
  });

  app.get('/api/machines/pricing', async () => coasty.machinePricing());

  const createSchema = z.object({
    displayName: z.string().min(1).max(64),
    osType: z.enum(['linux', 'windows']).default('linux'),
    desktopEnabled: z.boolean().default(true),
    ttlMinutes: z.number().int().min(5).max(10080).optional(),
    /** Client must echo the first-hour running rate. */
    confirmCostCents: z.number().int(),
  });
  app.post('/api/machines', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const firstHourCents = machineRuntimeCentsPerHour(body.osType, 'running');
    if (body.confirmCostCents !== firstHourCents) {
      throw new AppError(409, 'ESTIMATE_CHANGED', 'Confirm the machine runtime rate', {
        expectedCents: firstHourCents,
        note: `${body.osType} machines bill ${firstHourCents}¢/hour while running, 1¢/hour stopped`,
      });
    }
    // Provisioning gate pre-flight ($0.20 documented minimum) — BEST-EFFORT.
    // The `usage` scope is not on a default key, so usage() may 403; never let
    // that block provisioning. Coasty enforces the $0.20 gate itself.
    try {
      const usage = await coasty.usage();
      const balance = usage.wallet_balance_cents ?? usage.balance;
      if (typeof balance === 'number' && balance < PRICING.provisioningGateCents) {
        throw new AppError(
          402,
          'INSUFFICIENT_CREDITS',
          'Provisioning requires a $0.20 wallet minimum',
          {
            balanceCents: balance,
            requiredCents: PRICING.provisioningGateCents,
          },
        );
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // usage() failed (e.g. missing `usage` scope) — skip the preflight.
    }
    const res = await coasty.createMachine(
      {
        display_name: body.displayName,
        os_type: body.osType,
        desktop_enabled: body.desktopEnabled,
        ttl_minutes: body.ttlMinutes ?? null,
      },
      { idempotencyKey: `cwk-machine-${randomUUID()}` },
    );
    void reply.status(201);
    return res;
  });

  app.get('/api/machines/:id', async (request) => {
    const { id } = request.params as { id: string };
    return coasty.getMachine(id);
  });

  app.post('/api/machines/:id/start', async (request) => {
    const { id } = request.params as { id: string };
    return coasty.startMachine(id);
  });

  app.post('/api/machines/:id/stop', async (request) => {
    const { id } = request.params as { id: string };
    return coasty.stopMachine(id);
  });

  app.delete('/api/machines/:id', async (request) => {
    const { id } = request.params as { id: string };
    return coasty.terminateMachine(id);
  });

  app.post('/api/machines/:id/snapshot', async (request) => {
    const { id } = request.params as { id: string };
    return coasty.snapshotMachine(id, { idempotencyKey: `cwk-snap-${randomUUID()}` });
  });

  app.get('/api/machines/:id/screenshot', async (request) => {
    const { id } = request.params as { id: string };
    return coasty.machineScreenshot(id);
  });

  const actionSchema = z.object({
    command: z.string().min(1).max(64),
    parameters: z.record(z.string(), z.unknown()).default({}),
  });
  app.post('/api/machines/:id/actions', async (request) => {
    const { id } = request.params as { id: string };
    const body = actionSchema.parse(request.body);
    if (!ALLOWED_COMMANDS.has(body.command)) {
      throw new AppError(
        403,
        'COMMAND_NOT_ALLOWED',
        `Command '${body.command}' is not exposed to clients`,
        {
          allowed: [...ALLOWED_COMMANDS],
        },
      );
    }
    return coasty.machineAction(id, { command: body.command, parameters: body.parameters });
  });

  // ── inference proxy (desktop local agent loop; key stays server-side) ──────
  const sessionSchema = z.object({
    cuaVersion: z.enum(['v1', 'v3', 'v4']).default('v3'),
    screenWidth: z.number().int().min(320).max(3840).default(1920),
    screenHeight: z.number().int().min(240).max(2160).default(1080),
    instructions: z.string().max(16000).optional(),
  });
  app.post('/api/proxy/sessions', async (request) => {
    const body = sessionSchema.parse(request.body);
    return coasty.createSession({
      cua_version: body.cuaVersion,
      screen_width: body.screenWidth,
      screen_height: body.screenHeight,
      instructions: body.instructions ?? null,
    });
  });

  const predictSchema = z.object({
    screenshot: z.string().min(100),
    instruction: z.string().min(1).max(16000),
  });
  app.post('/api/proxy/sessions/:id/predict', async (request) => {
    const { id } = request.params as { id: string };
    const body = predictSchema.parse(request.body);
    return coasty.sessionPredict(
      id,
      { screenshot: body.screenshot, instruction: body.instruction },
      { idempotencyKey: `cwk-step-${randomUUID()}` },
    );
  });

  app.delete('/api/proxy/sessions/:id', async (request) => {
    const { id } = request.params as { id: string };
    return coasty.deleteSession(id);
  });
}
