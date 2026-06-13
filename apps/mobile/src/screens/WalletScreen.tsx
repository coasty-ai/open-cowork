/**
 * Wallet: Coasty balance + this month's open-cowork spend, plus sign-out.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, ApiError, type WalletDto } from '../api';
import { AppButton, ErrorNote, Loading, ScreenTitle } from '../components';
import { useAuth } from '../auth';
import { colors, formatCents, radius, spacing, typography } from '../theme';

export function WalletScreen() {
  const { user, signOut } = useAuth();
  const [wallet, setWallet] = useState<WalletDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setWallet(await api.wallet());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the wallet');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (wallet === null && error === null) return <Loading label="Loading wallet…" />;

  return (
    <View style={styles.root}>
      <ScreenTitle title="Wallet" />
      {error !== null ? <ErrorNote message={error} onRetry={() => void load()} /> : null}
      {wallet ? (
        <View style={styles.body}>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Coasty balance</Text>
            <Text style={styles.balance}>{formatCents(wallet.balanceCents)}</Text>
          </View>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Spent this month</Text>
            <Text style={styles.spend}>{formatCents(wallet.monthSpendCents)}</Text>
            <Text style={styles.meta}>Billing period {wallet.period}</Text>
          </View>
          {user ? <Text style={styles.meta}>Signed in as {user.email}</Text> : null}
          <AppButton
            accessibilityLabel="Sign out"
            kind="secondary"
            label="Sign out"
            onPress={signOut}
          />
        </View>
      ) : null}
    </View>
  );
}

const { fontSize, fontWeight } = typography;

const styles = StyleSheet.create({
  root: { backgroundColor: colors.bg, flex: 1 },
  body: { gap: spacing.md, paddingHorizontal: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
    padding: spacing.lg,
  },
  cardLabel: { color: colors.textMuted, fontSize: fontSize.sm },
  // Hero figures land at the top of the shared scale (h1 / h2) for one hierarchy.
  balance: { color: colors.success, fontSize: fontSize['3xl'], fontWeight: fontWeight.bold },
  spend: { color: colors.text, fontSize: fontSize['2xl'], fontWeight: fontWeight.bold },
  meta: { color: colors.textMuted, fontSize: fontSize.xs },
});
