/**
 * Web E2E: the full product journey against the mock Coasty server —
 * login → provision a machine → delegate a task with explicit cost
 * confirmation → watch live events + screen frames → approve the human
 * step → run completes with a cost summary → workflow with approval gate.
 *
 * Also a runtime security assertion: no Coasty key/secret material may appear
 * in ANY browser request this entire session.
 */
import { expect, test, type Page } from '@playwright/test';

const SECRET_PATTERNS = [/sk-coasty-(?:live|test)-[0-9a-fA-F]{8,}/, /whsec_[0-9a-zA-Z]{8,}/];

function watchForSecrets(page: Page): () => void {
  const leaks: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    const postData = req.postData() ?? '';
    const headerBlob = JSON.stringify(req.headers());
    for (const re of SECRET_PATTERNS) {
      if (re.test(url) || re.test(postData) || re.test(headerBlob)) {
        leaks.push(`${req.method()} ${url}`);
      }
    }
  });
  return () => expect(leaks, 'Coasty secret material must never leave the backend').toEqual([]);
}

const email = `e2e-${Date.now()}@example.com`;

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByRole('button', { name: /sign in/i }).click();
  // Assert the authenticated shell, not the composer: the Delegate page has no
  // "Delegate a task" heading (it is a logo + caption + composer), and with no
  // machine yet it renders the "No machine to run on" empty state instead of
  // the composer at all. "Sign out" is what actually proves a session exists.
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
}

/**
 * Pick a target in the composer's machine selector.
 *
 * It is an in-house combobox — a `<button role="combobox">` that opens a
 * `<ul role="listbox">` popover — not a native `<select>`, so `selectOption()`
 * throws "Element is not a <select> element". The options only exist in the DOM
 * while the popover is open, so open it first, then click. Scoped by accessible
 * name because a second "Screen" combobox appears once a local target is chosen.
 */
async function selectMachine(page: Page, name?: RegExp): Promise<void> {
  await page.getByRole('combobox', { name: 'Machine' }).click();
  await (name ? page.getByRole('option', { name }) : page.getByRole('option').first()).click();
}

