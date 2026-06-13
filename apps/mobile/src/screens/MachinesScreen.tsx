/**
 * Machines: list cloud machines with status + start/stop. Stopped machines
 * bill 1¢/hour vs 5–9¢/hour running, so parking idle machines from the phone
 * is the main use case here.
 */
import { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type MachineDto } from '../api';
import {
  AppButton,
  CardHeader,
  EmptyState,
  ErrorNote,
  ListCard,
  Loading,
  ScreenTitle,
  StatusChip,
} from '../components';
import { colors, spacing, typography } from '../theme';

export function MachinesScreen() {
  const [machines, setMachines] = useState<MachineDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listMachines();
      setMachines(res.machines);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load machines');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusyId(id);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Machine action failed');
    } finally {
      setBusyId(null);
    }
  };

  if (machines === null && error === null) return <Loading label="Loading machines…" />;

  return (
    <View style={styles.root}>
      <ScreenTitle title="Machines" />
      {error !== null ? <ErrorNote message={error} onRetry={() => void load()} /> : null}
      <FlatList
        data={machines ?? []}
        keyExtractor={(m) => m.id}
        ListEmptyComponent={
          machines !== null ? (
            <EmptyState message="No machines yet — provision one from the web app." />
          ) : null
        }
        renderItem={({ item }) => (
          <ListCard style={styles.card}>
            <CardHeader>
              <Text style={styles.name}>{item.display_name}</Text>
              <StatusChip status={item.status} />
            </CardHeader>
            <Text style={styles.meta}>
              {item.os_type}
              {item.is_test ? ' · test machine' : ''} · {item.id}
            </Text>
            <View style={styles.actions}>
              <AppButton
                accessibilityLabel={`Start ${item.display_name}`}
                disabled={busyId === item.id || item.status === 'running'}
                kind="secondary"
                label="Start"
                onPress={() => void act(item.id, () => api.startMachine(item.id))}
              />
              <AppButton
                accessibilityLabel={`Stop ${item.display_name}`}
                disabled={busyId === item.id || item.status === 'stopped'}
                kind="destructive"
                label="Stop"
                onPress={() => void act(item.id, () => api.stopMachine(item.id))}
              />
            </View>
          </ListCard>
        )}
      />
    </View>
  );
}

const { fontSize, fontWeight } = typography;

const styles = StyleSheet.create({
  root: { backgroundColor: colors.bg, flex: 1 },
  // Machine cards carry more stacked content, so override the shared card's
  // tighter row gap with the slightly looser `sm` rhythm.
  card: { gap: spacing.sm },
  name: { color: colors.text, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
  meta: { color: colors.textMuted, fontSize: fontSize.xs },
  actions: { flexDirection: 'row', gap: spacing.md },
});
