import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { cx } from '../cx';

/** Props for {@link Modal}. */
export interface ModalProps {
  /** Whether the dialog is shown. Nothing renders while false. */
  open: boolean;
  /** Called when the user dismisses (Escape key or backdrop click). */
  onClose: () => void;
  /** Dialog title; wired to the dialog via `aria-labelledby`. */
  title: string;
  children?: ReactNode;
  className?: string;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Accessible modal dialog rendered into `document.body` via a portal.
 *
 * - `role="dialog"` + `aria-modal="true"`, labelled by the title.
 * - Escape and backdrop clicks call `onClose`.
 * - On open, focus moves to the first focusable element inside (or the
 *   dialog itself); on close, focus is restored to the previously focused
 *   element.
 */
export function Modal({ open, onClose, title, children, className }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (dialog) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? dialog).focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="oc-modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx('oc-modal', className)}
      >
        <h2 id={titleId} className="oc-modal__title">
          {title}
        </h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
