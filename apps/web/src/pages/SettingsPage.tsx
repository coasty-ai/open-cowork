import { useEffect, useState } from 'react';
import { Button, Card, ErrorState, Field, Spinner } from '@open-cowork/ui';
import { getClient, useAuth } from '../store';

export function SettingsPage() {
  const client = getClient();
  const user = useAuth((s) => s.user);
  const setAuth = useAuth((s) => s.setAuth);
  const token = useAuth((s) => s.token);
  const [budget, setBudget] = useState<number | null>(null);
  const [spend, setSpend] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const me = await client.me();
        setBudget(me.user.budgetCents);
        setSpend(me.monthSpendCents);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load settings');
      }
    })();
  }, []);

  const save = async () => {
    if (budget === null || !user || !token) return;
    setPending(true);
    setSaved(false);
    try {
      const res = await fetch(client.url('/api/me/budget'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...client.authHeaders() },
        body: JSON.stringify({ budgetCents: budget }),
      });
      if (!res.ok) throw new Error('Saving the budget failed');
      setAuth(token, { ...user, budgetCents: budget });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setPending(false);
    }
  };

  if (error) return <ErrorState message={error} />;
  if (budget === null) return <Spinner aria-label="Loading settings" />;

  return (
    <>
      <h1 className="page-title">Settings</h1>
      <Card>
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Spending</h2>
        <p style={{ color: 'var(--color-text-muted)' }}>
          This month: ${((spend ?? 0) / 100).toFixed(2)}. Every billable action is checked against your
          per-run budget cap server-side.
        </p>
        <Field label="Per-run budget cap (cents)" hint="Hard ceiling for any single run or workflow" required>
          {({ id }) => (
            <input
              id={id}
              type="number"
              min={5}
              max={1000000}
              value={budget}
              onChange={(e) => setBudget(Number(e.target.value))}
            />
          )}
        </Field>
        <div className="row" style={{ marginTop: 12 }}>
          <Button onClick={() => void save()} loading={pending}>
            Save
          </Button>
          {saved ? <span role="status">Saved ✓</span> : null}
        </div>
      </Card>
      <Card>
        <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Appearance</h2>
        <Button
          variant="secondary"
          onClick={() => {
            const el = document.documentElement;
            el.dataset.theme = el.dataset.theme === 'light' ? 'dark' : 'light';
          }}
        >
          Toggle light/dark theme
        </Button>
      </Card>
    </>
  );
}
