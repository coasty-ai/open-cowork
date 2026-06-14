import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Icon,
  Spinner,
  Heading,
  Text,
} from '@open-cowork/ui';
import { getClient, useAuth } from '../store';
import { formatApiError } from '../api/client';
import { useCoastyKey } from '../coastyKey';
import { ProviderSettings } from '../components/ProviderSettings';

export function SettingsPage() {
  const client = getClient();
  const user = useAuth((s) => s.user);
  const setAuth = useAuth((s) => s.setAuth);
  const token = useAuth((s) => s.token);
  // The Coasty-key status comes from the single shared source so this page and
  // every gated feature stay in lockstep; refresh() updates them all at once.
  const { status: keyStatus, refresh: refreshKey } = useCoastyKey();
  const [budget, setBudget] = useState<number | null>(null);
  const [spend, setSpend] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [keyPending, setKeyPending] = useState(false);
  const [keySaved, setKeySaved] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

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

  const saveKey = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setKeyPending(true);
    setKeySaved(false);
    setKeyError(null);
    try {
      await client.setCoastyKey(key);
      await refreshKey(); // updates this page + all gated features
      setApiKey('');
      setKeySaved(true);
    } catch (err) {
      setKeyError(formatApiError(err));
    } finally {
      setKeyPending(false);
    }
  };

  const removeKey = async () => {
    setKeyPending(true);
    setKeySaved(false);
    setKeyError(null);
    try {
      await client.clearCoastyKey();
      await refreshKey();
    } catch (err) {
      setKeyError(formatApiError(err));
    } finally {
      setKeyPending(false);
    }
  };

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

  return (
    <>
      <Heading level={1}>Settings</Heading>
      <Card>
        <Heading level={4}>Spending</Heading>
        {/* Spending load is independent of the Coasty-key card below — a failure
            here must not hide key management. */}
        {error ? (
          <ErrorState message={error} />
        ) : budget === null ? (
          <Spinner aria-label="Loading settings" />
        ) : (
          <>
            <Text variant="muted" as="p">
              This month: ${((spend ?? 0) / 100).toFixed(2)}. Every billable action is checked
              against your per-run budget cap server-side.
            </Text>
            <Field
              label="Per-run budget cap (cents)"
              hint="Hard ceiling for any single run or workflow"
              required
            >
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
            <div className="form-actions">
              <Button onClick={() => void save()} loading={pending}>
                Save
              </Button>
              {saved ? (
                <span className="saved-note" role="status">
                  <Icon name="check" size={16} /> Saved
                </span>
              ) : null}
            </div>
          </>
        )}
      </Card>
      <Card>
        <div className="card-title-row">
          <Heading level={4}>Coasty API key</Heading>
          {keyStatus ? (
            <Badge tone={keyStatus.demoMode ? 'neutral' : 'success'}>
              {keyStatus.demoMode ? 'Demo mode' : `Connected · ${keyStatus.mode}`}
            </Badge>
          ) : null}
        </div>
        <Text variant="muted" as="p">
          {keyStatus?.demoMode
            ? 'Running on a local sandbox with no real key — zero spend. Add your Coasty key to control real machines.'
            : keyStatus
              ? `Active key supplied via ${keyStatus.source === 'env' ? 'the environment' : 'this app'}. Your key is stored on the backend and never returned to the browser.`
              : 'Your key is stored on the backend and never returned to the browser.'}
        </Text>
        <Field
          label={keyStatus && !keyStatus.demoMode ? 'Replace API key' : 'Coasty API key'}
          hint="Starts with sk-coasty-… — it stays on the backend"
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
                if (keySaved) setKeySaved(false);
              }}
              placeholder="sk-coasty-…"
            />
          )}
        </Field>
        <div className="form-actions">
          <Button onClick={() => void saveKey()} loading={keyPending} disabled={!apiKey.trim()}>
            Save key
          </Button>
          {keyStatus?.source === 'runtime' ? (
            <Button variant="secondary" onClick={() => void removeKey()} disabled={keyPending}>
              Remove key
            </Button>
          ) : null}
          {keySaved ? (
            <span className="saved-note" role="status">
              <Icon name="check" size={16} /> Saved
            </span>
          ) : null}
        </div>
      </Card>
      <ProviderSettings />
    </>
  );
}
