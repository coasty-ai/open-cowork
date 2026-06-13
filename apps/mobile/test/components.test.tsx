import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandLogo } from '../src/components';

describe('BrandLogo', () => {
  it('renders an accessible mark and the wordmark by default', () => {
    render(<BrandLogo />);
    expect(screen.getByRole('img', { name: 'Open Co-Work' })).toBeInTheDocument();
    // Two-tone lockup: the muted "Open" span sits before "Co-Work".
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('omits the wordmark when withWordmark is false but keeps the mark', () => {
    render(<BrandLogo withWordmark={false} />);
    expect(screen.getByRole('img', { name: 'Open Co-Work' })).toBeInTheDocument();
    expect(screen.queryByText('Open')).not.toBeInTheDocument();
  });

  it('builds the horizon mark from a stack of interpolated bands', () => {
    const { container } = render(<BrandLogo withWordmark={false} />);
    const mark = container.querySelector('[role="img"]')?.firstElementChild;
    expect(mark).toBeTruthy();
    // The six brand stops are interpolated into 16 bands.
    expect(mark!.childElementCount).toBe(16);
  });
});
