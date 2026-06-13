import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, Field, Logo, Heading, Text } from '@open-cowork/ui';
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
    <main className="login-screen">
      <Card>
        <form className="login-form" onSubmit={(e) => void submit(e)}>
          <Logo size={34} />
          <Heading level={1}>Sign in</Heading>
          <Text variant="muted" as="p">
            Demo single-tenant auth — enter an email to get a session.
          </Text>
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
