import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskComposer } from '../src/index';

const options = [
  { id: 'mch_test_1', label: 'invoice-bot (linux)' },
  { id: 'mch_test_2', label: 'qa-box (windows)' },
];

/** Pick a machine from the in-house dropdown: open the combobox, click an option. */
async function selectMachine(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole('combobox', { name: 'Machine' }));
  await user.click(await screen.findByRole('option', { name }));
}

describe('TaskComposer', () => {
  it('renders the task textarea, machine select, and disabled Submit', () => {
    render(<TaskComposer options={options} onSubmit={() => undefined} />);
    expect(screen.getByLabelText('Task')).toBeInTheDocument();
    expect(screen.getByLabelText('Machine')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('keeps Submit disabled until both task text and a machine are set', async () => {
    const user = userEvent.setup();
    render(<TaskComposer options={options} onSubmit={() => undefined} />);
    const submit = screen.getByRole('button', { name: 'Send' });

    await user.type(screen.getByLabelText('Task'), 'Download the latest invoice');
    expect(submit).toBeDisabled();

    await selectMachine(user, /invoice-bot/);
    expect(submit).toBeEnabled();
  });

  it('whitespace-only task does not enable Submit', async () => {
    const user = userEvent.setup();
    render(<TaskComposer options={options} onSubmit={() => undefined} />);
    await selectMachine(user, /invoice-bot/);
    await user.type(screen.getByLabelText('Task'), '   ');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('submits the trimmed task and machine id', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TaskComposer options={options} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('Task'), '  Open the billing page  ');
    await selectMachine(user, /qa-box/);
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      task: 'Open the billing page',
      machineId: 'mch_test_2',
    });
  });

  it('submits on Ctrl+Enter from the textarea', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TaskComposer options={options} defaultMachineId="mch_test_1" onSubmit={onSubmit} />);

    const textarea = screen.getByLabelText('Task');
    await user.type(textarea, 'Reconcile the invoice');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      task: 'Reconcile the invoice',
      machineId: 'mch_test_1',
    });
  });

  it('Ctrl+Enter does nothing while invalid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TaskComposer options={options} onSubmit={onSubmit} />);
    const textarea = screen.getByLabelText('Task');
    await user.click(textarea);
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables the whole form while pending', () => {
    render(<TaskComposer options={options} pending onSubmit={() => undefined} />);
    expect(screen.getByLabelText('Task')).toBeDisabled();
    expect(screen.getByLabelText('Machine')).toBeDisabled();
    const submit = screen.getByRole('button', { name: /send/i });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('aria-busy', 'true');
  });
});

describe('TaskComposer — screen selector (local multi-monitor)', () => {
  const localOptions = [
    { id: '__local__', label: 'This computer', local: true },
    { id: 'mch_1', label: 'cloud-vm (linux)' },
  ];
  const twoScreens = [
    { id: '1', label: 'Display 1 (primary)' },
    { id: '2', label: 'Display 2' },
  ];

  async function pickScreen(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
    await user.click(screen.getByRole('combobox', { name: 'Screen' }));
    await user.click(await screen.findByRole('option', { name }));
  }

  it('shows the screen selector for the local target when >1 screen', () => {
    render(
      <TaskComposer
        options={localOptions}
        defaultMachineId="__local__"
        screenOptions={twoScreens}
        defaultScreenId="1"
        onSubmit={() => undefined}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Screen' })).toBeInTheDocument();
  });

  it('hides the screen selector for a cloud target', async () => {
    const user = userEvent.setup();
    render(
      <TaskComposer
        options={localOptions}
        defaultMachineId="mch_1"
        screenOptions={twoScreens}
        defaultScreenId="1"
        onSubmit={() => undefined}
      />,
    );
    expect(screen.queryByRole('combobox', { name: 'Screen' })).not.toBeInTheDocument();
    // Switching to the local target reveals it.
    await user.click(screen.getByRole('combobox', { name: 'Machine' }));
    await user.click(await screen.findByRole('option', { name: /this computer/i }));
    expect(screen.getByRole('combobox', { name: 'Screen' })).toBeInTheDocument();
  });

  it('hides the screen selector when only one screen is available', () => {
    render(
      <TaskComposer
        options={localOptions}
        defaultMachineId="__local__"
        screenOptions={[twoScreens[0]!]}
        defaultScreenId="1"
        onSubmit={() => undefined}
      />,
    );
    expect(screen.queryByRole('combobox', { name: 'Screen' })).not.toBeInTheDocument();
  });

  it('submits the chosen screenId for a local run', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TaskComposer
        options={localOptions}
        defaultMachineId="__local__"
        screenOptions={twoScreens}
        defaultScreenId="1"
        onSubmit={onSubmit}
      />,
    );
    await user.type(screen.getByLabelText('Task'), 'tidy my desktop');
    await pickScreen(user, /Display 2/);
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith({
      task: 'tidy my desktop',
      machineId: '__local__',
      screenId: '2',
    });
  });

  it('omits screenId for a cloud run even if screens are provided', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <TaskComposer
        options={localOptions}
        defaultMachineId="mch_1"
        screenOptions={twoScreens}
        defaultScreenId="1"
        onSubmit={onSubmit}
      />,
    );
    await user.type(screen.getByLabelText('Task'), 'run in the cloud');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith({
      task: 'run in the cloud',
      machineId: 'mch_1',
      screenId: undefined,
    });
  });
});
