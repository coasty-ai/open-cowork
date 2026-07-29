<p align="center">
  <a href="https://github.com/coasty-ai/open-cowork">
    <img src="public/image.png" alt="open-cowork — hand off computer tasks to an AI coworker; watch it work, approve from anywhere" width="100%">
  </a>
</p>

<h1 align="center">open-cowork</h1>

<p align="center">
  <strong>Hand off computer tasks to an AI coworker — watch it work, approve from anywhere.</strong>
</p>
<p align="center">
  An open-source, cross-platform agentic coworker that <em>sees a screen and acts on it</em> —
  your own desktop, a cloud VM, or a browser. It streams every step live, pauses for your
  approval, and keeps spend visible and capped.
</p>
<p align="center">
  Runs on the <a href="https://coasty.ai/docs">Coasty Computer Use API</a> out of the box —
  or <strong>bring your own LLM</strong> (Anthropic · OpenAI · Gemini · OpenRouter · a local model). Your call.
</p>

<p align="center">
  <a href="https://github.com/coasty-ai/open-cowork/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/coasty-ai/open-cowork/ci.yml?branch=main&label=CI"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-desktop%20%C2%B7%20web%20%C2%B7%20mobile-0aa">
  <img alt="One key" src="https://img.shields.io/badge/setup-one%20key%20(or%20none)-7c3aed">
  <img alt="BYO LLM (BYOK)" src="https://img.shields.io/badge/BYO%20LLM-Anthropic%20%C2%B7%20OpenAI%20%C2%B7%20Gemini%20%C2%B7%20Ollama-ff8c00">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="Tests" src="https://img.shields.io/badge/tests-730%2B%20%C2%B7%205%20E2E-success">
</p>

<p align="center">
  <a href="#quickstart"><b>Quickstart</b></a> &nbsp;·&nbsp;
  <a href="#bring-your-own-llm-byok"><b>Bring your own LLM</b></a> &nbsp;·&nbsp;
  <a href="RUN_LOCALLY.md"><b>Automate your PC</b></a> &nbsp;·&nbsp;
  <a href="#what-you-can-do"><b>Features</b></a> &nbsp;·&nbsp;
  <a href="#how-it-works">How it works</a> &nbsp;·&nbsp;
  <a href="#docs">Docs</a>
</p>

<p align="center">
  <img src="public/demo.gif" alt="open-cowork driving Chrome on a cloud machine: a task is delegated, the agent opens Chrome and searches Google Flights step by step while the transcript streams live on the left, then returns a summary of the best options" width="100%">
</p>
<p align="center">
  <sub><em>Delegate a task → watch your coworker drive a browser, step by step → get the result. Runs with zero setup in <a href="#quickstart">demo mode</a>.</em></sub>
</p>

---

## Quickstart

> **Prereqs:** Node ≥ 22.5 (we use 24) · pnpm 10 (`corepack enable`).

```bash
git clone https://github.com/coasty-ai/open-cowork.git && cd open-cowork
pnpm install      # one install for the whole monorepo
pnpm desktop      # ← runs the desktop app: starts backend + web, opens the window
```

That's it — **one command, zero config.** `pnpm desktop` starts the backend and web
UI, then opens the **desktop app** (the build that can drive **your own screen**).
With no key set it runs in **demo mode**: a bundled mock server and a throwaway
sandbox key — no account, no network, no billing.

Then, in the window:

1. Sign in with any email.
2. On **Delegate**, pick **“This computer (local screen).”**
3. Type a task → confirm the cost → watch it work. _(Tip: put `NEEDS_HUMAN` in a task to see the approval flow pause and resume.)_

