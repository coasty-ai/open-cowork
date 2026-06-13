import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Logo } from '../src/index';

describe('Logo', () => {
  it('renders an accessible mark and the wordmark by default', () => {
    render(<Logo />);
    const mark = screen.getByRole('img', { name: 'open-cowork' });
    expect(mark.tagName.toLowerCase()).toBe('svg');
    // The wordmark text is present alongside the mark.
    expect(screen.getByText('open-cowork')).toBeInTheDocument();
  });

  it('omits the wordmark when withWordmark is false but keeps the mark', () => {
    render(<Logo withWordmark={false} />);
    expect(screen.getByRole('img', { name: 'open-cowork' })).toBeInTheDocument();
    expect(screen.queryByText('open-cowork')).not.toBeInTheDocument();
  });

  it('sizes the mark from the size prop', () => {
    render(<Logo size={40} withWordmark={false} />);
    const mark = screen.getByRole('img', { name: 'open-cowork' });
    expect(mark).toHaveAttribute('width', '40');
    expect(mark).toHaveAttribute('height', '40');
  });

  it('honors a custom accessible title', () => {
    render(<Logo title="open-cowork home" withWordmark={false} />);
    expect(screen.getByRole('img', { name: 'open-cowork home' })).toBeInTheDocument();
  });

  it('uses a unique gradient id per instance so multiple logos never collide', () => {
    const { container } = render(
      <>
        <Logo withWordmark={false} />
        <Logo withWordmark={false} />
      </>,
    );
    const gradients = container.querySelectorAll('linearGradient');
    expect(gradients).toHaveLength(2);
    const [a, b] = [gradients[0]!.id, gradients[1]!.id];
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toEqual(b);
    // Each circle references its own gradient by id.
    const circles = container.querySelectorAll('circle');
    expect(circles[0]!.getAttribute('fill')).toBe(`url(#${a})`);
    expect(circles[1]!.getAttribute('fill')).toBe(`url(#${b})`);
  });

  it('passes through a custom className on the wrapper', () => {
    const { container } = render(<Logo className="brand-x" withWordmark={false} />);
    expect(container.querySelector('.oc-logo.brand-x')).toBeInTheDocument();
  });
});
