import { useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { cx } from '../cx';

/** One tab in a {@link Tabs} group. */
export interface TabItem {
  /** Stable identifier, unique within the group. */
  id: string;
  /** Tab button label. */
  label: ReactNode;
  /** Panel content shown while this tab is selected. */
  content: ReactNode;
}

/** Props for {@link Tabs}. */
export interface TabsProps {
  /** Tabs to render, in order. */
  items: TabItem[];
  /** Initially selected tab id. Defaults to the first item. */
  defaultTabId?: string;
  /** Called with the newly selected tab id. */
  onTabChange?: (id: string) => void;
  className?: string;
}

/**
 * Accessible tab group (`tablist`/`tab`/`tabpanel`) with roving focus:
 * ArrowLeft/ArrowRight move both focus and selection, wrapping at the ends.
 */
export function Tabs({ items, defaultTabId, onTabChange, className }: TabsProps) {
  const baseId = useId();
  const [activeId, setActiveId] = useState<string>(() => defaultTabId ?? items[0]?.id ?? '');
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const active = items.find((item) => item.id === activeId) ?? items[0];

  const select = (id: string) => {
    setActiveId(id);
    onTabChange?.(id);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (items.length === 0 || !active) return;
    event.preventDefault();
    const index = items.findIndex((item) => item.id === active.id);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = items[(index + delta + items.length) % items.length];
    if (!next) return;
    select(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  return (
    <div className={cx('oc-tabs', className)}>
      <div role="tablist" className="oc-tabs__list">
        {items.map((item) => {
          const selected = item.id === active?.id;
          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) tabRefs.current.set(item.id, node);
                else tabRefs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${item.id}`}
              tabIndex={selected ? 0 : -1}
              className="oc-tabs__tab"
              onClick={() => select(item.id)}
              onKeyDown={onKeyDown}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {active ? (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${active.id}`}
          aria-labelledby={`${baseId}-tab-${active.id}`}
          tabIndex={0}
          className="oc-tabs__panel"
        >
          {active.content}
        </div>
      ) : null}
    </div>
  );
}
