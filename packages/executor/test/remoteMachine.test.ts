import { describe, expect, it, vi } from 'vitest';
import type {
  MachineActionRequest,
  MachineActionResponse,
  MachineScreenshotResponse,
} from '@open-cowork/core';
import {
  RemoteMachineExecutor,
  UnsupportedActionError,
  type RemoteMachineTransport,
} from '../src/index';

function fakeTransport(failCommand?: string) {
  const actions: { machineId: string; req: MachineActionRequest }[] = [];
  let screenshotCalls = 0;
  const transport: RemoteMachineTransport = {
    async machineScreenshot(machineId): Promise<MachineScreenshotResponse> {
      screenshotCalls++;
      return {
        machine_id: machineId,
        image_b64: 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(100),
        mime_type: 'image/png',
        width: 1280,
        height: 720,
        captured_at: '2026-06-11T00:00:00Z',
        request_id: 'req_1',
      };
    },
    async machineAction(machineId, req): Promise<MachineActionResponse> {
      actions.push({ machineId, req });
      const failed = req.command === failCommand;
      return {
        machine_id: machineId,
        command: req.command,
        success: !failed,
        result: failed ? null : { ...req.parameters },
        error: failed ? 'simulated failure' : null,
        duration_ms: 5,
        screenshot: null,
        request_id: 'req_2',
      };
    },
  };
  return { transport, actions, screenshotCalls: () => screenshotCalls };
}

function executor(t: RemoteMachineTransport) {
  return new RemoteMachineExecutor({
    machineId: 'mch_test_1234',
    transport: t,
    sleep: async () => {},
  });
}

describe('RemoteMachineExecutor', () => {
  it('screenshot maps the documented response and caches dimensions', async () => {
    const { transport } = fakeTransport();
    const ex = executor(transport);
    const shot = await ex.screenshot();
    expect(shot.width).toBe(1280);
    expect(shot.height).toBe(720);
    expect(shot.base64.startsWith('iVBOR')).toBe(true);
    expect(await ex.dimensions()).toEqual({ width: 1280, height: 720 });
  });

  it('dimensions without prior screenshot takes one', async () => {
    const { transport, screenshotCalls } = fakeTransport();
    const ex = executor(transport);
    expect(await ex.dimensions()).toEqual({ width: 1280, height: 720 });
    expect(screenshotCalls()).toBe(1);
  });

  it('maps every action type to the documented machine commands', async () => {
    const { transport, actions } = fakeTransport();
    const ex = executor(transport);
    await ex.execute({
      action_type: 'click',
      params: { x: 10, y: 20, button: 'right', clicks: 2 },
    });
    await ex.execute({ action_type: 'type_text', params: { text: 'hello' } });
    await ex.execute({ action_type: 'key_press', params: { keys: ['tab', 'enter'] } });
    await ex.execute({ action_type: 'key_combo', params: { keys: ['ctrl', 'c'] } });
    await ex.execute({ action_type: 'scroll', params: { direction: 'down', amount: 3 } });
    await ex.execute({ action_type: 'drag', params: { from_x: 1, from_y: 2, to_x: 3, to_y: 4 } });
    await ex.execute({ action_type: 'move', params: { x: 7, y: 8 } });

    expect(actions.map((a) => a.req.command)).toEqual([
      'click',
      'type',
      'key_press', // tab
      'key_press', // enter — one call per key
      'key_combo',
      'scroll',
      'drag',
      'move',
    ]);
    expect(actions[0]!.req.parameters).toEqual({ x: 10, y: 20, button: 'right', clicks: 2 });
    expect(actions[2]!.req.parameters).toEqual({ key: 'tab' });
    expect(actions[3]!.req.parameters).toEqual({ key: 'enter' });
    expect(actions[4]!.req.parameters).toEqual({ keys: ['ctrl', 'c'] });
    expect(actions[5]!.req.parameters).toEqual({
      direction: 'down',
      amount: 3,
      x: undefined,
      y: undefined,
    });
    expect(actions[6]!.req.parameters).toEqual({
      from_x: 1,
      from_y: 2,
      to_x: 3,
      to_y: 4,
      button: 'left',
    });
    expect(actions.every((a) => a.machineId === 'mch_test_1234')).toBe(true);
  });

  it('wait sleeps locally without any remote call', async () => {
    const { transport, actions } = fakeTransport();
    const sleep = vi.fn(async () => {});
    const ex = new RemoteMachineExecutor({ machineId: 'm', transport, sleep });
    await ex.execute({ action_type: 'wait', params: { ms: 750 } });
    expect(sleep).toHaveBeenCalledWith(750);
    expect(actions).toHaveLength(0);
  });

  it('done/fail are signals, not remote calls', async () => {
    const { transport, actions } = fakeTransport();
    const ex = executor(transport);
    await ex.execute({ action_type: 'done', params: {} });
    await ex.execute({ action_type: 'fail', params: { reason: 'x' } });
    expect(actions).toHaveLength(0);
  });

  it('raw code execution is refused by policy', async () => {
    const { transport } = fakeTransport();
    const ex = executor(transport);
    await expect(
      ex.execute({ action_type: 'raw', params: { code: 'rm -rf /' } }),
    ).rejects.toBeInstanceOf(UnsupportedActionError);
  });

  it('a failed machine action surfaces as an error (no silent failure)', async () => {
    const { transport } = fakeTransport('click');
    const ex = executor(transport);
    await expect(ex.execute({ action_type: 'click', params: { x: 1, y: 2 } })).rejects.toThrow(
      /click.*simulated failure/,
    );
  });
});
