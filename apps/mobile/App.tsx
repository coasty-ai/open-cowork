/**
 * App shell: a tiny state-based navigator (no react-navigation dependency) —
 * bottom tab bar (Runs / Workflows / Machines / Wallet) plus a stack-ish
 * run-detail overlay with a back button. Login gates everything.
 *
 * Deliberately expo-free so the whole tree renders through react-native-web
 * in vitest/jsdom (DECISIONS.md D7); only index.ts touches the expo runtime.
 */
import { useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { AuthProvider, useAuth } from './src/auth';
import { LoginScreen } from './src/screens/LoginScreen';
import { RunsScreen } from './src/screens/RunsScreen';
import { RunDetailScreen } from './src/screens/RunDetailScreen';
import { WorkflowRunsScreen } from './src/screens/WorkflowRunsScreen';
import { MachinesScreen } from './src/screens/MachinesScreen';
import { WalletScreen } from './src/screens/WalletScreen';
import { colors, radius, spacing, typography } from './src/theme';

const TABS = [
  { key: 'runs', label: 'Runs' },
  { key: 'workflows', label: 'Workflows' },
  { key: 'machines', label: 'Machines' },
  { key: 'wallet', label: 'Wallet' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function Shell() {
  const { user, completeLogin } = useAuth();
  const [tab, setTab] = useState<TabKey>('runs');
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  if (!user) return <LoginScreen onSuccess={completeLogin} />;

  if (openRunId !== null) {
    return <RunDetailScreen runId={openRunId} onBack={() => setOpenRunId(null)} />;
  }

  return (
    <View style={styles.shell}>
      <View style={styles.body}>
        {tab === 'runs' ? <RunsScreen onOpenRun={setOpenRunId} /> : null}
        {tab === 'workflows' ? <WorkflowRunsScreen /> : null}
        {tab === 'machines' ? <MachinesScreen /> : null}
        {tab === 'wallet' ? <WalletScreen /> : null}
      </View>
      <View accessibilityRole="tablist" style={styles.tabBar}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            accessibilityRole="tab"
            accessibilityLabel={t.label}
            accessibilityState={{ selected: tab === t.key }}
            onPress={() => setTab(t.key)}
            style={[styles.tabItem, tab === t.key && styles.tabItemActive]}
          >
            <Text style={[styles.tabLabel, tab === t.key && styles.tabLabelActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <SafeAreaView style={styles.app}>
        <Shell />
      </SafeAreaView>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  app: { backgroundColor: colors.bg, flex: 1 },
  shell: { backgroundColor: colors.bg, flex: 1 },
  body: { flex: 1 },
  tabBar: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: 'row',
    // Tabs sit snug (a 2px hairline gap) — denser, more professional, mirroring
    // the web sidebar's tight item rhythm.
    gap: spacing.xs / 2,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  tabItem: {
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    // Transparent border on every tab so the active pill's ring doesn't shift it.
    borderWidth: 1,
    borderColor: 'transparent',
  },
  // Active indicator: a sleek filled pill with a hairline ring (mirrors the web
  // sidebar's active item — no accent bar).
  tabItemActive: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
  },
  tabLabel: {
    color: colors.textMuted,
    fontSize: typography.fontSize.sm,
    fontWeight: '600',
  },
  tabLabelActive: { color: colors.text, fontWeight: '700' },
});
