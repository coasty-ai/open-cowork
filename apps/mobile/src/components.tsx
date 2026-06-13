/**
 * Small shared RN primitives (dark theme). Plain react-native components only
 * so every screen renders identically through react-native-web.
 *
 * These MIRROR the web component contract from `@open-cowork/ui` — same variant
 * vocabulary, sizes, curated status labels and tones — without sharing the
 * (DOM/CSS-bound) implementation. The curated status vocabulary + money helper
 * are imported from `@open-cowork/tokens` so both platforms read the SAME source.
 */
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { RUN_STATUS_META, type StatusTone, themes } from '@open-cowork/tokens';
import { colors, radius, spacing, typography } from './theme';

/** Direct role tokens the legacy `colors` map doesn't expose (solid destructive fill). */
const role = themes.dark;

// ── AppButton ───────────────────────────────────────────────────────────────

/**
 * Visual variant of an {@link AppButton}, mirroring web's `Button` contract.
 * `destructive` is a SOLID-fill danger action (matches web); `danger` is a kept
 * alias so existing call sites keep working — prefer `destructive` in new code.
 */
export type AppButtonVariant = 'primary' | 'secondary' | 'destructive' | 'danger';

/** Size of an {@link AppButton}. Mirrors web's `sm | md`. */
export type AppButtonSize = 'sm' | 'md';

export interface AppButtonProps {
  label: string;
  onPress: () => void;
  /** Visual variant. Defaults to `primary`. (`kind` is the historical prop name.) */
  kind?: AppButtonVariant;
  /** Size. Defaults to `md`. */
  size?: AppButtonSize;
  /**
   * When true, shows an inline spinner and disables the button so an in-flight
   * action can't be re-triggered (parity with web's `loading`).
   */
  loading?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}

export function AppButton({
  label,
  onPress,
  kind = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  accessibilityLabel,
}: AppButtonProps) {
  // `danger` is a deprecated alias of `destructive` — collapse it once here.
  const variant = kind === 'danger' ? 'destructive' : kind;
  const isDisabled = disabled || loading;
  const onAccent = variant === 'primary' || variant === 'destructive';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        size === 'sm' ? styles.buttonSm : styles.buttonMd,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'destructive' && styles.buttonDestructive,
        pressed && styles.buttonPressed,
        isDisabled && styles.buttonDisabled,
      ]}
    >
      {loading ? (
        <ActivityIndicator
          accessibilityLabel="Loading"
          color={onAccent ? role.destructiveForeground : colors.text}
          size="small"
        />
      ) : null}
      <Text
        style={[
          styles.buttonLabel,
          size === 'sm' && styles.buttonLabelSm,
          onAccent ? styles.buttonLabelOnAccent : styles.buttonLabelPlain,
          variant === 'destructive' && styles.buttonLabelOnDestructive,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// ── StatusChip ──────────────────────────────────────────────────────────────

/**
 * Resolve a curated {@link StatusTone} (the same vocabulary web's Badge uses)
 * to a mobile palette color. `info` (e.g. Running) deliberately resolves to the
 * neutral near-white accent — the palette has ZERO blue, exactly like web.
 */
const TONE_COLOR: Record<StatusTone, string> = {
  neutral: colors.textMuted,
  info: colors.info, // === colors.accent (#fafafa); "running" reads as the accent, not a hue
  success: colors.success,
  warning: colors.warning,
  danger: colors.danger,
};

/** Title-case a raw status not covered by the curated run-status map (e.g. machine states). */
function fallbackLabel(status: string): string {
  const spaced = status.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function StatusChip({ status }: { status: string }) {
  // Curated label + tone when the status is a known run state; otherwise fall
  // back to a Title-cased label (covers machine states like "stopped").
  const meta = (RUN_STATUS_META as Record<string, { tone: StatusTone; label: string }>)[status];
  const tone = meta ? TONE_COLOR[meta.tone] : colors.textMuted;
  const label = meta ? meta.label : fallbackLabel(status);
  return (
    <View style={[styles.chip, { borderColor: tone }]}>
      <Text style={[styles.chipText, { color: tone }]}>{label}</Text>
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
        <AppButton
          label="Retry"
          kind="secondary"
          size="sm"
          onPress={onRetry}
          accessibilityLabel="Retry"
        />
      ) : null}
    </View>
  );
}

export function ScreenTitle({ title }: { title: string }) {
  return <Text style={styles.screenTitle}>{title}</Text>;
}

// ── BackHeader ───────────────────────────────────────────────────────────────

/**
 * The stack-style header used by every detail screen: a back affordance on the
 * left and an optional trailing slot (typically a StatusChip). Extracted so the
 * run-detail and workflow-run headers are byte-for-byte identical.
 */
export interface BackHeaderProps {
  label: string;
  onBack: () => void;
  accessibilityLabel?: string;
  trailing?: ReactNode;
}

export function BackHeader({ label, onBack, accessibilityLabel, trailing }: BackHeaderProps) {
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? 'Back'}
        onPress={onBack}
        style={styles.backButton}
      >
        <Text style={styles.backLabel}>‹ {label}</Text>
      </Pressable>
      {trailing ?? null}
    </View>
  );
}

