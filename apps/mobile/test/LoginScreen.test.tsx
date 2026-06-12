import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LoginScreen } from '../src/screens/LoginScreen';
import { getToken, setToken } from '../src/api';
import { bodyOf, findCall, jsonRes, stubFetch } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

describe('LoginScreen', () => {
  it('submits the email, stores the session token, and reports the user', async () => {
    const fetchMock = stubFetch((url) => {
      if (url.includes('/api/auth/login')) {
        return jsonRes({
          token: 'tok_abc123',
          user: { id: 'u_1', email: 'demo@open-cowork.dev', budgetCents: 500 },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const onSuccess = vi.fn();
    render(<LoginScreen onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText('Email'), {
      target: { value: 'demo@open-cowork.dev' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onSuccess).toHaveBeenCalledWith({
      id: 'u_1',
      email: 'demo@open-cowork.dev',
      budgetCents: 500,
    });
    expect(getToken()).toBe('tok_abc123');

    const call = findCall(fetchMock, '/api/auth/login');
    expect(call).toBeDefined();
    expect(call!.init?.method).toBe('POST');
    expect(bodyOf(call!.init)).toEqual({ email: 'demo@open-cowork.dev' });
  });

  it('shows the backend error message when login fails', async () => {
    stubFetch(() =>
      jsonRes({ error: { code: 'VALIDATION_ERROR', message: 'That email looks wrong' } }, 422),
    );
    const onSuccess = vi.fn();
    render(<LoginScreen onSuccess={onSuccess} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('That email looks wrong')).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(getToken()).toBeNull();
  });

  it('validates an empty email without calling the backend', () => {
    const fetchMock = stubFetch(() => jsonRes({}));
    render(<LoginScreen onSuccess={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Enter your email to sign in')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
