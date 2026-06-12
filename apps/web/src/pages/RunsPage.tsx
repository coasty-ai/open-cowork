import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CostPill, EmptyState, ErrorState, RunStatusBadge, Spinner, type RunStatus } from '@open-cowork/ui';
import { getClient } from '../store';
import type { RunDto } from '../api/client';

export function RunsPage() {
  const client = getClient();
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
        <h1 className="page-title">Runs</h1>
      </div>
      {runs.length === 0 ? (
        <EmptyState title="No runs yet" description="Delegate a task from the home screen." />
      ) : (
        <div className="stack">
          {runs.map((run) => (
            <Link className="run-row" to={`/runs/${run.id}`} key={run.id}>
              <RunStatusBadge status={run.status as RunStatus} />
              <span className="run-row__task">
                {run.kind === 'local' ? '💻 ' : '☁ '}
                {run.task}
              </span>
              <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>
                {run.stepsCompleted} steps
              </span>
              <CostPill cents={run.costCents} variant="actual" />
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
