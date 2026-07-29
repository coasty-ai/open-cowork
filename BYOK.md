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

```
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

1. **The provider's own metadata** — OpenRouter modalities, Ollama capabilities.
2. **A bundled catalog** distilled from [models.dev](https://models.dev), an open,
   community-maintained database of model specifications — **5,811 models across 174
   providers**, of which ~3,000 accept image input. Committed to the repo, so it is correct
   offline and on first run.
3. **Name heuristics** — for local finetunes no database will ever list
   (`my-qwen2.5-vl-tune:q4_K_M`), covering LLaVA, Qwen-VL, InternVL, Molmo, MiniCPM-V,
   Gemma 3, Phi-4-multimodal, SmolVLM, Idefics, CogVLM, GLM-4V, Pixtral, and the GUI-agent
   VLMs (UI-TARS, ShowUI, OS-Atlas, Aguvis).
4. **`unknown`** — surfaced honestly, resolvable by an explicit user override.

The catalog is **majority-voted across providers**, which matters more than it sounds: one
gateway lists `gpt-3.5-turbo` as image-capable against eight that say otherwise, and
`gpt-oss-120b` gets a single image vote against 42. An "any provider says vision" rule would
have marked both usable and sent a blind screenshot to a text-only model.

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
