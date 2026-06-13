import type { ReactNode } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';

/** Props for {@link ApiKeyGate}. */
export interface ApiKeyGateProps {
  /** Feature name to make the headline specific, e.g. "Machines". Plural reads
   * best ("Machines need a Coasty API key"). */
  feature?: string;
  /** Primary action — typically a button/link routing to Settings. */
  action?: ReactNode;
  className?: string;
}

/**
 * The single, shared "this needs a Coasty API key" state — an informative empty
 * state, not an error. One consistent message everywhere a feature is gated on
 * the key, plus a primary action to add one. Keep the copy here so it never
 * diverges per page.
 */
export function ApiKeyGate({ feature, action, className }: ApiKeyGateProps) {
  return (
    <EmptyState
      className={className}
      icon={<Icon name="key" size={26} />}
      title={feature ? `${feature} need a Coasty API key` : 'Coasty API key required'}
      description="This feature runs on Coasty cloud machines, which require an API key. Add yours in Settings to continue."
      action={action}
    />
  );
}
