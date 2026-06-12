import { cx } from '../cx';

/** Props for {@link OfflineBanner}. */
export interface OfflineBannerProps {
  /** Renders the banner only while true. */
  offline: boolean;
  /** Override the default banner text. */
  message?: string;
  className?: string;
}

/**
 * Connectivity banner (`role="status"`). Renders nothing while online so it
 * can be mounted unconditionally and driven by an `online`/`offline` hook.
 */
export function OfflineBanner({
  offline,
  message = 'You are offline — live updates are paused.',
  className,
}: OfflineBannerProps) {
  if (!offline) return null;
  return (
    <div role="status" className={cx('oc-offline-banner', className)}>
      {message}
    </div>
  );
}
