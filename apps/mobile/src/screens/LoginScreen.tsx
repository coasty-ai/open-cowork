/**
 * Login: email -> POST /api/auth/login -> store the session token in the
 * module-level store, then hand the user object up to the app shell.
 */
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { api, ApiError, setToken, type SessionUser } from '../api';
import { AppButton } from '../components';
import { colors, radius, spacing } from '../theme';

export interface LoginScreenProps {
  onSuccess: (user: SessionUser) => void;
}

export function LoginScreen({ onSuccess }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = email.trim();
    if (!trimmed) {
      setError('Enter your email to sign in');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(trimmed);
      setToken(res.token);
      onSuccess(res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <Text style={styles.brand}>open-cowork</Text>
      <Text style={styles.tagline}>
        Monitor runs, watch the machine screen, and approve human steps from your phone.
      </Text>
      <TextInput
        accessibilityLabel="Email"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        onChangeText={setEmail}
        onSubmitEditing={() => void submit()}
        placeholder="you@example.com"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        value={email}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <AppButton
        accessibilityLabel="Sign in"
        disabled={busy}
        label={busy ? 'Signing in…' : 'Sign in'}
        onPress={() => void submit()}
      />
      <Text style={styles.hint}>
        Demo gate: any email signs in to your backend instance. The Coasty key stays server-side.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: colors.bg,
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  brand: { color: colors.accent, fontSize: 28, fontWeight: '800' },
  tagline: { color: colors.textMuted, fontSize: 15, marginBottom: spacing.md },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  error: { color: colors.danger, fontSize: 14 },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: spacing.md },
});
