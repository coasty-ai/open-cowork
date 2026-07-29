# Bring your own LLM (BYOK)

Local screen control defaults to **Coasty's** computer-use model. You can point it at **any
major provider** instead — or at a model running on your own machine. Coasty stays the
default; switch back any time with one click. Nothing else in the app changes.

## The fastest way: put a key in `.env`

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-…' >> .env
pnpm desktop
```

That's it. On startup the desktop detects the key, picks a vision-capable model, and prints
what it chose:

```text
[provider] Using Anthropic (Claude) · claude-sonnet-5 · ANTHROPIC_API_KEY=set (from the environment)
```

Set `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `OPENROUTER_API_KEY` instead and the
same thing happens.

Set **several** and open-cowork refuses to guess — name one with `COWORK_LLM_PROVIDER`:

```bash
COWORK_LLM_PROVIDER=anthropic      # pick a winner when several keys are present
COWORK_LLM_MODEL=claude-opus-5     # optional: pin an exact model
```

Anything saved in **Settings → Model provider** wins over the environment, so the UI is never
overridden behind your back.

## Providers

| Provider | Env var | API key | Covers |
| --- | --- | :---: | --- |
| **Anthropic** | `ANTHROPIC_API_KEY` | required | Claude Sonnet / Opus / Haiku |
| **OpenAI** | `OPENAI_API_KEY` | required | `gpt-4o`, `gpt-4.1`, `gpt-5`, o-series |
| **Google Gemini** | `GOOGLE_GENERATIVE_AI_API_KEY` | required | Gemini Pro / Flash |
| **xAI** | `XAI_API_KEY` | required | Grok (the whole 4 line is multimodal) |
| **Mistral** | `MISTRAL_API_KEY` | required | Pixtral, Mistral Medium / Small 3 |
| **Groq** | `GROQ_API_KEY` | required | fast inference for Llama vision models |
| **OpenRouter** | `OPENROUTER_API_KEY` | required | hundreds of models; vision read from OpenRouter's own modality metadata |
| **OpenAI-compatible** | `COWORK_LLM_API_KEY` | optional | **Ollama**, LM Studio, vLLM, Together, Fireworks — any `…/v1` base URL |

Anthropic and Gemini are **first-class**, not base-URL tricks: neither speaks the OpenAI
dialect (Anthropic uses `x-api-key` plus a dated version header, Gemini authenticates by query
parameter), so each has its own transport. Adding a vendor means one entry in
[`packages/core/src/providers.ts`](packages/core/src/providers.ts) — the desktop, the web
Settings UI, and the env bootstrap all read that one table.

## Running fully local (no key, no cloud, no spend)

Point it at anything that speaks the OpenAI dialect:

```bash
# Ollama
COWORK_LLM_BASE_URL=http://localhost:11434/v1
COWORK_LLM_MODEL=qwen2.5vl:7b

# LM Studio
COWORK_LLM_BASE_URL=http://localhost:1234/v1
```

No key required. Screenshots never leave your machine.

## Knowing which models can actually see

Computer use is screenshot-driven, so before a run we must know whether the chosen model
accepts images. Guessing from the model name is how that goes wrong: the old heuristic list
enumerated `claude-3`/`3.5`/`3.7`/`4` and stopped, so every Claude 5 model silently became
"unknown" and was blocked behind an override checkbox.

Capability is resolved in layers, most authoritative first:

1. **The provider's own metadata** — OpenRouter modalities, Ollama capabilities. It knows its
   own models.
2. **An unambiguous name** — an id containing `vision`, `multimodal`, a `-vl` segment, `vlm`,
   `omni` or `qvq`. See below for why this outranks the catalog rather than sitting under it.
3. **A bundled catalog** of **1,105 vision-capable ids**, distilled from two open databases and
   committed to the repo so it is correct offline and on first run.
4. **Family heuristics** — for local finetunes no database will ever list
   (`my-qwen2.5-vl-tune:q4_K_M`), covering LLaVA, Qwen-VL, InternVL, Molmo, MiniCPM-V/O,
   Gemma 3, Phi-4-multimodal, SmolVLM, Idefics, CogVLM, GLM-4V, Pixtral, Florence-2, and the
   GUI-agent VLMs (UI-TARS, ShowUI, OS-Atlas, Aguvis).
5. **`unknown`** — surfaced honestly, resolvable by an explicit user override.

### Two databases, deliberately asymmetric

