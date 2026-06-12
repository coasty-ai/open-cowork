import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../src/index';

describe('Button', () => {
  it('renders an accessible button with type="button" by default', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toBeEnabled();
  });

  it('honors an explicit type', () => {
    render(<Button type="submit">Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveAttribute('type', 'submit');
  });

  it.each(['primary', 'secondary', 'danger', 'ghost'] as const)(
    'applies the %s variant class',
    (variant) => {
      render(<Button variant={variant}>X</Button>);
      expect(screen.getByRole('button')).toHaveClass(`oc-button--${variant}`);
    },
  );

  it.each(['sm', 'md'] as const)('applies the %s size class', (size) => {
    render(<Button size={size}>X</Button>);
    expect(screen.getByRole('button')).toHaveClass(`oc-button--${size}`);
  });

  it('fires onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Tap</Button>);
    await user.click(screen.getByRole('button', { name: 'Tap' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('loading renders an inline spinner, sets aria-busy, and disables', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Saving
      </Button>,
    );
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(within(button).getByRole('status')).toBeInTheDocument();
    await user.click(button).catch(() => undefined);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('respects an explicit disabled prop', () => {
    render(<Button disabled>Nope</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
