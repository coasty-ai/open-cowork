import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderSettings } from '../src/components/ProviderSettings';
import type {
  CoworkListModelsResult,
  CoworkProviderStatus,
  CoworkSetProvider,
} from '../src/api/client';

const COASTY_DEFAULT: CoworkProviderStatus = {
  kind: 'coasty',
  model: null,
  hasKey: false,
  isDefault: true,
  secureStorage: true,
};

const MODELS: CoworkListModelsResult = {
  ok: true,
  models: [
    { id: 'gpt-4o', label: 'gpt-4o', vision: true },
    { id: 'gpt-3.5-turbo', label: 'gpt-3.5-turbo', vision: false },
    { id: 'mystery', label: 'mystery', vision: 'unknown' },
  ],
};

function installBridge(over: Partial<NonNullable<Window['cowork']>> = {}) {
  const bridge = {
    platform: 'desktop' as const,
    getProvider: vi.fn(async (): Promise<CoworkProviderStatus> => COASTY_DEFAULT),
    setProvider: vi.fn(
      async (input: CoworkSetProvider): Promise<CoworkProviderStatus> => ({
        kind: input.kind,
        model: input.model,
        label: input.label,
        hasKey: Boolean(input.apiKey),
        isDefault: false,
        secureStorage: true,
      }),
    ),
    clearProvider: vi.fn(async (): Promise<CoworkProviderStatus> => COASTY_DEFAULT),
    listProviderModels: vi.fn(async () => MODELS),
    testProvider: vi.fn(async () => ({ ok: true, detail: '3 models' })),
    ...over,
  };
  (window as unknown as { cowork?: unknown }).cowork = bridge;
  return bridge;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { cowork?: unknown }).cowork;
});

describe('ProviderSettings', () => {
  it('on the web (no desktop bridge) shows a desktop-only note', () => {
    render(<ProviderSettings />);
    expect(screen.getByText(/runs in the open-cowork desktop app/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument();
  });

  it('shows the Coasty default state', async () => {
    installBridge();
    render(<ProviderSettings />);
    expect(await screen.findByText('Coasty (default)')).toBeInTheDocument();
    expect(screen.getByText(/Local runs use/i)).toBeInTheDocument();
  });

  it('warns clearly when a third-party LLM is active', async () => {
    installBridge({
      getProvider: vi.fn(
        async (): Promise<CoworkProviderStatus> => ({
          kind: 'openrouter',
          model: 'x',
          label: 'OpenRouter · x',
          hasKey: true,
          isDefault: false,
          secureStorage: true,
        }),
      ),
    });
    render(<ProviderSettings />);
    expect(await screen.findByText(/third-party LLM/i)).toBeInTheDocument();
    // Appears in both the status badge and the warning body.
    expect(screen.getAllByText(/OpenRouter · x/).length).toBeGreaterThanOrEqual(1);
  });

  it('loads models with vision badges and auto-selects a vision model', async () => {
    const bridge = installBridge();
    render(<ProviderSettings />);
    await screen.findByText('Coasty (default)');
    await userEvent.click(screen.getByRole('button', { name: /load models/i }));
    await waitFor(() => expect(bridge.listProviderModels).toHaveBeenCalled());
    const select = (await screen.findByLabelText('Model')) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /gpt-4o — vision ✓/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /gpt-3.5-turbo — no vision/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /mystery — vision\?/ })).toBeInTheDocument();
    // Auto-selected the first vision-capable model.
    expect(select.value).toBe('gpt-4o');
    expect(screen.getByRole('button', { name: /save provider/i })).toBeEnabled();
  });

  it('blocks Save and warns for a non-vision model', async () => {
    installBridge();
    render(<ProviderSettings />);
    await screen.findByText('Coasty (default)');
    await userEvent.click(screen.getByRole('button', { name: /load models/i }));
    await userEvent.selectOptions(await screen.findByLabelText('Model'), 'gpt-3.5-turbo');
    expect(screen.getByText(/can't see images/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save provider/i })).toBeDisabled();
  });

  it('requires an explicit confirm for an unknown-vision model', async () => {
    installBridge();
    render(<ProviderSettings />);
    await screen.findByText('Coasty (default)');
    await userEvent.click(screen.getByRole('button', { name: /load models/i }));
    await userEvent.selectOptions(await screen.findByLabelText('Model'), 'mystery');
    const save = screen.getByRole('button', { name: /save provider/i });
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(save).toBeEnabled();
  });

  it('saves the chosen provider config', async () => {
    const bridge = installBridge();
    render(<ProviderSettings />);
    await screen.findByText('Coasty (default)');
    await userEvent.type(screen.getByLabelText(/API key/i), 'sk-or-secret');
    await userEvent.click(screen.getByRole('button', { name: /load models/i }));
    await screen.findByLabelText('Model'); // gpt-4o auto-selected
    await userEvent.click(screen.getByRole('button', { name: /save provider/i }));
    await waitFor(() => expect(bridge.setProvider).toHaveBeenCalled());
    expect(bridge.setProvider).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'openrouter', model: 'gpt-4o', apiKey: 'sk-or-secret' }),
    );
  });

  it('reverts to Coasty via Use Coasty', async () => {
    const bridge = installBridge({
      getProvider: vi.fn(
        async (): Promise<CoworkProviderStatus> => ({
          kind: 'openrouter',
          model: 'x',
          label: 'OpenRouter · x',
          hasKey: true,
          isDefault: false,
          secureStorage: true,
        }),
      ),
    });
    render(<ProviderSettings />);
    await userEvent.click(await screen.findByRole('button', { name: /use coasty/i }));
    await waitFor(() => expect(bridge.clearProvider).toHaveBeenCalled());
  });

  it('surfaces a listModels error', async () => {
    installBridge({
      listProviderModels: vi.fn(
        async (): Promise<CoworkListModelsResult> => ({
          ok: false,
          code: 'PROVIDER_UNREACHABLE',
          message: 'Could not reach the provider — is Ollama running?',
        }),
      ),
    });
    render(<ProviderSettings />);
    await screen.findByText('Coasty (default)');
    await userEvent.click(screen.getByRole('button', { name: /load models/i }));
    expect(await screen.findByText(/is Ollama running/i)).toBeInTheDocument();
  });

  it('warns when secure key storage is unavailable', async () => {
    installBridge({
      getProvider: vi.fn(async () => ({ ...COASTY_DEFAULT, secureStorage: false })),
    });
    render(<ProviderSettings />);
    expect(await screen.findByText(/Secure key storage is unavailable/i)).toBeInTheDocument();
  });
});
