import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Badge, Button, Card, ErrorState, Field, Logo, Heading, Text } from '@open-cowork/ui';
import { getClient, useAuth } from '../store';
import { formatApiError, type CoastyKeyStatus } from '../api/client';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyStatus, setKeyStatus] = useState<CoastyKeyStatus | null>(null);
  const token = useAuth((s) => s.token);
  const setAuth = useAuth((s) => s.setAuth);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: { pathname?: string } } };

  // Public status check — drives whether we offer the key-setup field here.
  useEffect(() => {
    void getClient()
      .coastyKeyStatus()
      .then(setKeyStatus)
      .catch(() => setKeyStatus(null));
  }, []);

  // While a submit is in flight we may briefly hold a session before validating
  // an attached key — don't redirect until that settles (a rejected key reverts
  // the session and keeps the user here).
  if (token && !pending) return <Navigate to="/" replace />;

  const needsKey = keyStatus !== null && !keyStatus.configured;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setPending(true);
    setError(null);
    setKeyError(null);
    try {
      const res = await getClient().login(email.trim());
      setAuth(res.token, res.user);
      // Optionally attach a Coasty key using the fresh session. If the key is
      // rejected (format), revert the just-created session so the user stays
      // here to correct it rather than being bounced into the app.
      const key = apiKey.trim();
      if (needsKey && key) {
        try {
          await getClient().setCoastyKey(key);
        } catch (err) {
          logout();
          setKeyError(formatApiError(err));
          setPending(false);
          return;
        }
      }
      navigate(location.state?.from?.pathname ?? '/', { replace: true });
    } catch (err) {
      // A login failure (incl. backend-unreachable) is a form-level problem, not
      // an email-validation error — surface it as a banner via formatApiError.
      setError(formatApiError(err));
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
          <Field label="Email" required>
            {({ id }) => (
              <input
                id={id}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            )}
          </Field>

          {needsKey ? (
            <div className="login-coasty">
              <div className="login-coasty__head">
                <span className="login-coasty__title">Connect Coasty</span>
                <Badge tone="neutral">Demo mode</Badge>
              </div>
              <Text variant="caption" as="p">
                You&rsquo;re on a local sandbox — sign in and explore right away. Add your Coasty
                API key to control real machines (you can also do this later in Settings).
              </Text>
              <Field
                label="Coasty API key"
                hint="Optional — your key stays on the backend, never in the browser"
                error={keyError ?? undefined}
              >
                {({ id, describedBy, invalid }) => (
                  <input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      if (keyError) setKeyError(null);
                    }}
                    placeholder="sk-coasty-…"
                  />
                )}
              </Field>
            </div>
          ) : keyStatus?.configured ? (
            <Text variant="caption" as="p" className="login-coasty__ok">
              Coasty connected · {keyStatus.mode}
            </Text>
          ) : null}

          {error ? <ErrorState message={error} /> : null}
          <Button type="submit" loading={pending} disabled={!email.trim()}>
            Sign in
          </Button>
        </form>
      </Card>
    </main>
  );
}