- **[models.dev](https://models.dev)** (primary) — 5,813 models across 174 providers.
  Contributes both "yes" and "no".
- **[LiteLLM's model catalog](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)**
  (secondary) — contributes **"yes" only**, and only for ids models.dev has no opinion about.

The asymmetry is not caution for its own sake. LiteLLM's `supports_vision` has documented false
negatives ([litellm#7592](https://github.com/BerriAI/litellm/issues/7592) — Gemini models
reporting `false` despite accepting images), so its *silence* means nothing and must never
become a "no". Its positive claims, though, cover ground models.dev misses: the **AWS Bedrock
and Vertex regional ids** you actually pass on those platforms
(`anthropic.claude-3-5-sonnet-20241022-v2`, `apac.amazon.nova-pro-v1`). That is 167 ids
models.dev lists only under bare vendor names, if at all.

### Why a majority vote, and why a name can beat it

The catalog is **majority-voted across providers**, which matters more than it sounds: one
gateway lists `gpt-3.5-turbo` as image-capable against eight that say otherwise, and
`gpt-oss-120b` gets a single image vote against 42. An "any provider says vision" rule would
have marked both usable and sent a blind screenshot to a text-only model.

But a vote can also lose for bad reasons. `phi-4-multimodal-instruct` appears under three
providers and only one declares image input — so the majority reports *text-only* for a model
named "multimodal", and because a catalog `false` is treated as authoritative, the user could
not even override it. Ordering an explicit name claim above the vote fixes that class of error
without weakening the vote everywhere else.

The reverse mistake is just as real, so both directions are gated by tests:

- `grok-3` is text-only in every models.dev listing. A tidy-looking `grok-[2-9]` range claimed
  otherwise, which would have sent a blind screenshot.
- `codellama-70b` was reported as multimodal because `llama-?[4-9]` matched the "llama-7"
  inside its **parameter count**.
- `-instruct` was once on the text-only list. It is a tuning convention, not a modality —
  `qwen2.5-vl-72b-instruct` and `llama-3.2-90b-vision-instruct` are instruct-tuned VLMs — so it
  hard-blocked any vision model whose family wasn't separately recognised.

[`packages/llm/test/visionCoverage.test.ts`](packages/llm/test/visionCoverage.test.ts) asserts
a census of ~80 real model ids across every vendor and open-weight family in both directions:
each must resolve to vision-capable, and a list of known text-only models must never be.

Refresh the snapshot when new models ship:

```bash
pnpm update:models   # re-distills packages/llm/src/modelCatalog.generated.ts
```

The desktop can also refresh it at runtime, so a model released after your last `git pull`
still resolves correctly.

## What this guarantees

- **Vision is required.** A model that can't see images is flagged and **blocked** with a
  clear message — never a blind, wasted run.
- **Your key stays yours.** BYO keys are encrypted with your **OS keychain** (Electron
  `safeStorage` — DPAPI / Keychain / libsecret), live only in the desktop process, are
  scrubbed from every error message, and **never** reach the web or mobile bundle.
- **No surprise data egress.** With a third-party model, your screenshots and prompts go to
  that provider — the app says so right in the confirm-the-cost dialog before a run starts.
- **Cloud-machine runs always use Coasty.** BYO drives local (desktop) runs today; cloud BYO
  is a documented follow-up.

> Built on the [Vercel AI SDK](https://sdk.vercel.ai): rate-limit (429) and transient errors
> retry with backoff, and if a model ignores structured output the response is recovered with
> a defensive JSON parse — so even smaller local models can drive the loop.

---

## Long-horizon runs

A step cap is a bad stop condition on its own. An agent that gets wedged still burns every
remaining step — and every token, and every credit — before it hits the cap. The loop watches
for three failure shapes and ends a hopeless run in seconds instead:

| Guard | Fires when | Default | Outcome |
| --- | --- | :---: | --- |
| **Idle** | N steps in a row say `continue` but propose no action | 3 | `stalled` |
| **Repeat** | N steps in a row propose the *same* action | 6 | `stalled` |
| **Deadline** | wall-clock budget spent, regardless of steps used | off | `timeout` |

Each has a false-positive story that shaped its design, and each is tested for **both**
directions — that it fires, and that it stays out of the way:

- **Coordinate jitter still counts as repeating.** A model nudging a click one pixel per step
  is stuck, not progressing, so coordinates are quantized to an 8px grid before comparison.
- **Scrolling and waiting are exempt.** Paging through a long document means issuing the same
  scroll ten times; that's the job, not a wedge.
- **Typing different text is progress.** `type "a"` then `type "b"` are different signatures
  even though both are `type_text`.
- **A real verdict always wins.** `done` and `fail` from the agent are never pre-empted by a
  guard.

Set them per run — `maxIdleSteps`, `maxRepeatedSteps`, `deadlineMs` — and `0` disables either
counter if your workload legitimately repeats itself.

```ts
await runAgentLoop({
  screen,
  predictStep,
  task: 'reconcile every invoice in the queue',
  maxSteps: 500,           // long horizon
  deadlineMs: 30 * 60_000, // …but never more than 30 minutes
  maxRepeatedSteps: 8,     // this workload retries legitimately
});
```

---

**See also:** [RUN_LOCALLY.md](RUN_LOCALLY.md) · [ARCHITECTURE.md](ARCHITECTURE.md) ·
[SECURITY.md](SECURITY.md)
