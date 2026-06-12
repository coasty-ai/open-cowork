import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalBar } from '../src/index';

describe('ApprovalBar', () => {
  it('shows the pause reason and the note textarea', () => {
    render(
      <ApprovalBar
        reason="Captcha needs a human"
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    );
    expect(screen.getByText('Captcha needs a human')).toBeInTheDocument();
    expect(screen.getByLabelText('Note')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('passes the typed note to onApprove', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalBar onApprove={onApprove} onReject={() => undefined} />);
    await user.type(screen.getByLabelText('Note'), 'Solved the captcha; continue');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledWith('Solved the captcha; continue');
  });

  it('passes the typed note to onReject', async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    render(<ApprovalBar onApprove={() => undefined} onReject={onReject} />);
    await user.type(screen.getByLabelText('Note'), 'Wrong invoice');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledWith('Wrong invoice');
  });

  it('approves with an empty note by default', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalBar onApprove={onApprove} onReject={() => undefined} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledWith('');
  });

  it('disables everything while pending', () => {
    render(<ApprovalBar pending onApprove={() => undefined} onReject={() => undefined} />);
    expect(screen.getByLabelText('Note')).toBeDisabled();
    const approve = screen.getByRole('button', { name: /approve/i });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });
});
