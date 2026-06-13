import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, Field, Logo } from '@open-cowork/ui';
import { getClient, useAuth } from '../store';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useAuth((s) => s.token);
  const setAuth = useAuth((s) => s.setAuth);
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname?: string } } };

  if (token) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setPending(true);
    setError(null);
    try {
      const res = await getClient().login(email.trim());
      setAuth(res.token, res.user);
      navigate(location.state?.from?.pathname ?? '/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 16 }}>
      <Card>
        <form
          onSubmit={(e) => void submit(e)}
          style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 300 }}
        >
          <Logo size={34} />
          <h1 className="page-title" style={{ marginTop: 4 }}>
            Sign in
          </h1>
          <p style={{ color: 'var(--color-text-muted)', margin: 0, fontSize: '0.9rem' }}>
            Demo single-tenant auth — enter an email to get a session.
          </p>
          <Field label="Email" required error={error ?? undefined}>
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            )}
          </Field>
          <Button type="submit" loading={pending} disabled={!email.trim()}>
            Sign in
          </Button>
        </form>
      </Card>
    </main>
  );
}
