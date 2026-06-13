import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Logo } from '../src/index';

describe('Logo', () => {
  it('renders an accessible mark and the wordmark by default', () => {
    const { container } = render(<Logo />);
    const mark = screen.getByRole('img', { name: 'Open Co-Work' });
    expect(mark.tagName.toLowerCase()).toBe('svg');
    // The wordmark lockup reads "Open Co-Work" (two-tone spans, aria-hidden as
    // the mark carries the accessible name).
    const word = container.querySelector('.oc-logo__word');
    expect(word?.textContent).toBe('Open Co-Work');
  });

  it('omits the wordmark when withWordmark is false but keeps the mark', () => {
    const { container } = render(<Logo withWordmark={false} />);
    expect(screen.getByRole('img', { name: 'Open Co-Work' })).toBeInTheDocument();
    expect(container.querySelector('.oc-logo__word')).toBeNull();
  });

  it('renders a wordmark-only lockup (no mark) when mark is false', () => {
    const { container } = render(<Logo mark={false} />);
    expect(container.querySelector('svg')).toBeNull();
    const word = container.querySelector('.oc-logo__word');
    expect(word?.textContent).toBe('Open Co-Work');
  });

  it('sizes the mark from the size prop', () => {
    render(<Logo size={40} withWordmark={false} />);
    const mark = screen.getByRole('img', { name: 'Open Co-Work' });
    expect(mark).toHaveAttribute('width', '40');
    expect(mark).toHaveAttribute('height', '40');
  });

  it('honors a custom accessible title', () => {
    render(<Logo title="Open Co-Work home" withWordmark={false} />);
    expect(screen.getByRole('img', { name: 'Open Co-Work home' })).toBeInTheDocument();
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