// ── ListCard ─────────────────────────────────────────────────────────────────

/**
 * A surface card used in every list. Pressable when `onPress`/`accessibilityLabel`
 * are supplied (runs, workflow runs), static otherwise (machines). One source so
 * identical-looking cards share identical code.
 */
export interface ListCardProps {
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function ListCard({ children, onPress, accessibilityLabel, style }: ListCardProps) {
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed, style]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

/** Header row of a {@link ListCard}: leading content + trailing content, space-between. */
export function CardHeader({ children }: { children: ReactNode }) {
  return <View style={styles.cardHeader}>{children}</View>;
}

// ── ApprovalBar ──────────────────────────────────────────────────────────────

/**
 * The "awaiting human" approval block: a reason line, an optional-note input,
 * and Approve / Reject buttons. Shared verbatim by the run-detail and
 * workflow-run screens (their copies had drifted only in placeholder text).
 */
export interface ApprovalBarProps {
  reason: string;
  note: string;
  onChangeNote: (value: string) => void;
  onApprove: () => void;
  onReject: () => void;
  acting?: boolean;
  notePlaceholder?: string;
}

export function ApprovalBar({
  reason,
  note,
  onChangeNote,
  onApprove,
  onReject,
  acting = false,
  notePlaceholder = 'Add a note (optional)',
}: ApprovalBarProps) {
  return (
    <View style={styles.approval}>
      <Text style={styles.approvalReason}>{reason}</Text>
      <TextInput
        accessibilityLabel="Approval note"
        onChangeText={onChangeNote}
        placeholder={notePlaceholder}
        placeholderTextColor={colors.textMuted}
        style={styles.noteInput}
        value={note}
      />
      <View style={styles.approvalActions}>
        <AppButton
          accessibilityLabel="Approve"
          disabled={acting}
          label="Approve"
          onPress={onApprove}
        />
        <AppButton
          accessibilityLabel="Reject"
          disabled={acting}
          kind="destructive"
          label="Reject"
          onPress={onReject}
        />
      </View>
    </View>
  );
}

// ── BrandLogo ────────────────────────────────────────────────────────────────

/**
 * The open-cowork "horizon" mark + wordmark, dependency-free.
 *
 * React Native core has no gradient primitive, so the same six brand stops
 * (see packages/ui `<Logo>` / public/logo_*.svg) are reproduced as a stack of
 * interpolated horizontal bands clipped to a circle — faithful at the small
 * sizes we render, and identical through react-native-web in tests.
 */
const BRAND_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.25, 0.06],
  [0.45, 0.18],
  [0.6, 0.4],
  [0.8, 0.75],
  [1, 1],
];
const BRAND_BANDS = 16;

