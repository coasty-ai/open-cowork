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