async function ensureMachine(page: Page): Promise<void> {
  await page.getByRole('link', { name: /machines/i }).click();
  await expect(page.getByRole('heading', { name: /^machines$/i })).toBeVisible();
  if (
    await page
      .getByText(/no machines/i)
      .isVisible()
      .catch(() => false)
  ) {
    await page.getByRole('button', { name: /provision machine/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('$0.05/hour');
    await dialog.getByRole('button', { name: /confirm — provision/i }).click();
  }
  await expect(page.getByText(/running/i).first()).toBeVisible();
}

test.describe('full delegate → watch → approve → complete journey', () => {
  test('cloud run with human takeover and cost summary', async ({ page }) => {
    const assertNoLeaks = watchForSecrets(page);
    await login(page);
    await ensureMachine(page);

    // Wallet is visible on the machines page (cost-at-all-times requirement).
    await expect(page.getByText(/\$\d+\.\d{2}/).first()).toBeVisible();

    // Delegate a task that pauses for a human.
    await page.getByRole('link', { name: /delegate/i }).click();
    await page.getByLabel(/task/i).fill('Sort the inbox NEEDS_HUMAN then archive the rest');
    // Name the machine explicitly. The first option is now the Coasty-managed
    // target, which runs autonomously and would never reach the approval bar
    // this test is here to exercise.
    await selectMachine(page, /linux cloud VM/i);
    await page.getByRole('button', { name: 'Send' }).click();

    // Explicit confirmation before anything billable. The dialog deliberately
    // shows no dollar figure any more (c1a7373, "friendlier run-confirm with a
    // settable step limit, no cost shown"), so asserting "$1.25" here would be
    // pinning UI that was removed on purpose. What the gate still guarantees is
    // what we check: it interrupts the flow, and the worst case is bounded by a
    // visible, settable step limit. The server-side cost handshake is enforced
    // independently — the budget-safety test below covers that.
    const confirm = page.getByRole('dialog', { name: /ready to start/i });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByLabel(/maximum steps/i)).toHaveValue('25');
    await confirm.getByRole('button', { name: /start run/i }).click();

    // Live run view: timeline events stream in.
    await expect(page).toHaveURL(/\/runs\//);
    await expect(page.getByRole('log')).toBeVisible();
    await expect(page.getByText(/step \d+ completed/i).first()).toBeVisible({ timeout: 20_000 });

    // Live screen frames from the machine appear.
    await expect(page.getByAltText(/machine screen/i)).toHaveAttribute(
      'src',
      /data:image\/png;base64,/,
      { timeout: 20_000 },
    );

    // The run pauses for a human → approval bar appears; approve with a note.
    await expect(page.getByRole('button', { name: /approve/i })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel(/note/i).fill('Looks safe — approved from the web E2E');
    await page.getByRole('button', { name: /approve/i }).click();

    // Run completes; summary shows steps + total cost.
    await expect(page.getByText(/finished/i).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/summary/i)).toBeVisible();
    await expect(page.getByText(/total cost/i)).toBeVisible();
    await expect(page.getByText(/succeeded/i).first()).toBeVisible();

    // Runs list shows the completed run.
    await page.getByRole('link', { name: /^runs$/i }).click();
    await expect(page.getByText(/sort the inbox/i).first()).toBeVisible();

    assertNoLeaks();
  });

  test('managed task: no machine needed, runs autonomously, cleans up after itself', async ({
    page,
  }) => {
    const assertNoLeaks = watchForSecrets(page);
    await login(page);

    // Deliberately NO ensureMachine(): the whole point of a submit-and-forget
    // task is that the user never provisions anything.
    await page.getByRole('link', { name: /delegate/i }).click();
    await page.getByLabel(/task/i).fill('NEEDS_HUMAN download the newest invoice and verify it');
    await selectMachine(page, /coasty-managed/i);
    await page.getByRole('button', { name: 'Send' }).click();

    // The confirm names the autonomy trade-off: no approvals, no resume.
    const confirm = page.getByRole('dialog', { name: /ready to start/i });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/fully autonomously/i);
    await confirm.getByRole('button', { name: /start run/i }).click();

    await expect(page).toHaveURL(/\/runs\//);
    await expect(page.getByRole('log')).toBeVisible();

    // While the machine is being created there is no machine id to show.
    await expect(page.getByText(/managed machine/i).first()).toBeVisible({ timeout: 20_000 });

    // The task text contains NEEDS_HUMAN, which pauses an ordinary run. A task
    // must intercept that and carry on — so the approval bar must NEVER appear.
    await expect(page.getByText(/finished/i).first()).toBeVisible({ timeout: 40_000 });
    await expect(page.getByRole('button', { name: /approve/i })).toHaveCount(0);
    await expect(page.getByText(/succeeded/i).first()).toBeVisible();

    // And it tells the user the ephemeral machine was shut down afterwards.
    await expect(page.getByText(/machine was shut down/i)).toBeVisible({ timeout: 30_000 });

    // The frames outlive the machine: the final screen still renders.
    await expect(page.getByAltText(/machine screen/i)).toHaveAttribute(
      'src',
      /data:image\/png;base64,/,
      { timeout: 20_000 },
    );

    assertNoLeaks();
  });

  test('workflow with approval gate: build → validate → run → approve → output', async ({
    page,
  }) => {
    const assertNoLeaks = watchForSecrets(page);
    await login(page);
    await ensureMachine(page);

    await page.getByRole('link', { name: /workflows/i }).click();
    await page.getByRole('button', { name: /new workflow/i }).click();
    const dialog = page.getByRole('dialog', { name: /new workflow/i });
    await dialog.getByLabel(/name/i).fill('Invoice check E2E');
    await dialog.getByLabel(/slug/i).fill(`invoice-e2e-${Date.now() % 100000}`);

    // The template definition is prefilled; validate it for the estimate.
    await dialog.getByRole('button', { name: /validate \+ estimate/i }).click();
    await expect(dialog.getByText(/estimated cost/i)).toBeVisible();
    await dialog.getByRole('button', { name: /save workflow/i }).click();

    // Workflow detail: structure tree renders; start a run with a budget cap.
    await expect(page.getByRole('heading', { name: /invoice check e2e/i })).toBeVisible();
    await expect(page.getByRole('tree')).toBeVisible();
    await page.getByRole('button', { name: /run workflow/i }).click();
    const runDialog = page.getByRole('dialog', { name: /run workflow/i });
    await runDialog.getByLabel(/machine/i).selectOption({ index: 1 });
    await runDialog.getByRole('button', { name: /confirm .* cap — start/i }).click();

    // Live workflow run: gate pauses it; approve.
    await expect(page).toHaveURL(/\/workflows\/runs\//);
    await expect(page.getByRole('button', { name: /approve/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /approve/i }).click();

    // Completes with the template's output rendered.
    await expect(page.getByRole('heading', { name: /^result$/i })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/succeeded/i).first()).toBeVisible();

    assertNoLeaks();
  });

  test('budget safety: oversized run is refused with a server-side suggestion', async ({
    page,
  }) => {
    await login(page);
    await ensureMachine(page);
    // Drive the API directly from the browser session (same token the SPA uses)
    // to prove the cap is enforced server-side, not just by UI affordances.
    const result = await page.evaluate(async () => {
      const raw = localStorage.getItem('cowork-session');
      const token = raw ? (JSON.parse(raw) as { state: { token: string } }).state.token : '';
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          machineId: 'mch_test_whatever',
          task: 'spend everything',
          maxSteps: 1000,
          confirmCostCents: 5000,
        }),
      });
      return { status: res.status, body: (await res.json()) as { error?: { code?: string } } };
    });
    expect(result.status).toBe(422);
    expect(result.body.error?.code).toBe('BUDGET_EXCEEDED');
  });
});
