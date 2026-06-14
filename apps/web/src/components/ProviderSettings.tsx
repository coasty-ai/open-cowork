/**
 * Model-provider settings (desktop only). Lets the user keep Coasty (default) or
 * bring their own LLM — OpenRouter, OpenAI, or any OpenAI-compatible endpoint
 * (Ollama / LM Studio / vLLM). The API key never reaches this code beyond the
 * input box: it's sent to the desktop main over IPC, encrypted with the OS
 * keychain, and never returned. Non-vision models are flagged and blocked
 * (computer-use needs sight). On the web (no desktop bridge) it shows a note.
 */
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, ErrorState, Field, Heading, Icon, Text } from '@open-cowork/ui';
import type { CoworkModelInfo, CoworkProviderStatus, ProviderKind } from '../api/client';

interface KindOption {
  value: ProviderKind;
  label: string;
  needsKey: boolean;
  defaultBaseUrl: string;
  baseHint: string;
}

const KINDS: KindOption[] = [
  {
    value: 'openrouter',
    label: 'OpenRouter',
    needsKey: true,
    defaultBaseUrl: '',
    baseHint: 'Uses https://openrouter.ai by default — leave blank.',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    needsKey: true,
    defaultBaseUrl: '',
    baseHint: 'Uses https://api.openai.com/v1 by default — leave blank.',
  },
  {
    value: 'openai-compatible',
    label: 'OpenAI-compatible (Ollama, LM Studio, vLLM…)',
    needsKey: false,
    defaultBaseUrl: 'http://localhost:11434/v1',
    baseHint: 'The /v1 endpoint, e.g. Ollama http://localhost:11434/v1',
  },
];

function visionLabel(v: CoworkModelInfo['vision']): string {
  return v === true ? 'vision ✓' : v === false ? 'no vision' : 'vision?';
}