> 🧠 **Bring your own LLM (BYOK).** Want it to run on _your_ model instead of Coasty?
> Drop `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, Gemini, OpenRouter) into `.env` and
> `pnpm desktop` picks it up automatically — or use **Settings → Model provider** for
> a local model (Ollama / LM Studio). Coasty stays the default until you switch.
> [Jump to BYOK ↓](#bring-your-own-llm-byok)

> ⚠️ Local control moves your **real** mouse and keyboard. Stop with **Cancel** (or
> close the window), and start small — full safety notes in **[RUN_LOCALLY.md](RUN_LOCALLY.md)**.

### Ways to run

| Goal | How | Model | Cost |
| --- | --- | --- | --- |
| **Automate your own PC** | `pnpm desktop` | Coasty _or your own LLM_ | demo **$0** · BYOK = your provider's rate |
| **Web app only** | `pnpm dev` → <http://127.0.0.1:5173> | Coasty | **$0** |
| **Your Coasty account** | add `COASTY_API_KEY` to `.env` | Coasty (real model) | sandbox key = **$0** |
| **Bring your own LLM (BYOK)** | key in `.env`, or **Settings** | Anthropic · OpenAI · Gemini · OpenRouter · Ollama | your provider's rate · **local = $0** |

The only thing you ever _have_ to set is `COASTY_API_KEY` — and even that's optional in demo
mode. Everything else has a working default. Prefer your own model? **That's BYOK** — pick a
provider in Settings and local runs use it. Full local-automation guide:
**[RUN_LOCALLY.md](RUN_LOCALLY.md)**.

<details>
<summary><b>Using your own Coasty account, webhooks &amp; the cost warning</b></summary>

```bash
echo "COASTY_API_KEY=sk-coasty-test-…" > .env   # sandbox key — never bills
pnpm dev                                         # now talks to the real Coasty API
```

With a key set, `pnpm dev` does **not** start the mock and points the backend at
the real Coasty API. Start with a **sandbox key** (`sk-coasty-test-…`) — it
exercises the full real model and never bills. Switch to a live key only when
you're ready to spend.

**Webhooks** (instant status without polling) require an **https**
`COWORK_PUBLIC_URL` — Coasty only accepts HTTPS webhook URLs. open-cowork
detects this: over a non-https URL it simply doesn't register a webhook (so run
creation never fails) and state still syncs live via SSE + read-time reconcile.
Set an https `COWORK_PUBLIC_URL` (a tunnel or your deployment — see
[DEPLOYMENT.md](DEPLOYMENT.md)) to turn webhooks on.

> ⚠ **Cost warning.** With a **live** key (`sk-coasty-live-…`): runs bill
> **$0.05/step**, machines **$0.05–0.09/hour** running ($0.01 stopped),
> predict/session calls a few cents each. open-cowork always shows an estimate,
> requires explicit confirmation, enforces per-run budget caps server-side, and
> supports machine auto-terminate TTLs — but a live key is real money. All
> automated tests use the mock/sandbox path and never spend anything.

</details>

### More commands

```bash
pnpm desktop       # full stack + the desktop app (local screen control) — one command
pnpm dev           # full stack, open the web app yourself at :5173
pnpm dev --no-web  # API only (mock + backend)
pnpm dev:mobile    # Expo / React Native  (or: pnpm --filter @open-cowork/mobile web)
```

<details>
<summary>Run the Electron app against an already-running stack (advanced)</summary>

With `pnpm dev` already running in another terminal:

```bash
pnpm dev:desktop   # builds the Electron bundles and opens the window only
```

`pnpm desktop` does both for you — start the stack and open the window — and
shuts it all down when you close the window.

</details>

---

## What you can do

- 💬 **Delegate in chat** — _"rename these files and email the report"_ — and
  watch the agent execute it step by step with a live screen view.
- 🧠 **Bring your own LLM (BYOK)** — run local screen control on _your_ model:
  Anthropic, OpenAI, Gemini, OpenRouter, or a local model (Ollama / LM Studio / vLLM). Coasty is just
  the default. [Details ↓](#bring-your-own-llm-byok)
- 📺 **Supervise runs** — dashboard, durable event timeline (SSE with replay),
  cancel / resume / human-takeover from web, desktop, or phone.
- 🔁 **Build workflows** — a versioned JSON DSL (task · assert · if · loop ·
  parallel · retry · human_approval) with instant validation, cost estimates,
  and hard server-side budget caps.
- 🖥️ **Manage machines** — provision Coasty cloud VMs, snapshot, stop,
  terminate, with live cost rates at every step.
- 📱 **Stay in the loop across devices** — start a run on your laptop; when it
  pauses for approval, the banner pops on your phone. Approve there.
- 💸 **See cost at all times** — wallet balance, per-run worst-case estimates,
  and an explicit *confirm-the-cost* handshake before anything billable starts.

### Platform support

| Capability | 🖥️ Desktop | 🌐 Web | 📱 Mobile |
| --- | :---: | :---: | :---: |
| Local screen control | ✅ first-class | → cloud machine | → cloud machine |
| Cloud-machine control + live view | ✅ | ✅ | ✅ |
| Task chat + run dashboard | ✅ | ✅ | ✅ |
| Workflow builder | ✅ full | ✅ full | view + approve |
| Approvals / human takeover | ✅ | ✅ | ✅ |
| Cost / wallet view | ✅ | ✅ | ✅ |

---

## Bring your own LLM (BYOK)

**Bring your own key, bring your own model.** Local screen control defaults to **Coasty's**
computer-use model — but you can point it at **any major provider** instead. Coasty stays the
default; switch back any time with one click. Nothing else in the app changes.

### The fastest way: put a key in `.env`

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
same thing happens. Set **several** and open-cowork refuses to guess — name one with
`COWORK_LLM_PROVIDER`. Pin an exact model with `COWORK_LLM_MODEL`. Anything saved in
**Settings → Model provider** wins over the environment, so the UI is never overridden behind
your back.

| Provider | Env var | API key | Covers |
| --- | --- | :---: | --- |
| **Anthropic** | `ANTHROPIC_API_KEY` | required | Claude Sonnet / Opus / Haiku |
| **OpenAI** | `OPENAI_API_KEY` | required | `gpt-4o`, `gpt-4.1`, `gpt-5`, o-series |
| **Google Gemini** | `GOOGLE_GENERATIVE_AI_API_KEY` | required | Gemini Pro / Flash |
| **xAI** | `XAI_API_KEY` | required | Grok (the whole 4 line is multimodal) |
| **Mistral** | `MISTRAL_API_KEY` | required | Pixtral, Mistral Medium/Small 3 |
| **Groq** | `GROQ_API_KEY` | required | fast inference for Llama vision models |
| **OpenRouter** | `OPENROUTER_API_KEY` | required | hundreds of models; vision read from OpenRouter's own modality metadata |
| **OpenAI-compatible** | `COWORK_LLM_API_KEY` | optional | **Ollama**, LM Studio, vLLM, Together, Fireworks — any `…/v1` base URL |

### Knowing which models can actually see

Computer use is screenshot-driven, so before a run we must know whether the chosen model
accepts images. Guessing from the model name is how that goes wrong: the old heuristic list
enumerated `claude-3`/`3.5`/`3.7`/`4` and stopped, so every Claude 5 model silently became
"unknown" and was blocked behind an override checkbox.

Capability is now resolved in layers, most authoritative first:

1. **the provider's own metadata** — OpenRouter modalities, Ollama capabilities;
2. **a bundled catalog** distilled from [models.dev](https://models.dev), an open,
   community-maintained database of model specifications — **5,811 models across 174
   providers**, of which ~3,000 accept image input. Committed to the repo, so it is correct
   offline and on first run;
3. **name heuristics** — for local finetunes no database will ever list
   (`my-qwen2.5-vl-tune:q4_K_M`), covering LLaVA, Qwen-VL, InternVL, Molmo, MiniCPM-V,
   Gemma 3, Phi-4-multimodal, SmolVLM, Idefics, CogVLM, GLM-4V, Pixtral, and the
   GUI-agent VLMs (UI-TARS, ShowUI, OS-Atlas, Aguvis);
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

Anthropic and Gemini are **first-class**, not base-URL tricks: neither speaks the OpenAI
dialect (Anthropic uses `x-api-key` + a dated version header, Gemini authenticates by query
parameter), so each has its own transport. Adding a vendor means one entry in
[`packages/core/src/providers.ts`](packages/core/src/providers.ts) — the desktop, the web
Settings UI, and the env bootstrap all read that one table.

- 👁️ **Vision is required.** Computer use is screenshot-driven, so a model that can't see
  images is flagged and **blocked** with a clear message — never a blind, wasted run.
- 🏠 **Local-first.** A local model (e.g. Ollama at `http://localhost:11434/v1`) runs entirely
  on your machine — no key, no cloud, no spend.
