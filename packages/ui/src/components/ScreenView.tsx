import { cx } from '../cx';

/** Props for {@link ScreenView}. */
export interface ScreenViewProps {
  /**
   * Raw base64 PNG frame (no `data:` prefix — matches the Coasty machine
   * screenshot endpoint's `image_b64`). When absent, a placeholder renders.
   */
  frameB64?: string;
  /** Image alt text. Defaults to "Remote screen". */
  alt?: string;
  /** Shows a LIVE badge while frames are streaming. */
  live?: boolean;
  /**
   * Frame age (seconds) after which the view is flagged stale. Requires
   * `lastFrameAt`.
   */
  staleAfterSeconds?: number;
  /** ISO-8601 capture time of the current frame. */
  lastFrameAt?: string;
  className?: string;
}

function isStale(staleAfterSeconds: number | undefined, lastFrameAt: string | undefined): boolean {
  if (staleAfterSeconds === undefined || lastFrameAt === undefined) return false;
  const at = Date.parse(lastFrameAt);
  if (Number.isNaN(at)) return false;
  return Date.now() - at > staleAfterSeconds * 1000;
}

/**
 * Renders a remote machine's screen from periodic base64 screenshot frames,
 * with optional LIVE and stale indicators. Apps map the Coasty screenshot
 * response (`image_b64`, `captured_at`) into `frameB64` / `lastFrameAt`.
 */
export function ScreenView({
  frameB64,
  alt = 'Remote screen',
  live = false,
  staleAfterSeconds,
  lastFrameAt,
  className,
}: ScreenViewProps) {
  const stale = isStale(staleAfterSeconds, lastFrameAt);
  return (
    <figure className={cx('oc-screen-view', className)}>
      {live ? <span className="oc-screen-view__live">LIVE</span> : null}
      {stale ? (
        <span role="status" className="oc-screen-view__stale">
          Stale frame
        </span>
      ) : null}
      {frameB64 ? (
        <img
          className="oc-screen-view__frame"
          src={`data:image/png;base64,${frameB64}`}
          alt={alt}
        />
      ) : (
        <p className="oc-screen-view__placeholder">Waiting for the first frame…</p>
      )}
    </figure>
  );
}
