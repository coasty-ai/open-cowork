#!/usr/bin/env tsx
/**
 * Write packages/ui/src/tokens.css from the token source. Run after changing
 * any token value:  pnpm --filter @open-cowork/tokens gen:css
 *
 * The committed output is prettier-ignored and guarded by a byte-parity test
 * (packages/ui/test/tokens-parity.test.ts), so a hand-edit fails CI.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTokensCss } from '../src/generate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'ui', 'src', 'tokens.css');
writeFileSync(out, buildTokensCss(), 'utf8');
console.log(`wrote ${out}`);