- 🔑 **Your key stays yours.** BYO keys are encrypted with your **OS keychain** (Electron
  `safeStorage` — DPAPI / Keychain / libsecret), live only in the desktop process, are
  scrubbed from every error message, and **never** reach the web or mobile bundle.
- 👀 **No surprise data egress.** With a third-party model, your screenshots and prompts go to
  that provider — the app says so right in the confirm-the-cost dialog before a run starts.
- ☁️ **Cloud-machine runs always use Coasty.** BYO drives local (desktop) runs today; cloud
  BYO is a documented follow-up.

> Built on the [Vercel AI SDK](https://sdk.vercel.ai): rate-limit (429) and transient errors
> retry with backoff, and if a model ignores structured output the response is recovered with
> a defensive JSON parse — so even smaller local models can drive the loop.

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
  maxSteps: 500,        // long horizon
  deadlineMs: 30 * 60_000, // …but never more than 30 minutes
  maxRepeatedSteps: 8,  // this workload retries legitimately
});
```

## How it works

```text
 You ──► open-cowork backend ──► Coasty API ──► a screen the agent drives
            │   (the ONLY place           ├─ your own desktop   (desktop app)
            │    the API key lives)       ├─ a Coasty cloud VM  (any client)
            └──► web / desktop / mobile   └─ a browser page     (Playwright)
                 live events, approvals, costs
