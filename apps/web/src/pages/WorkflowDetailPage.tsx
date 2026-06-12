/**
 * One workflow: definition editor (validated), structure preview (step tree),
 * and "Run workflow" with inputs + machine + budget cap confirmation.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Modal,
  Spinner,
  WorkflowStepTree,
  type WorkflowStep as UiStep,
} from '@open-cowork/ui';
import { getClient } from '../store';
import type { MachineDto, WorkflowDto } from '../api/client';

interface DslStep {
  id: string;
  type: string;
  then?: DslStep[];
  else?: DslStep[];
  body?: DslStep[];
  branches?: DslStep[][];
  task?: string;
}

function toUiSteps(steps: DslStep[] | undefined): UiStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => {
    const children: UiStep[] = [
      ...toUiSteps(s.then),
      ...toUiSteps(s.else),
      ...toUiSteps(s.body),
      ...(s.branches ?? []).flatMap((b) => toUiSteps(b)),
    ];
    return {
      id: s.id,
      type: s.type,
      label: s.task ? `${s.id}: ${s.task.slice(0, 60)}` : s.id,
      ...(children.length > 0 ? { children } : {}),
    };
  });
}

export function WorkflowDetailPage() {
  const { id } = useParams<{ id: string }>();
  const client = getClient();
  const navigate = useNavigate();
  const [workflow, setWorkflow] = useState<WorkflowDto | null>(null);
  const [machines, setMachines] = useState<MachineDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [definitionText, setDefinitionText] = useState('');
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [savePending, setSavePending] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [inputsText, setInputsText] = useState('{}');
  const [machineId, setMachineId] = useState('');
  const [budgetCents, setBudgetCents] = useState(200);
  const [runPending, setRunPending] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const load = async () => {
    if (!id) return;
    setError(null);
    try {
      const [wf, machineRes] = await Promise.all([client.getWorkflow(id), client.listMachines()]);
      setWorkflow(wf);
      setDefinitionText(JSON.stringify(wf.definition, null, 2));
      setMachines(machineRes.machines.filter((m) => m.status === 'running'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the workflow');
    }
  };
  useEffect(() => {
    void load();
  }, [id]);

  const tree = useMemo(() => {
    try {
      const parsed = JSON.parse(definitionText) as { steps?: DslStep[] };
      return toUiSteps(parsed.steps);
    } catch {
      return [];
    }
  }, [definitionText]);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!workflow) return <Spinner aria-label="Loading workflow" />;

  const save = async () => {
    setSavePending(true);
    setIssues([]);
    try {
      const definition = JSON.parse(definitionText) as Record<string, unknown>;
      const result = await client.validateWorkflow(definition);
      if (!result.valid) {
        setIssues(result.issues);
        return;
      }
      const updated = await client.updateWorkflow(workflow.id, { definition });
      setWorkflow(updated);
    } catch (err) {
      setIssues([{ path: '', message: err instanceof Error ? err.message : 'Save failed' }]);
    } finally {
      setSavePending(false);
    }
  };

  const startRun = async () => {
    setRunPending(true);
    setRunError(null);
    try {
      const inputs = JSON.parse(inputsText) as Record<string, unknown>;
      const run = await client.startWorkflowRun(workflow.id, {
        inputs,
        machineId: machineId || undefined,
        budgetCents,
        confirmCostCents: budgetCents,
      });
      navigate(`/workflows/runs/${run.id}`);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Failed to start the workflow run');
    } finally {
      setRunPending(false);
    }
  };

  return (
    <>
      <div className="page-header">
        <div className="row">
          <h1 className="page-title">{workflow.name}</h1>
          <Badge tone="info">v{workflow.version}</Badge>
        </div>
        <Button onClick={() => setRunOpen(true)}>Run workflow</Button>
      </div>

      <div className="run-detail-grid">
        <Card>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Definition</h2>
          <textarea
            className="json-editor"
            aria-label="Workflow definition JSON"
            value={definitionText}
            onChange={(e) => setDefinitionText(e.target.value)}
            spellCheck={false}
          />
          {issues.length > 0 ? (
            <ul className="issues-list" aria-label="Validation issues">
              {issues.map((issue, i) => (
                <li key={i}>
                  {issue.path ? <code>{issue.path}</code> : null} {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="row" style={{ marginTop: 12 }}>
            <Button onClick={() => void save()} loading={savePending}>
              Validate + save (bumps version)
            </Button>
          </div>
        </Card>
        <Card>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Structure</h2>
          <WorkflowStepTree steps={tree} />
        </Card>
      </div>

      <Modal open={runOpen} onClose={() => setRunOpen(false)} title="Run workflow">
        <div className="stack">
          <Field label="Inputs (JSON)" hint="Available as {{inputs.*}} in the definition">
            {({ id: fieldId }) => (
              <textarea
                id={fieldId}
                className="json-editor"
                style={{ minHeight: 100 }}
                value={inputsText}
                onChange={(e) => setInputsText(e.target.value)}
                spellCheck={false}
              />
            )}
          </Field>
          <Field label="Machine" hint="Default machine for task steps">
            {({ id: fieldId }) => (
              <select id={fieldId} value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                <option value="">— choose a running machine —</option>
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            label="Budget cap (cents)"
            hint="Hard server-side spend ceiling for this run"
            required
          >
            {({ id: fieldId }) => (
              <input
                id={fieldId}
                type="number"
                min={5}
                value={budgetCents}
                onChange={(e) => setBudgetCents(Number(e.target.value))}
              />
            )}
          </Field>
          <p className="notice">
            You are approving a spend ceiling of <strong>${(budgetCents / 100).toFixed(2)}</strong>.
            The run stops with GUARD_EXCEEDED if it would go over.
          </p>
          {runError ? <ErrorState message={runError} /> : null}
          <div className="row">
            <Button onClick={() => void startRun()} loading={runPending} disabled={!machineId}>
              Confirm ${(budgetCents / 100).toFixed(2)} cap — start
            </Button>
            <Button variant="secondary" onClick={() => setRunOpen(false)} disabled={runPending}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
