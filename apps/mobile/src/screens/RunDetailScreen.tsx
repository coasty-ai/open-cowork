/**
 * Run detail: status chip + task, the live machine screen (screenshot frames
 * as base64 PNG, polled every 2s while a cloud run is running — assumption A3),
 * an append-only event timeline fed by the REST polling fallback
 * (GET /api/runs/:id/events.json?after=N), and the approval bar when the run
 * pauses in 'awaiting_human' (note + Approve→resume / Reject→cancel).
 */
import { useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type RunDto, type RunEventDto } from '../api';
import { ApprovalBar, AppButton, BackHeader, Loading, StatusChip } from '../components';
import { colors, formatCents, radius, spacing, typography } from '../theme';

const POLL_MS = 2000;
const ACTIVE_STATUSES = new Set(['queued', 'running', 'awaiting_human']);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export interface RunDetailScreenProps {
  runId: string;
  onBack: () => void;
}

export function RunDetailScreen({ runId, onBack }: RunDetailScreenProps) {
  const [run, setRun] = useState<RunDto | null>(null);
  const [events, setEvents] = useState<RunEventDto[]>([]);
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [acting, setActing] = useState(false);

  useEffect(() => {
    let alive = true;
    let after = 0;

    const tick = async (): Promise<void> => {
      try {
        const [r, page] = await Promise.all([api.getRun(runId), api.pollRunEvents(runId, after)]);
        if (!alive) return;
        setRun(r);
        if (page.events.length > 0) {
          const last = page.events[page.events.length - 1];
          if (last) after = last.seq;
          setEvents((prev) => [...prev, ...page.events]);
        }
        setError(null);
        // Live screen frames only make sense for cloud runs that are running.
        if (r.kind === 'coasty' && r.machineId !== null && r.status === 'running') {
          const shot = await api.machineScreenshot(r.machineId);
          if (alive) setFrame(shot.image_b64);
        }
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : 'Failed to load the run');
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [runId]);

  const act = async (fn: () => Promise<RunDto>): Promise<void> => {
    setActing(true);
    try {
      const updated = await fn();
      setRun(updated);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setActing(false);
    }
  };

  return (
    <View style={styles.root}>
      <BackHeader
        label="Back"
        onBack={onBack}
        trailing={run ? <StatusChip status={run.status} /> : null}
      />

      {run === null && error === null ? <Loading label="Loading run…" /> : null}
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}

      {run ? (
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.task}>{run.task}</Text>
          <Text style={styles.meta}>
            {run.kind === 'local' ? 'local machine' : (run.machineId ?? 'cloud')} ·{' '}
            {run.stepsCompleted}/{run.maxSteps} steps · {formatCents(run.costCents)} so far
          </Text>

          {frame !== null ? (
            <Image
              accessibilityLabel="Machine screen"
              resizeMode="contain"
              source={{ uri: `data:image/png;base64,${frame}` }}
              style={styles.screen}
            />
          ) : null}

          {run.status === 'awaiting_human' ? (
            <ApprovalBar
              acting={acting}
              note={note}
              notePlaceholder="Add a note for the agent (optional)"
              onApprove={() =>
                void act(() => api.resumeRun(runId, note.length > 0 ? note : undefined))
              }
              onChangeNote={setNote}
              onReject={() => void act(() => api.cancelRun(runId))}
              reason={run.awaitingHumanReason ?? 'The agent paused and needs your decision.'}
            />
          ) : null}

          {ACTIVE_STATUSES.has(run.status) ? (
            <AppButton
              accessibilityLabel="Cancel run"
              disabled={acting}
              kind="destructive"
              label="Cancel run"
              onPress={() => void act(() => api.cancelRun(runId))}
            />
          ) : null}

          {TERMINAL_STATUSES.has(run.status) ? (
            <Text style={styles.finalCost}>Final cost: {formatCents(run.costCents)}</Text>
          ) : null}
          {run.error?.message ? <Text style={styles.error}>{run.error.message}</Text> : null}

          <Text style={styles.sectionTitle}>Timeline</Text>
          {events.length === 0 ? <Text style={styles.meta}>No events yet.</Text> : null}
          {events.map((e) => (
            <View key={e.seq} style={styles.event}>
              <Text style={styles.eventType}>
                #{e.seq} {e.type}
              </Text>
              <Text numberOfLines={3} style={styles.eventData}>
                {summarize(e.data)}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function summarize(data: Record<string, unknown>): string {
  const json = JSON.stringify(data);
  if (json === '{}') return '—';
  return json.length > 160 ? `${json.slice(0, 160)}…` : json;
}

const { fontSize, fontWeight } = typography;

const styles = StyleSheet.create({
  root: { backgroundColor: colors.bg, flex: 1 },
  scroll: { gap: spacing.md, paddingBottom: spacing.xl, paddingHorizontal: spacing.lg },
  task: { color: colors.text, fontSize: fontSize.xl, fontWeight: fontWeight.semibold },
  meta: { color: colors.textMuted, fontSize: fontSize.sm },
  screen: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    // Fixed media viewport for the live machine frame (not spacing) — kept as-is.
    height: 220,
    width: '100%',
  },
  finalCost: { color: colors.success, fontSize: fontSize.lg, fontWeight: fontWeight.bold },
  sectionTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    marginTop: spacing.sm,
  },
  event: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.xs / 2,
    padding: spacing.sm,
  },
  eventType: { color: colors.text, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },
  eventData: { color: colors.textMuted, fontSize: fontSize.xs },
  error: { color: colors.danger, fontSize: fontSize.base, paddingHorizontal: spacing.lg },
});
