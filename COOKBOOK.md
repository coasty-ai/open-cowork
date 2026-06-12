# COOKBOOK

Recipes for common open-cowork jobs. All of them work against the mock server
(`pnpm dev:mock`) with zero spend — add ` NEEDS_HUMAN `, ` MUST_FAIL `, or
` RUN_LONG ` to any task text to script the mock's behavior deterministically.

---

## 1. Run a task on a cloud machine and approve it from your phone

1. **Laptop (web)**: Machines → *Provision machine* (Linux, confirm the
   $0.05/hr rate) → Delegate → "Download the invoices NEEDS_HUMAN and file
   them" → confirm the worst-case cost → the run starts.
2. **Phone (mobile app)**: sign in with the same email. The Runs tab shows the
   run; when it pauses, the *"A run needs your approval"* banner appears.
3. Open it → read the pause reason and the event timeline → add a note →
   **Approve**. The laptop's live view resumes within a second (SSE), and the
   run finishes with a cost summary on both devices.

Why it works: the backend mirrors every event into a durable per-run stream
and pushes an `awaiting_human` notification onto your per-user feed; both
clients are just subscribers (see `ARCHITECTURE.md` → Realtime model).

## 2. Let the agent drive *your own* computer (desktop)

1. Run the stack (`pnpm dev:mock` + `dev:backend` + `dev:web`), then
   `pnpm dev:desktop`.
2. In the desktop window, the Delegate screen's machine list has **"This
   computer (local screen)"** as the first target. Pick it, describe the task,
   and read the confirmation — it means it: the agent moves your real mouse.
3. Watch the timeline; cancel anytime from the desktop, the web app, or your
   phone (local runs are mirrored like cloud runs).

Notes: Windows needs nothing extra (PowerShell bridge). macOS: grant Screen
Recording + Accessibility. Tip: keep tasks narrow and use approval-style
wording; the loop aborts after 3 consecutive failed actions.

## 3. Build a workflow with a human gate (and a hard budget)

Workflows → *New workflow*. The prefilled template is exactly this recipe:

```json
{
  "steps": [
    { "id": "fetch",  "type": "task", "task": "Open order {{inputs.order_id}} and read the invoice total", "save_as": "invoice" },
    { "id": "check",  "type": "assert", "condition": { "op": "truthy", "value": "{{invoice.passed}}" }, "message": "Could not read the invoice" },
    { "id": "gate",   "type": "human_approval", "message": "Approve publishing the result?" },
    { "id": "ok",     "type": "succeed", "output": { "total": "{{invoice.result}}" } }
  ]
}
```

*Validate + estimate* gives instant local validation (every documented DSL
limit) plus typical/worst-case cost. Save, then *Run workflow*: pick a
machine, set the **budget cap** — that number is the `budget_cents` guard
Coasty enforces server-side; breaching it stops the run with
`GUARD_EXCEEDED`. Approve the gate when it pauses; the output panel shows the
templated result.

## 4. Retry flaky steps automatically

Wrap the fragile part in a `retry` and assert on the bound result:

```json
{ "id": "r", "type": "retry", "max_attempts": 3, "body": [
  { "id": "submit", "type": "task", "task": "Submit the expense form", "save_as": "out" },
  { "id": "verify", "type": "assert", "condition": { "op": "truthy", "value": "{{out.passed}}" } }
]}
```

(Mock tip: a task containing `MUST_FAIL_ONCE` fails the first attempt and
succeeds on the second — handy for demos.)

## 5. Fan out across parallel branches

```json
{ "id": "p", "type": "parallel", "branches": [
  [ { "id": "a", "type": "task", "task": "Export the sales report", "save_as": "sales" } ],
  [ { "id": "b", "type": "task", "task": "Export the support report", "save_as": "support" } ]
]},
{ "id": "both", "type": "assert", "condition": { "op": "and", "conditions": [
  { "op": "truthy", "value": "{{sales.passed}}" },
  { "op": "truthy", "value": "{{support.passed}}" }
]}}
```

Branches run concurrently and bind results under their `save_as` names.
Remember the documented limits: ≤16 branches, and no
`human_approval`/`succeed`/`fail` inside a branch.

## 6. Bound machine spend with TTLs

When provisioning, set *Auto-terminate after N minutes* — that is the
documented `ttl_minutes` (5 min–7 days): the VM terminates itself and all
billing stops, even if everyone forgets it. Stopped machines bill $0.01/hr
(storage); terminate to reach $0.

## 7. Use the agent loop programmatically (no UI)

```ts
import { CoastyClient, runAgentLoop } from '@open-cowork/core';
import { RemoteMachineExecutor } from '@open-cowork/executor';

const coasty = new CoastyClient({
  baseUrl: process.env.COASTY_BASE_URL!,   // mock or real — same code
  apiKey: process.env.COASTY_API_KEY!,     // server-side only!
});
const { machine } = await coasty.createMachine({ display_name: 'script-vm' });
const session = await coasty.createSession({ screen_width: 1280, screen_height: 720 });
const executor = new RemoteMachineExecutor({ machineId: machine.id, transport: coasty });

const outcome = await runAgentLoop({
  screen: executor,
  task: 'Open the settings page and enable dark mode',
  maxSteps: 15,
  predictStep: (input) =>
    coasty.sessionPredict(session.session_id, {
      screenshot: input.screenshotB64,
      instruction: input.instruction,
    }),
});
console.log(outcome.status, outcome.stepsUsed, `${outcome.totalCostCents}¢`);
await coasty.deleteSession(session.session_id);   // free the concurrency slot
```

## 8. Verify your webhook receiver with signed test vectors

```ts
import { signWebhookPayload, verifyWebhookSignature } from '@open-cowork/core';

const body = JSON.stringify({ event: 'run.succeeded', run: { id: 'run_1' } });
const header = await signWebhookPayload({ secret: 'whsec_yours', body });
const verdict = await verifyWebhookSignature({ body, header, secret: 'whsec_yours' });
// verdict.valid === true; tamper with `body` and it flips with reason 'bad_signature'
```

## 9. Estimate costs before committing to anything

```ts
import { runEstimateCents, workflowEstimateCents, formatCents } from '@open-cowork/core';

runEstimateCents({ cuaVersion: 'v3', maxSteps: 40 });    // { perStep: 5, min: 5, max: 200 }
workflowEstimateCents(definition);                        // { typicalCents, worstCaseCents }
formatCents(125);                                         // "$1.25"
```

The backend exposes the same math at `POST /api/estimate` — the UI's numbers
and the enforcement numbers can never drift apart.

## 10. Script the mock for demos and tests

```ts
import { createMockCoasty } from '@open-cowork/mock-coasty';

const { app, state } = createMockCoasty({ tickMs: 50, walletCents: 200 });
await app.listen({ port: 4010 });
// task text drives behavior: NEEDS_HUMAN pauses, MUST_FAIL fails verification,
// RUN_LONG takes 20 steps, MOCK_DONE finishes a predict immediately.
// state.webhookDeliveries / state.events let tests assert everything.
```
