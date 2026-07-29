#!/usr/bin/env node
/**
 * Regenerate the bundled model-capability snapshot from models.dev.
 *
 *   pnpm update:models
 *
 * WHY A SNAPSHOT AT ALL
 * Computer use is screenshot-driven, so before a run we must answer one
 * question about the chosen model: can it see images? Getting that wrong is
 * expensive in both directions — a false "no" blocks a perfectly good model
 * behind an override checkbox, a false "yes" burns a run on a blind request.
 *
 * We used to answer it with a hand-written regex list, which is guesswork that
 * rots: the list enumerated claude-3/3.5/3.7/4 and stopped, so every Claude 5
 * silently became "unknown" and got blocked. models.dev is a community-
 * maintained database that records `modalities.input` per model, which is the
 * actual answer rather than an inference from a name.
 *
 * The snapshot is committed so the app is correct OFFLINE and on first run,
 * with no network round-trip in the hot path. `modelCatalog.ts` can refresh it
 * from the network at runtime for models released since the last regeneration.
 *
 * Only two id sets are emitted — vision and text-only — because that is all the
 * run gate needs. Context windows and pricing are deliberately left out: they
 * would multiply the file size for data nothing currently reads.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'llm', 'src', 'modelCatalog.generated.ts');
const SOURCE = 'https://models.dev/api.json';

/** Model ids are compared bare: no vendor prefix, no Ollama tag, lower-case. */
function normalizeId(id) {
  return String(id)
    .trim()
    .toLowerCase()
    .replace(/^[^/]+\//, '') // openrouter style: anthropic/claude-… → claude-…
    .replace(/:[^:]*$/, ''); // ollama style: qwen2.5-vl:7b → qwen2.5-vl
}

const res = await fetch(SOURCE);
if (!res.ok) {
  console.error(`error: ${SOURCE} responded ${res.status}`);
  process.exit(1);
}
const catalog = await res.json();

// The same model is listed by many providers (a hosted API plus every gateway
// that resells it) and they do not always agree. Rather than trust the first or
// let any single claim win, tally the votes per normalized id.
//
// This is not hypothetical: one aggregator lists `gpt-3.5-turbo` as accepting
// images (8 others say text-only), and `gpt-oss-120b` gets a single image vote
// against 42. An "any provider says vision" rule would mark both usable and
// send a blind screenshot to a text-only model.
const votes = new Map(); // normalized id -> { image, text }
let providers = 0;
let models = 0;

for (const provider of Object.values(catalog)) {
  if (!provider || typeof provider !== 'object') continue;
  providers++;
  for (const model of Object.values(provider.models ?? {})) {
    if (!model?.id) continue;
    models++;
    const inputs = model.modalities?.input;
    if (!Array.isArray(inputs) || inputs.length === 0) continue; // no claim → no vote
    const id = normalizeId(model.id);
    if (!id) continue;
    const tally = votes.get(id) ?? { image: 0, text: 0 };
    if (inputs.includes('image')) tally.image++;
    else tally.text++;
    votes.set(id, tally);
  }
}

const vision = new Set();
const textOnly = new Set();
let ties = 0;
for (const [id, { image, text }] of votes) {
  // A strict majority decides. A genuine tie is emitted in NEITHER set, so the
  // lookup returns 'unknown' and the name heuristic (then the user) decides —
  // better than committing to a coin flip about whether a run can even work.
  if (image > text) vision.add(id);
  else if (text > image) textOnly.add(id);
  else ties++;
}

const sortedVision = [...vision].sort();
const sortedTextOnly = [...textOnly].sort();
console.log(`  resolved ${votes.size} unique ids (${ties} tied → left unknown)`);

const body = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Model vision capability distilled from ${SOURCE}, an open, community-
 * maintained database of AI model specifications. Regenerate with:
 *
 *     pnpm update:models
 *
 * Ids are normalized: lower-cased, vendor prefix stripped (\`anthropic/x\` → \`x\`)
 * and Ollama tag stripped (\`x:7b\` → \`x\`), so one entry matches the same model
 * however a provider spells it.
 *
 * Source snapshot: ${providers} providers, ${models} models.
 * ${sortedVision.length} accept image input; ${sortedTextOnly.length} explicitly do not.
 */

/** Models whose \`modalities.input\` includes "image". */
export const CATALOG_VISION_MODELS: ReadonlySet<string> = new Set(${JSON.stringify(sortedVision, null, 0)});

/** Models that declare input modalities WITHOUT "image" — authoritative "no". */
export const CATALOG_TEXT_ONLY_MODELS: ReadonlySet<string> = new Set(${JSON.stringify(sortedTextOnly, null, 0)});

/** Provider/model counts of the snapshot, for diagnostics. */
export const CATALOG_STATS = {
  providers: ${providers},
  models: ${models},
  vision: ${sortedVision.length},
  textOnly: ${sortedTextOnly.length},
} as const;
`;

writeFileSync(OUT, body, 'utf8');
const kb = (Buffer.byteLength(body) / 1024).toFixed(1);
console.log(`wrote ${OUT}`);
console.log(
  `  ${providers} providers · ${models} models · ${sortedVision.length} vision · ${sortedTextOnly.length} text-only · ${kb} KB`,
);
