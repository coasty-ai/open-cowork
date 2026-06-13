/**
 * Workflow runs: list (polled every 5s) + a detail-lite view for one run with
 * approve/reject for 'awaiting_human' pauses. Workflow resume takes
 * {approved, note} — unlike plain run resume, which only takes {note}.
 */
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type WorkflowRunDto } from '../api';
import {
  ApprovalBar,
  BackHeader,
  CardHeader,
  EmptyState,
  ErrorNote,
  ListCard,
  Loading,
  ScreenTitle,
  StatusChip,
} from '../components';
import { colors, formatCents, spacing, typography } from '../theme';

const POLL_MS = 5000;

export function WorkflowRunsScreen() {
  const [runs, setRuns] = useState<WorkflowRunDto[] | null>(null);
  const [selected, setSelected] = useState<WorkflowRunDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listWorkflowRuns();
      setRuns(res.runs);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load workflow runs');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const open = async (id: string): Promise<void> => {
    try {
      setSelected(await api.getWorkflowRun(id));
      setNote('');
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the workflow run');
    }
  };

  const decide = async (approved: boolean): Promise<void> => {
    if (!selected) return;
    setActing(true);
    try {
      const updated = await api.resumeWorkflowRun(selected.id, {
        approved,
        note: note.length > 0 ? note : undefined,
      });
      setSelected(updated);
      setError(null);
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Decision failed');
    } finally {
      setActing(false);
    }
  };

  if (selected) {
    return (
      <View style={styles.root}>
        <BackHeader
          accessibilityLabel="Back to workflow runs"
          label="Workflow runs"
          onBack={() => setSelected(null)}
          trailing={<StatusChip status={selected.status} />}
        />
        <View style={styles.detail}>
          <Text style={styles.detailTitle}>
            {selected.workflowId ? `Workflow ${selected.workflowId}` : 'Ad-hoc workflow'} ·{' '}
            {selected.id}
          </Text>
          <Text style={styles.meta}>
            Spent {formatCents(selected.spentCents)} of {formatCents(selected.budgetCents)} budget
          </Text>
          {selected.awaitingStepId ? (
            <Text style={styles.meta}>Waiting on step “{selected.awaitingStepId}”</Text>
          ) : null}
          {error !== null ? <Text style={styles.error}>{error}</Text> : null}

          {selected.status === 'awaiting_human' ? (
            <ApprovalBar
              acting={acting}
              note={note}
              onApprove={() => void decide(true)}
              onChangeNote={setNote}
              onReject={() => void decide(false)}
              reason={selected.awaitingReason ?? 'This workflow paused for your approval.'}
            />
          ) : null}
          {selected.error?.message ? (
            <Text style={styles.error}>{selected.error.message}</Text>
          ) : null}
        </View>
      </View>
    );
  }

  if (runs === null && error === null) return <Loading label="Loading workflow runs…" />;

  return (
    <View style={styles.root}>
      <ScreenTitle title="Workflow runs" />
      {error !== null ? <ErrorNote message={error} onRetry={() => void load()} /> : null}
      <FlatList
        data={runs ?? []}
        keyExtractor={(r) => r.id}
        ListEmptyComponent={runs !== null ? <EmptyState message="No workflow runs yet." /> : null}
        renderItem={({ item }) => (
          <ListCard
            accessibilityLabel={`Open workflow run ${item.id}`}
            onPress={() => void open(item.id)}
          >
            <CardHeader>
              <StatusChip status={item.status} />
              <Text style={styles.meta}>{formatCents(item.spentCents)}</Text>
            </CardHeader>
            <Text style={styles.cardTitle}>
              {item.workflowId ? `Workflow ${item.workflowId}` : 'Ad-hoc workflow'}
            </Text>
            <Text style={styles.meta}>{item.id}</Text>
          </ListCard>
        )}
      />
    </View>
  );
}

const { fontSize, fontWeight } = typography;

const styles = StyleSheet.create({
  root: { backgroundColor: colors.bg, flex: 1 },
  detail: { gap: spacing.md, paddingHorizontal: spacing.lg },
  detailTitle: { color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  meta: { color: colors.textMuted, fontSize: fontSize.sm },
  cardTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: fontWeight.medium },
  error: { color: colors.danger, fontSize: fontSize.base },
});
