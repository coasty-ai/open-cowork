import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MachineCard } from '../src/index';
import type { MachineSummary } from '../src/index';

function machine(overrides: Partial<MachineSummary> = {}): MachineSummary {
  return {
    id: 'mch_test_a1b2c3d4',
    displayName: 'invoice-bot',
    status: 'running',
    osType: 'linux',
    centsPerHour: 5,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MachineCard', () => {
  it('renders the name, status, OS, and hourly rate', () => {
    render(<MachineCard machine={machine()} />);
    expect(screen.getByRole('heading', { name: 'invoice-bot' })).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Linux')).toBeInTheDocument();
    expect(screen.getByText('$0.05/hr')).toBeInTheDocument();
  });

  it('renders Windows machines with their rate', () => {
    render(<MachineCard machine={machine({ osType: 'windows', centsPerHour: 9 })} />);
    expect(screen.getByText('Windows')).toBeInTheDocument();
    expect(screen.getByText('$0.09/hr')).toBeInTheDocument();
  });

  it('enables Start only when stopped', () => {
    const { rerender } = render(<MachineCard machine={machine({ status: 'stopped' })} />);
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();

    rerender(<MachineCard machine={machine({ status: 'running' })} />);
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();

    rerender(<MachineCard machine={machine({ status: 'suspended_for_billing' })} />);
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });

  it('disables Terminate once terminated', () => {
    render(<MachineCard machine={machine({ status: 'terminated' })} />);
    expect(screen.getByRole('button', { name: 'Terminate' })).toBeDisabled();
  });

  it('calls onStart / onStop with the machine id', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <MachineCard machine={machine({ status: 'stopped' })} onStart={onStart} onStop={onStop} />,
    );
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(onStart).toHaveBeenCalledWith('mch_test_a1b2c3d4');

    rerender(
      <MachineCard machine={machine({ status: 'running' })} onStart={onStart} onStop={onStop} />,
    );
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledWith('mch_test_a1b2c3d4');
  });

  it('requires two clicks to terminate: arm, then confirm', async () => {
    const user = userEvent.setup();
    const onTerminate = vi.fn();
    render(<MachineCard machine={machine()} onTerminate={onTerminate} />);

    await user.click(screen.getByRole('button', { name: 'Terminate' }));
    expect(onTerminate).not.toHaveBeenCalled();

    const confirm = screen.getByRole('button', { name: 'Confirm terminate?' });
    await user.click(confirm);
    expect(onTerminate).toHaveBeenCalledWith('mch_test_a1b2c3d4');
    // Button disarms after confirming.
    expect(screen.getByRole('button', { name: 'Terminate' })).toBeInTheDocument();
  });

  it('disarms Terminate after 3 seconds without confirmation', () => {
    vi.useFakeTimers();
    const onTerminate = vi.fn();
    render(<MachineCard machine={machine()} onTerminate={onTerminate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Terminate' }));
    expect(screen.getByRole('button', { name: 'Confirm terminate?' })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(screen.getByRole('button', { name: 'Confirm terminate?' })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.getByRole('button', { name: 'Terminate' })).toBeInTheDocument();
    expect(onTerminate).not.toHaveBeenCalled();
  });
});
