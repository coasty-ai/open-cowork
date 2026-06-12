import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScreenView } from '../src/index';

const FRAME = 'aGVsbG8gd29ybGQ=';

describe('ScreenView', () => {
  it('shows a placeholder when there is no frame', () => {
    render(<ScreenView />);
    expect(screen.getByText(/waiting for the first frame/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('renders the frame as a data:image/png;base64 URI with default alt', () => {
    render(<ScreenView frameB64={FRAME} />);
    const img = screen.getByRole('img', { name: 'Remote screen' });
    expect(img).toHaveAttribute('src', `data:image/png;base64,${FRAME}`);
    expect(screen.queryByText(/waiting for the first frame/i)).not.toBeInTheDocument();
  });

  it('accepts a custom alt', () => {
    render(<ScreenView frameB64={FRAME} alt="invoice-bot screen" />);
    expect(screen.getByRole('img', { name: 'invoice-bot screen' })).toBeInTheDocument();
  });

  it('shows the LIVE badge only when live', () => {
    const { rerender } = render(<ScreenView frameB64={FRAME} live />);
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    rerender(<ScreenView frameB64={FRAME} />);
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
  });

  it('flags a stale frame when older than staleAfterSeconds', () => {
    const lastFrameAt = new Date(Date.now() - 60_000).toISOString();
    render(<ScreenView frameB64={FRAME} staleAfterSeconds={5} lastFrameAt={lastFrameAt} />);
    expect(screen.getByText('Stale frame')).toBeInTheDocument();
  });

  it('does not flag a fresh frame', () => {
    const lastFrameAt = new Date().toISOString();
    render(<ScreenView frameB64={FRAME} staleAfterSeconds={300} lastFrameAt={lastFrameAt} />);
    expect(screen.queryByText('Stale frame')).not.toBeInTheDocument();
  });

  it('never flags stale without lastFrameAt or with an unparsable timestamp', () => {
    const { rerender } = render(<ScreenView frameB64={FRAME} staleAfterSeconds={1} />);
    expect(screen.queryByText('Stale frame')).not.toBeInTheDocument();
    rerender(<ScreenView frameB64={FRAME} staleAfterSeconds={1} lastFrameAt="not-a-date" />);
    expect(screen.queryByText('Stale frame')).not.toBeInTheDocument();
  });
});
