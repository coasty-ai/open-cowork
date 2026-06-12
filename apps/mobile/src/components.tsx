/**
 * Small shared RN primitives (dark theme). Plain react-native components only
 * so every screen renders identically through react-native-web.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from './theme';

// ── AppButton ───────────────────────────────────────────────────────────────

export interface AppButtonProps {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  accessibilityLabel?: string;
}

export function AppButton({
  label,
  onPress,
  kind = 'primary',
  disabled = false,
  accessibilityLabel,
}: AppButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' && styles.buttonPrimary,
        kind === 'secondary' && styles.buttonSecondary,
        kind === 'danger' && styles.buttonDanger,
        pressed && styles.buttonPressed,
        disabled && styles.buttonDisabled,
      ]}
    >
      <Text
        style={[
          styles.buttonLabel,
          kind === 'primary' ? styles.buttonLabelOnAccent : styles.buttonLabelPlain,
          kind === 'danger' && styles.buttonLabelDanger,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ── StatusChip ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  queued: colors.info,
  pending: colors.info,
  running: colors.accent,
  awaiting_human: colors.warning,
  succeeded: colors.success,
  failed: colors.danger,
  timed_out: colors.danger,
  cancelled: colors.textMuted,
  stopped: colors.textMuted,
  terminated: colors.textMuted,
  provisioning: colors.info,
};

export function StatusChip({ status }: { status: string }) {
  const tint = STATUS_COLORS[status] ?? colors.textMuted;
  return (
    <View style={[styles.chip, { borderColor: tint }]}>
      <Text style={[styles.chipText, { color: tint }]}>{status.replace(/_/g, ' ')}</Text>
    </View>
  );
}

// ── Loading / Empty / Error ─────────────────────────────────────────────────

export function Loading({ label }: { label: string }) {
  return (
    <View style={styles.centered}>
      <ActivityIndicator color={colors.accent} accessibilityLabel={label} />
      <Text style={styles.mutedText}>{label}</Text>
    </View>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <View style={styles.centered}>
      <Text style={styles.mutedText}>{message}</Text>
    </View>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={styles.errorBox}>
      <Text style={styles.errorText}>{message}</Text>
      {onRetry ? (
        <AppButton label="Retry" kind="secondary" onPress={onRetry} accessibilityLabel="Retry" />
      ) : null}
    </View>
  );
}

export function ScreenTitle({ title }: { title: string }) {
  return <Text style={styles.screenTitle}>{title}</Text>;
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonSecondary: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
  },
  buttonDanger: {
    backgroundColor: 'transparent',
    borderColor: colors.danger,
    borderWidth: 1,
  },
  buttonPressed: { opacity: 0.75 },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { fontSize: 15, fontWeight: '600' },
  buttonLabelOnAccent: { color: colors.accentContrast },
  buttonLabelPlain: { color: colors.text },
  buttonLabelDanger: { color: colors.danger },

  chip: {
    alignSelf: 'flex-start',
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  chipText: { fontSize: 12, fontWeight: '600' },

  centered: {
    alignItems: 'center',
    gap: spacing.sm,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  mutedText: { color: colors.textMuted, fontSize: 14 },

  errorBox: {
    alignItems: 'flex-start',
    backgroundColor: colors.surface,
    borderColor: colors.danger,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
    margin: spacing.md,
    padding: spacing.md,
  },
  errorText: { color: colors.danger, fontSize: 14 },

  screenTitle: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
});
