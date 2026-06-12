/**
 * Workflows: saved workflow list, recent workflow runs, and a builder for new
 * workflows (JSON DSL editor with instant local validation + cost estimate via
 * the backend's validate endpoint, which uses core's evaluator).
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  RunStatusBadge,
  Spinner,
  type RunStatus,
} from '@open-cowork/ui';
import { getClient } from '../store';
import type { WorkflowDto, WorkflowRunDto } from '../api/client';

const TEMPLATE = JSON.stringify(
  {
    steps: [
      { id: 'fetch', type: 'task', task: 'Open order {{inputs.order_id}} and read the invoice total', save_as: 'invoice' },
      { id: 'check', type: 'assert', condition: { op: 'truthy', value: '{{invoice.passed}}' }, message: 'Could not read the invoice' },
      { id: 'gate', type: 'human_approval', message: 'Approve publishing the result?' },
      { id: 'ok', type: 'succeed', output: { total: '{{invoice.result}}' } },
    ],
  },
  null,
  2,
);

export function WorkflowsPage() {
  const client = getClient();
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState<WorkflowDto[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [definitionText, setDefinitionText] = useState(TEMPLATE);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [estimate, setEstimate] = useState<{ typicalCents: number; worstCaseCents: number } | null>(null);
  const [pending, setPending] = useState(false);
  const [builderError, setBuilderError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [wf, wr] = await Promise.all([client.listWorkflows(), client.listWorkflowRuns()]);
      setWorkflows(wf.workflows);
      setRuns(wr.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workflows');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const validate = async (): Promise<Record<string, unknown> | null> => {
    setBuilderError(null);
    let definition: Record<string, unknown>;
    try {
      definition = JSON.parse(definitionText) as Record<string, unknown>;
    } catch {
      setIssues([{ path: '', message: 'Definition is not valid JSON' }]);
      setEstimate(null);
      return null;
    }
    try {
      const result = await client.validateWorkflow(definition);
      setIssues(result.issues);
      setEstimate(result.estimate);
      return result.valid ? definition : null;
    } catch (err) {
      setBuilderError(err instanceof Error ? err.message : 'Validation failed');
      return null;
    }
  };

  const save = async () => {
    const definition = await validate();
    if (!definition) return;
    setPending(true);
    try {
      const wf = await client.createWorkflow({ name, slug, definition });
      setBuilderOpen(false);
      navigate(`/workflows/${wf.id}`);
    } catch (err) {
      setBuilderError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setPending(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (workflows === null || runs === null) return <Spinner aria-label="Loading workflows" />;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Workflows</h1>
        <Button onClick={() => setBuilderOpen(true)}>New workflow</Button>
      </div>

      {workflows.length === 0 ? (
        <EmptyState
          title="No workflows yet"
          description="Compose multi-step automations: tasks, asserts, branches, loops, parallel branches, retries, and human approvals."
          action={<Button onClick={() => setBuilderOpen(true)}>Create your first workflow</Button>}
        />
      ) : (
        <div className="stack">
          {workflows.map((wf) => (
            <Link key={wf.id} className="run-row" to={`/workflows/${wf.id}`}>
              <Badge tone={wf.status === 'active' ? 'success' : 'neutral'}>v{wf.version}</Badge>
              <span className="run-row__task">
                <strong>{wf.name}</strong> <span style={{ color: 'var(--color-text-muted)' }}>({wf.slug})</span>
              </span>
            </Link>
          ))}
        </div>
      )}

      <h2 className="page-title" style={{ fontSize: '1.05rem' }}>
        Recent workflow runs
      </h2>
      {runs.length === 0 ? (
        <EmptyState title="No workflow runs yet" />
      ) : (
        <div className="stack">
          {runs.map((run) => (
            <Link key={run.id} className="run-row" to={`/workflows/runs/${run.id}`}>
              <RunStatusBadge status={run.status as RunStatus} />
              <span className="run-row__task">{run.id}</span>
              <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>
                spent ${(run.spentCents / 100).toFixed(2)} / cap ${(run.budgetCents / 100).toFixed(2)}
              </span>
            </Link>
          ))}
        </div>
      )}

      <Modal open={builderOpen} onClose={() => setBuilderOpen(false)} title="New workflow">
        <div className="stack">
          <div className="row">
            <Field label="Name" required>
              {({ id }) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={128} />}
            </Field>
            <Field label="Slug" required hint="lowercase, stable handle">
              {({ id }) => (
                <input
                  id={id}
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  pattern="[a-z0-9][a-z0-9_-]*"
                  maxLength={63}
                />
              )}
            </Field>
          </div>
          <Field label="Definition (workflow DSL JSON)" required>
            {({ id }) => (
              <textarea
                id={id}
                className="json-editor"
                value={definitionText}
                onChange={(e) => setDefinitionText(e.target.value)}
                spellCheck={false}
              />
            )}
          </Field>
          {issues.length > 0 ? (
            <ul className="issues-list" aria-label="Validation issues">
              {issues.map((issue, i) => (
                <li key={i}>
                  {issue.path ? <code>{issue.path}</code> : null} {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          {estimate ? (
            <p className="notice">
              Estimated cost: typical ${(estimate.typicalCents / 100).toFixed(2)}, worst case $
              {(estimate.worstCaseCents / 100).toFixed(2)} (budget caps are enforced server-side at start).
            </p>
          ) : null}
          {builderError ? <ErrorState message={builderError} /> : null}
          <div className="row">
            <Button variant="secondary" onClick={() => void validate()}>
              Validate + estimate
            </Button>
            <Button onClick={() => void save()} loading={pending} disabled={!name.trim() || !slug.trim()}>
              Save workflow
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
