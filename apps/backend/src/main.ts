/**
 * Backend entrypoint. Loads .env (repo root or app dir), validates config,
 * builds the server, and listens. `pnpm dev:backend` runs this with tsx.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config';
import { buildServer } from './server';

/** Tiny .env loader — no dependency, never logs values. */
function loadDotenv(): void {
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}

async function main(): Promise<void> {
  loadDotenv();
  const config = loadConfig();
  const { app } = buildServer({ config, logger: true });
  await app.listen({ port: config.port, host: config.host });
  console.log(`open-cowork backend listening at http://${config.host}:${config.port}`);
  console.log(
    `Coasty upstream: ${config.coastyBaseUrl} (key kind: ${config.coastyApiKey.startsWith('sk-coasty-test-') ? 'test/sandbox — never bills' : 'LIVE — real spend possible'})`,
  );

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((err) => {
  console.error('Backend failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
