import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandLogo } from '../src/components';

describe('BrandLogo', () => {
  it('renders an accessible mark and the wordmark by default', () => {
    render(<BrandLogo />);
    expect(screen.getByRole('img', { name: 'open-cowork' })).toBeInTheDocument();
    expect(screen.getByText('open-cowork')).toBeInTheDocument();
  });

  it('omits the wordmark when withWordmark is false but keeps the mark', () => {
    render(<BrandLogo withWordmark={false} />);
    expect(screen.getByRole('img', { name: 'open-cowork' })).toBeInTheDocument();
    expect(screen.queryByText('open-cowork')).not.toBeInTheDocument();
  });

  it('builds the horizon mark from a stack of interpolated bands', () => {
    const { container } = render(<BrandLogo withWordmark={false} />);
    const mark = container.querySelector('[role="img"]')?.firstElementChild;
    expect(mark).toBeTruthy();
    // The six brand stops are interpolated into 16 bands.
    expect(mark!.childElementCount).toBe(16);
  });
});