/** Piecewise-linear opacity of the horizon gradient at vertical position `t` (0..1). */
function brandOpacityAt(t: number): number {
  for (let i = 1; i < BRAND_STOPS.length; i++) {
    const [x0, y0] = BRAND_STOPS[i - 1]!;
    const [x1, y1] = BRAND_STOPS[i]!;
    if (t <= x1) return y0 + ((t - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 1;
}

export interface BrandLogoProps {
  size?: number;
  withWordmark?: boolean;
}

export function BrandLogo({ size = 28, withWordmark = true }: BrandLogoProps) {
  return (
    <View accessibilityRole="image" accessibilityLabel="open-cowork" style={styles.brandRow}>
      <View style={[styles.brandMark, { width: size, height: size, borderRadius: size / 2 }]}>
        {Array.from({ length: BRAND_BANDS }, (_, i) => {
          const t = (i + 0.5) / BRAND_BANDS;
          return (
            <View
              key={i}
              style={{
                flex: 1,
                backgroundColor: `rgba(250,250,250,${brandOpacityAt(t).toFixed(3)})`,
              }}
            />
          );
        })}
      </View>
      {withWordmark ? (
        <Text style={[styles.brandWord, { fontSize: size * 0.64 }]}>open-cowork</Text>
      ) : null}
    </View>
  );
}

/** Weights from the shared scale. RN accepts the numeric (400..900) form directly. */
const WEIGHT = typography.fontWeight;

/** A 2px hairline gap — half of the smallest spacing token; the only sub-token value we keep. */
const HAIRLINE = spacing.xs / 2;

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: radius.md,
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'center',
  },
  // 44px minimum touch target on both sizes.
  buttonMd: { minHeight: 44, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  buttonSm: { minHeight: 44, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonSecondary: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
  },
  // Web parity: destructive is a SOLID fill (was an outline on mobile).
  buttonDestructive: { backgroundColor: role.destructive },
  buttonPressed: { opacity: 0.75 },
  buttonDisabled: { opacity: 0.5 },
  buttonLabel: { fontSize: typography.fontSize.md, fontWeight: WEIGHT.semibold },
  buttonLabelSm: { fontSize: typography.fontSize.sm },
  buttonLabelOnAccent: { color: colors.accentContrast },
  buttonLabelPlain: { color: colors.text },
  buttonLabelOnDestructive: { color: role.destructiveForeground },

  chip: {
    alignSelf: 'flex-start',
    borderRadius: radius.full,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: HAIRLINE,
  },
  chipText: { fontSize: typography.fontSize.xs, fontWeight: WEIGHT.semibold },

  centered: {
    alignItems: 'center',
    gap: spacing.sm,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  mutedText: { color: colors.textMuted, fontSize: typography.fontSize.base },

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
  errorText: { color: colors.danger, fontSize: typography.fontSize.base },

  screenTitle: {
    color: colors.text,
    fontSize: typography.fontSize['2xl'],
    fontWeight: WEIGHT.bold,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },

  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.lg,
  },
  backButton: { paddingVertical: spacing.xs, paddingRight: spacing.md },
  backLabel: {
    color: colors.accent,
    fontSize: typography.fontSize.lg,
    fontWeight: WEIGHT.semibold,
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

  approval: {
    backgroundColor: colors.surface,
    borderColor: colors.warning,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md,
  },
  approvalReason: {
    color: colors.warning,
    fontSize: typography.fontSize.base,
    fontWeight: WEIGHT.semibold,
  },
  approvalActions: { flexDirection: 'row', gap: spacing.md },
  noteInput: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text,
    fontSize: typography.fontSize.base,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },

  brandRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  brandMark: { flexDirection: 'column', overflow: 'hidden' },
  brandWord: { color: colors.text, fontWeight: '800', letterSpacing: -0.3 },
});
