#!/usr/bin/env node
/**
 * Regenerate the bundled model-capability snapshot.
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
 * silently became "unknown" and got blocked.
 *
 * The snapshot is committed so the app is correct OFFLINE and on first run,
 * with no network round-trip in the hot path. `modelCatalog.ts` can refresh it
 * from models.dev at runtime for models released since the last regeneration.
 *
 * TWO SOURCES, DELIBERATELY ASYMMETRIC
 *
 *   1. models.dev (primary) — records `modalities.input` per model across ~174
 *      providers. Contributes BOTH "yes" and "no" votes.
 *   2. LiteLLM's model_prices_and_context_window.json (secondary) — contributes
 *      "yes" ONLY, and only for ids models.dev has no opinion about.
 *
 * The asymmetry is not caution for its own sake. LiteLLM's `supports_vision`
 * has documented false negatives (missing values, and Gemini models reporting
 * false despite accepting images — BerriAI/litellm#7592), so its silence means
 * nothing and must never become a "no". Its positive claims, though, cover
 * ground models.dev misses: the AWS Bedrock and Vertex REGIONAL ids you
 * actually pass on those platforms (`anthropic.claude-3-5-sonnet-20241022-v2`,
 * `apac.amazon.nova-pro-v1`, `eu.`/`us.` prefixes). That is ~167 ids models.dev
 * lists only under their bare vendor names, if at all.
 *
 * Only two id sets are emitted — vision and text-only — because that is all the
 * run gate needs. Context windows and pricing are deliberately left out: they
 * would multiply the file size for data nothing currently reads.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import prettier from 'prettier';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'packages', 'llm', 'src', 'modelCatalog.generated.ts');
const MODELS_DEV = 'https://models.dev/api.json';
const LITELLM =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * Model ids are compared bare: LAST path segment only, no Ollama tag,
 * lower-cased. Keeping only the last segment is what lets one entry match every
 * spelling of a model — `anthropic/claude-sonnet-5` (OpenRouter),
 * `accounts/fireworks/models/llama-v3p2-11b-vision-instruct` (Fireworks) and
 * `bedrock/anthropic.claude-3-opus` all collapse correctly.
 *
 * MUST stay identical to `normalizeModelId` in packages/llm/src/modelCatalog.ts.
 * If the two diverge, every lookup silently misses.
 */
function normalizeId(id) {
  const raw = String(id ?? '')
    .trim()
    .toLowerCase();
  const last = raw.split('/').pop() ?? '';
  return last.replace(/:[^:]*$/, '');
}

async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`error: ${label} responded ${res.status}`);
    process.exit(1);
  }
  return res.json();
}

// ── source 1: models.dev ─────────────────────────────────────────────────────
const catalog = await fetchJson(MODELS_DEV, MODELS_DEV);

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
console.log(`  models.dev: ${votes.size} unique ids (${ties} tied → left unknown)`);

// ── source 2: LiteLLM, positive claims only, gap-fill only ───────────────────
let liteFilled = 0;
let liteSkippedConflict = 0;
try {
  const lite = await fetchJson(LITELLM, LITELLM);
  for (const [key, spec] of Object.entries(lite)) {
    if (!spec || typeof spec !== 'object') continue;
    // `mode` filters out image-generation size variants (`1024-x-1024/gpt-image-1.5`),
    // TTS and embeddings, which are not chat models we could drive a screen with.
    if (spec.mode !== 'chat') continue;
    if (spec.supports_vision !== true) continue; // silence is NOT a "no" here
    const id = normalizeId(spec.litellm_provider ? key : key);
    if (!id) continue;
    if (vision.has(id)) continue; // already known
    if (textOnly.has(id)) {
      // models.dev has an explicit majority "text-only". We do NOT flip it from
      // a source with known false negatives; a genuinely mislabelled model is
      // rescued instead by the unambiguous-name tier in capabilities.ts.
      liteSkippedConflict++;
      continue;
    }
    vision.add(id);
    liteFilled++;
  }
  console.log(
    `  litellm:    +${liteFilled} gap-filled ids (${liteSkippedConflict} conflicts left to models.dev)`,
  );
} catch (err) {
  // A second source is an enhancement, not a requirement. models.dev alone
  // still produces a correct (if slightly narrower) snapshot.
  console.warn(`  litellm:    skipped (${err instanceof Error ? err.message : 'fetch failed'})`);
}

const sortedVision = [...vision].sort();
const sortedTextOnly = [...textOnly].sort();

const body = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Model vision capability distilled from two open databases:
 *   - ${MODELS_DEV} (primary; contributes "yes" and "no")
 *   - LiteLLM's model_prices_and_context_window.json (secondary; "yes" only,
 *     and only for ids models.dev has no opinion about — its \`supports_vision\`
 *     has documented false negatives, so its silence means nothing)
 *
 * Regenerate with:
 *
 *     pnpm update:models
 *
 * Ids are normalized: lower-cased, LAST path segment only (\`anthropic/x\` → \`x\`,
 * \`accounts/fireworks/models/x\` → \`x\`) and Ollama tag stripped (\`x:7b\` → \`x\`),
 * so one entry matches the same model however a provider spells it.
 *
 * Source snapshot: ${providers} providers, ${models} models from models.dev,
 * plus ${liteFilled} ids gap-filled from LiteLLM.
 * ${sortedVision.length} accept image input; ${sortedTextOnly.length} explicitly do not.
 */

/** Models whose input modalities include images. */
export const CATALOG_VISION_MODELS: ReadonlySet<string> = new Set(${JSON.stringify(sortedVision)});

/** Models that declare input modalities WITHOUT images — authoritative "no". */
export const CATALOG_TEXT_ONLY_MODELS: ReadonlySet<string> = new Set(${JSON.stringify(sortedTextOnly)});

/** Provider/model counts of the snapshot, for diagnostics. */
export const CATALOG_STATS = {
  providers: ${providers},
  models: ${models},
  vision: ${sortedVision.length},
  textOnly: ${sortedTextOnly.length},
} as const;
`;

// Format with the repo's own prettier config. Without this the emitted file is a
// couple of multi-thousand-character lines, so `pnpm update:models` left the
// tree failing `pnpm format` — the documented refresh command broke the gate.
const config = (await prettier.resolveConfig(OUT)) ?? {};
const formatted = await prettier.format(body, { ...config, filepath: OUT });

writeFileSync(OUT, formatted, 'utf8');
const kb = (Buffer.byteLength(formatted) / 1024).toFixed(1);
console.log(`wrote ${OUT}`);
console.log(
  `  ${providers} providers · ${models} models · ${sortedVision.length} vision · ${sortedTextOnly.length} text-only · ${kb} KB`,
);