export function ProviderSettings() {
  // Read the desktop bridge at runtime (preload injects it before the SPA loads).
  const cowork = typeof window !== 'undefined' ? window.cowork : undefined;
  const supported = Boolean(cowork?.getProvider);
  const [status, setStatus] = useState<CoworkProviderStatus | null>(null);
  const [kind, setKind] = useState<ProviderKind>('openrouter');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<CoworkModelInfo[] | null>(null);
  const [model, setModel] = useState('');
  const [visionOverride, setVisionOverride] = useState(false);
  const [busy, setBusy] = useState<null | 'models' | 'test' | 'save' | 'clear'>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState(false);
  // Bumped whenever the draft changes — discards stale in-flight model loads so
  // switching provider mid-request can't populate the wrong provider's models.
  const loadSeq = useRef(0);
  // Same idea for the "Test connection" probe: a slow result must not surface
  // against a provider the user has since switched away from.
  const testSeq = useRef(0);

  const kindOption = KINDS.find((k) => k.value === kind)!;
  const selectedModel = models?.find((m) => m.id === model);
  const vision = selectedModel?.vision;
  const visionOk = vision === true || (vision === 'unknown' && visionOverride);
  const visionBlocked = selectedModel !== undefined && vision === false;

  useEffect(() => {
    if (!supported) return;
    void cowork!.getProvider!()
      .then(setStatus)
      .catch(() => undefined);
  }, [supported]);

  if (!supported) {
    return (
      <Card>
        <Heading level={4}>Model provider</Heading>
        <Text variant="muted" as="p">
          Bring-your-own-LLM (OpenRouter, OpenAI, or a local model via Ollama) runs in the
          open-cowork desktop app, where local runs execute. Open the desktop app to configure a
          provider.
        </Text>
      </Card>
    );
  }

  const resetDraft = () => {
    loadSeq.current += 1; // invalidate any in-flight model load
    testSeq.current += 1; // ...and any in-flight connection test
    setModels(null);
    setModel('');
    setApiKey(''); // a key typed for one provider must not leak to the next
    setVisionOverride(false);
    setTest(null);
    setSaved(false);
    setError(null);
  };

  const onKind = (next: ProviderKind) => {
    setKind(next);
    setBaseUrl(KINDS.find((k) => k.value === next)?.defaultBaseUrl ?? '');
    resetDraft();
  };

  const loadModels = async () => {
    const seq = (loadSeq.current += 1);
    setBusy('models');
    setError(null);
    setTest(null);
    try {
      const res = await cowork!.listProviderModels!({
        kind,
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
      });
      if (seq !== loadSeq.current) return; // a newer load/change superseded this one
      if (!res.ok) {
        setModels(null);
        setError(res.message);
        return;
      }
      setModels(res.models);
      // Auto-select the first vision-capable model (locked default).
      const firstVision = res.models.find((m) => m.vision === true);
      setModel(firstVision?.id ?? res.models[0]?.id ?? '');
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err instanceof Error ? err.message : 'Could not load models');
    } finally {
      if (seq === loadSeq.current) setBusy(null);
    }
  };

  const testConnection = async () => {
    const seq = (testSeq.current += 1);
    setBusy('test');
    setTest(null);
    try {
      const res = await cowork!.testProvider!({
        kind,
        baseUrl: baseUrl || undefined,
        apiKey: apiKey || undefined,
      });
      if (seq !== testSeq.current) return; // a newer test/change superseded this
      setTest({
        ok: res.ok,
        text: res.ok ? (res.detail ?? 'Connected.') : (res.detail ?? 'Failed.'),
      });
    } catch (err) {
      if (seq !== testSeq.current) return;
      setTest({ ok: false, text: err instanceof Error ? err.message : 'Failed.' });
    } finally {
      if (seq === testSeq.current) setBusy(null);
    }
  };

  const save = async () => {
    if (!model || !visionOk) return;
    setBusy('save');
    setError(null);
    setSaved(false);
    setTest(null); // a prior "Connected" result refers to the old config
    try {
      const next = await cowork!.setProvider!({
        kind,
        model,
        baseUrl: baseUrl || undefined,
        vision,
        visionOverride: vision === 'unknown' ? visionOverride : undefined,
        label: `${kindOption.label.split(' (')[0]} · ${model}`,
        apiKey: apiKey || undefined,
      });
      setStatus(next);
      setApiKey('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  };

  const useCoasty = async () => {
    setBusy('clear');
    setError(null);
    try {
      const next = await cowork!.clearProvider!();
      setStatus(next);
      resetDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <div className="card-title-row">
        <Heading level={4}>Model provider</Heading>
        {status ? (
          <Badge tone={status.isDefault ? 'neutral' : 'info'}>
            {status.isDefault ? 'Coasty (default)' : `${status.label ?? status.kind}`}
          </Badge>
        ) : null}
      </div>

      {status && !status.isDefault ? (
        <p className="notice notice--warning">
          <Icon name="alertTriangle" size={16} className="notice__icon" />
          <span className="notice__body">
            Local runs use a <strong>third-party LLM</strong> ({status.label ?? status.kind}), not
            Coasty. Your provider key and screenshots are sent to that provider.
          </span>
        </p>
      ) : (
        <Text variant="muted" as="p">
          Local runs use <strong>Coasty</strong> by default. Add a provider to run them on your own
          LLM (OpenRouter, OpenAI, or a local model). Cloud-machine runs always use Coasty.
        </Text>
      )}

      {status?.secureStorage === false ? (
        <p className="notice notice--warning">
          <Icon name="alertTriangle" size={16} className="notice__icon" />
          <span className="notice__body">
            Secure key storage is unavailable on this machine — a provider key won't be saved. Local
            (no-key) providers like Ollama still work.
          </span>
        </p>
      ) : null}

      <Field label="Provider" hint="Coasty stays the default unless you pick one here">
        {({ id }) => (
          <select id={id} value={kind} onChange={(e) => onKind(e.target.value as ProviderKind)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        )}
      </Field>

      <Field label="Base URL" hint={kindOption.baseHint}>
        {({ id }) => (
          <input
            id={id}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={kindOption.defaultBaseUrl || 'https://…/v1'}
            spellCheck={false}
          />
        )}
      </Field>

      <Field
        label={kindOption.needsKey ? 'API key' : 'API key (optional for local models)'}
        hint="Sent to the desktop app, encrypted in your OS keychain, never shown again"
      >
        {({ id }) => (
          <input
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={status?.hasKey && status.kind === kind ? '•••••• (saved)' : 'sk-…'}
          />
        )}
      </Field>

      <div className="form-actions">
        <Button variant="secondary" onClick={() => void loadModels()} loading={busy === 'models'}>
          Load models
        </Button>
        <Button variant="secondary" onClick={() => void testConnection()} loading={busy === 'test'}>
          Test connection
        </Button>
        {test ? (
          <span className={test.ok ? 'saved-note' : undefined} role="status">
            {test.ok ? <Icon name="check" size={16} /> : null} {test.text}
          </span>
        ) : null}
      </div>

      {models ? (
        <Field
          label="Model"
          hint="Pick a vision-capable model — computer control needs to see the screen"
        >
          {({ id }) => (
            <select id={id} value={model} onChange={(e) => setModel(e.target.value)}>
              {models.length === 0 ? <option value="">No models found</option> : null}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {visionLabel(m.vision)}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}

      {visionBlocked ? (
        <p className="notice notice--warning">
          <Icon name="alertTriangle" size={16} className="notice__icon" />
          <span className="notice__body">
            <strong>{model}</strong> can't see images. Computer control needs a vision-capable model
            — pick one with “vision ✓”, or switch providers.
          </span>
        </p>
      ) : null}

      {selectedModel && vision === 'unknown' ? (
        <label className="row" style={{ gap: 'var(--space-2)' }}>
          <input
            type="checkbox"
            checked={visionOverride}
            onChange={(e) => setVisionOverride(e.target.checked)}
          />
          <Text variant="muted" as="span">
            I confirm <strong>{model}</strong> supports image input (vision).
          </Text>
        </label>
      ) : null}

      {error ? <ErrorState message={error} /> : null}

      <div className="form-actions">
        <Button
          onClick={() => void save()}
          loading={busy === 'save'}
          disabled={!model || !visionOk}
        >
          Save provider
        </Button>
        {status && !status.isDefault ? (
          <Button variant="secondary" onClick={() => void useCoasty()} loading={busy === 'clear'}>
            Use Coasty (default)
          </Button>
        ) : null}
        {saved ? (
          <span className="saved-note" role="status">
            <Icon name="check" size={16} /> Saved
          </span>
        ) : null}
      </div>
    </Card>
  );
}
