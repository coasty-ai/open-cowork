import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiKeyGate,
  Button,
  CostPill,
  EmptyState,
  ErrorState,
  Icon,
  RunStatusBadge,
  Spinner,
  type RunStatus,
  Heading,
  Text,
} from '@open-cowork/ui';
import { getClient } from '../store';
import { useCoastyKey } from '../coastyKey';
import type { RunDto } from '../api/client';

export function RunsPage() {
  const client = getClient();
  const navigate = useNavigate();
  const { configured } = useCoastyKey();
  const [runs, setRuns] = useState<RunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const res = await client.listRuns();
      setRuns(res.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runs');
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (runs === null) return <Spinner aria-label="Loading runs" />;

  return (
    <>
      <div className="page-header">
        <Heading level={1}>Runs</Heading>
      </div>
      {runs.length === 0 ? (
        configured ? (
          <EmptyState title="No runs yet" description="Delegate a task from the home screen." />
        ) : (
          <ApiKeyGate action={<Button onClick={() => navigate('/settings')}>Add API key</Button>} />
        )
      ) : (
        <div className="stack">
          {runs.map((run) => (
            <Link className="run-row" to={`/runs/${run.id}`} key={run.id}>
              <RunStatusBadge status={run.status as RunStatus} />
              <Icon
                name={run.kind === 'local' ? 'laptop' : 'cloud'}
                size={16}
                title={run.kind === 'local' ? 'Local run' : 'Cloud run'}
                className="run-row__kind"
              />
              <span className="run-row__task">{run.task}</span>
              <Text variant="caption" as="span">
                {run.stepsCompleted} steps
              </Text>
              <CostPill cents={run.costCents} variant="actual" />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
