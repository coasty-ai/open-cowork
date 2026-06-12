/**
 * Runs list: FlatList of cloud + local runs with status chips. Polls
 * GET /api/runs every 5s (and supports pull-to-refresh). While polling, any
 * run in 'awaiting_human' raises the in-app notification banner at the top —
 * tapping it jumps straight to that run (OS push is stubbed, see README).
 */
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type RunDto } from '../api';
import { EmptyState, ErrorNote, Loading, ScreenTitle, StatusChip } from '../components';
import { colors, formatCents, radius, spacing } from '../theme';

const POLL_MS = 5000;

export interface RunsScreenProps {
  onOpenRun: (id: string) => void;
}

export function RunsScreen({ onOpenRun }: RunsScreenProps) {
  const [runs, setRuns] = useState<RunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listRuns();
      setRuns(res.runs);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load runs');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const awaiting = runs?.find((r) => r.status === 'awaiting_human');

  if (runs === null && error === null) return <Loading label="Loading runs…" />;

  return (
    <View style={styles.root}>
      <ScreenTitle title="Runs" />
      {awaiting ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="A run needs your approval"
          onPress={() => onOpenRun(awaiting.id)}
          style={styles.banner}
        >
          <Text style={styles.bannerTitle}>A run needs your approval</Text>
          <Text numberOfLines={1} style={styles.bannerTask}>
            {awaiting.task}
          </Text>
        </Pressable>
      ) : null}
      {error !== null ? <ErrorNote message={error} onRetry={() => void load()} /> : null}
      <FlatList
        data={runs ?? []}
        keyExtractor={(r) => r.id}
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          void load().finally(() => setRefreshing(false));
        }}
        ListEmptyComponent={
          runs !== null ? (
            <EmptyState message="No runs yet — delegate a task from the web or desktop app." />
          ) : null
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open run ${item.id}`}
            onPress={() => onOpenRun(item.id)}
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
          >
            <View style={styles.cardHeader}>
              <StatusChip status={item.status} />
              <Text style={styles.cardCost}>{formatCents(item.costCents)}</Text>
            </View>
            <Text numberOfLines={2} style={styles.cardTask}>
              {item.task}
            </Text>
            <Text style={styles.cardMeta}>
              {item.kind === 'local' ? 'local machine' : (item.machineId ?? 'cloud')} ·{' '}
              {item.stepsCompleted}/{item.maxSteps} steps
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.bg, flex: 1 },
  banner: {
    backgroundColor: colors.warning,
    borderRadius: radius.md,
    gap: 2,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
  },
  bannerTitle: { color: colors.accentContrast, fontSize: 14, fontWeight: '700' },
  bannerTask: { color: colors.accentContrast, fontSize: 13 },
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
  cardCost: { color: colors.textMuted, fontSize: 13 },
  cardTask: { color: colors.text, fontSize: 15, fontWeight: '500' },
  cardMeta: { color: colors.textMuted, fontSize: 12 },
});
