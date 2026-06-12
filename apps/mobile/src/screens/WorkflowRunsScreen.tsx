/**
 * Workflow runs: list (polled every 5s) + a detail-lite view for one run with
 * approve/reject for 'awaiting_human' pauses. Workflow resume takes
 * {approved, note} — unlike plain run resume, which only takes {note}.
 */
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError, type WorkflowRunDto } from '../api';
import { AppButton, EmptyState, ErrorNote, Loading, ScreenTitle, StatusChip } from '../components';
import { colors, formatCents, radius, spacing } from '../theme';

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
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to workflow runs"
            onPress={() => setSelected(null)}
            style={styles.backButton}
          >
            <Text style={styles.backLabel}>‹ Workflow runs</Text>
          </Pressable>
          <StatusChip status={selected.status} />
        </View>
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
            <View style={styles.approval}>
              <Text style={styles.approvalReason}>
                {selected.awaitingReason ?? 'This workflow paused for your approval.'}
              </Text>
              <TextInput
                accessibilityLabel="Approval note"
                onChangeText={setNote}
                placeholder="Add a note (optional)"
                placeholderTextColor={colors.textMuted}
                style={styles.noteInput}
                value={note}
              />
              <View style={styles.approvalActions}>
                <AppButton
                  accessibilityLabel="Approve"
                  disabled={acting}
                  label="Approve"
                  onPress={() => void decide(true)}
                />
                <AppButton
                  accessibilityLabel="Reject"
                  disabled={acting}
                  kind="danger"
                  label="Reject"
                  onPress={() => void decide(false)}
                />
              </View>
            </View>
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open workflow run ${item.id}`}
            onPress={() => void open(item.id)}
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
          >
            <View style={styles.cardHeader}>
              <StatusChip status={item.status} />
              <Text style={styles.meta}>{formatCents(item.spentCents)}</Text>
            </View>
            <Text style={styles.cardTitle}>
              {item.workflowId ? `Workflow ${item.workflowId}` : 'Ad-hoc workflow'}
            </Text>
            <Text style={styles.meta}>{item.id}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.bg, flex: 1 },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  backButton: { paddingVertical: spacing.xs, paddingRight: spacing.md },
  backLabel: { color: colors.accent, fontSize: 16, fontWeight: '600' },
  detail: { gap: spacing.md, paddingHorizontal: spacing.lg },
  detailTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 13 },
  approval: {
    backgroundColor: colors.surface,
    borderColor: colors.warning,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  approvalReason: { color: colors.warning, fontSize: 14, fontWeight: '600' },
  approvalActions: { flexDirection: 'row', gap: spacing.md },
  noteInput: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text,
    fontSize: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    padding: spacing.md,
  },
  cardPressed: { backgroundColor: colors.surfaceRaised },
  cardHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '500' },
  error: { color: colors.danger, fontSize: 14 },
});