```

One shared **agent loop** (screenshot → predict → act → repeat) drives any
screen through a single `Executor` interface — `LocalExecutor` (your desktop),
`RemoteMachineExecutor` (a cloud VM), or `BrowserExecutor`. The **predict** step
is its own seam (`@open-cowork/llm`): Coasty is the default implementation, and a
[bring your own LLM](#bring-your-own-llm-byok) is just another one behind the same contract,
so the loop, executors, and UI don't care which is behind it. Clients never hold
the Coasty key: they talk to the backend with short-lived session tokens, and
the backend proxies to Coasty, verifies HMAC-signed webhooks, persists runs, and
fans events out over SSE. Full design in
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Security

`COASTY_API_KEY` exists **only** in the backend's environment. Browsers,
Electron renderers, and the mobile app authenticate with short-lived session
tokens and never see the key — enforced by tests that scan every client bundle
and a runtime E2E assertion that watches every browser request for secret
material. **Bring-your-own-LLM keys** follow the same rule: encrypted with the OS
keychain (`safeStorage`), held only in the desktop process, scrubbed from every
error, and kept out of the web/mobile bundles (the AI SDK is desktop-only).
Coasty webhooks are verified with per-run HMAC secrets (constant-time compare,
±5-minute replay window) before they can touch any state. Threat notes in
**[SECURITY.md](SECURITY.md)**.

---

## Docs

| Guide | What's inside |
| --- | --- |
| **[RUN_LOCALLY.md](RUN_LOCALLY.md)** | Automate your own PC with the desktop app — step by step |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Monorepo map, the Executor abstraction, agent loop, realtime + data model |
| [SECURITY.md](SECURITY.md) | Key custody, HMAC, trust boundary, threat table |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Running the backend + each client in production |
| [COOKBOOK.md](COOKBOOK.md) | Recipes: cross-device approval, workflows, scripting the loop |
| [DECISIONS.md](DECISIONS.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [SUMMARY.md](SUMMARY.md) | Stack choices · how to contribute · what was built + coverage |

### Project layout

```text
packages/core       Coasty client, agent loop, workflow DSL, cost estimator, HMAC — isomorphic, zero deps
packages/executor   Executor abstraction: LocalExecutor (native), RemoteMachineExecutor (VM), BrowserExecutor
packages/llm        BYO LLM provider seam: Coasty + OpenAI/OpenRouter/Ollama via the Vercel AI SDK (desktop-only)
packages/ui         Shared React design system + domain components
apps/backend        Fastify: auth, Coasty proxy (sole key holder), webhooks, SQLite, SSE fan-out, budgets
apps/web            Vite + React SPA (also hosted by the desktop shell)
apps/desktop        Electron shell + LocalRunManager (local screen control)
apps/mobile         Expo / React Native companion (monitor + approve)
tools/mock-coasty   Full offline mock of the Coasty API (REST + SSE + signed webhooks)
e2e                 Playwright end-to-end flows (web + desktop)
```

### Commands

| Command | What |
| --- | --- |
| `pnpm dev` | mock + backend + web, wired together (`--no-web` for API only) |
| `pnpm run doctor` | preflight: Node, deps, key shape, Electron binary (needs `run` — `pnpm doctor` is a pnpm built-in) |
| `pnpm fix:electron` | re-install Electron's binary if `pnpm desktop` says it "failed to install correctly" |
| `pnpm test` | every unit + integration suite (offline, no spend) |
| `pnpm typecheck` · `pnpm lint` · `pnpm format` | strict static checks |
| `pnpm e2e` | Playwright: web + desktop journeys vs the mock |
| `pnpm security:scan` | assert no secret material in client code/bundles |
| `pnpm dev:mock\|backend\|web\|desktop\|mobile` | run any single piece |

---

## Links

- **Repository:** <https://github.com/coasty-ai/open-cowork>
- **Issues & feature requests:** <https://github.com/coasty-ai/open-cowork/issues>
- **Report a vulnerability:** [Security Advisories](https://github.com/coasty-ai/open-cowork/security/advisories) (see [SECURITY.md](SECURITY.md))
- **Coasty:** [docs](https://coasty.ai/docs) · [API keys](https://coasty.ai/developers/keys)

## License

[MIT](LICENSE) © Coasty / open-cowork contributors
