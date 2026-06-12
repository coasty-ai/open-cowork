import { useEffect, useRef, useState } from 'react';
import { cx } from '../cx';

/** Props for {@link CodeBlock}. */
export interface CodeBlockProps {
  /** The code to display (and copy). */
  code: string;
  /** Optional language hint; emitted as a `language-*` class on `<code>`. */
  language?: string;
  className?: string;
}

const COPIED_RESET_MS = 2000;

/**
 * Monospace `<pre><code>` block with a clipboard copy button
 * (`aria-label="Copy code"`). The button briefly shows "Copied" after a
 * successful `navigator.clipboard.writeText`.
 */
export function CodeBlock({ code, language, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      // Clipboard unavailable (insecure context / permission denied) — keep
      // the button in its idle state rather than crashing.
    }
  };

  return (
    <div className={cx('oc-codeblock', className)}>
      <button
        type="button"
        className="oc-codeblock__copy"
        aria-label="Copy code"
        onClick={() => {
          void copy();
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="oc-codeblock__pre">
        <code className={language ? `language-${language}` : undefined}>{code}</code>
      </pre>
    </div>
  );
}
