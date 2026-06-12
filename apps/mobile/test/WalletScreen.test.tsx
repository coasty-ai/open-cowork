import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WalletScreen } from '../src/screens/WalletScreen';
import { AuthProvider } from '../src/auth';
import { setToken } from '../src/api';
import { jsonRes, makeWallet, stubFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

function renderWallet() {
  return render(
    <AuthProvider>
      <WalletScreen />
    </AuthProvider>,
  );
}

describe('WalletScreen', () => {
  it('shows a loading state, then the balance and month spend', async () => {
    let resolveFetch: (value: Response) => void = () => undefined;
    stubFetch(() => new Promise<Response>((resolve) => (resolveFetch = resolve)));
    renderWallet();

    expect(screen.getByText('Loading wallet…')).toBeInTheDocument();

    resolveFetch(jsonRes(makeWallet({ balanceCents: 1234, monthSpendCents: 250 })));

    expect(await screen.findByText('$12.34')).toBeInTheDocument();
    expect(screen.getByText('$2.50')).toBeInTheDocument();
    expect(screen.getByText(/Billing period 2026-06/)).toBeInTheDocument();
    expect(screen.queryByText('Loading wallet…')).not.toBeInTheDocument();
  });

  it('shows an error and recovers via retry', async () => {
    let first = true;
    stubFetch(() => {
      if (first) {
        first = false;
        throw new TypeError('fetch failed');
      }
      return jsonRes(makeWallet({ balanceCents: 999 }));
    });
    renderWallet();

    expect(await screen.findByText('Cannot reach the open-cowork backend')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('$9.99')).toBeInTheDocument();
  });
});
