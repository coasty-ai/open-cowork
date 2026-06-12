import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from '../src/index';

const items = [
  { id: 'timeline', label: 'Timeline', content: <p>Timeline panel</p> },
  { id: 'screen', label: 'Screen', content: <p>Screen panel</p> },
  { id: 'cost', label: 'Cost', content: <p>Cost panel</p> },
];

describe('Tabs', () => {
  it('renders tablist/tab/tabpanel roles with the first tab selected', () => {
    render(<Tabs items={items} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Timeline panel');
  });

  it('honors defaultTabId', () => {
    render(<Tabs items={items} defaultTabId="cost" />);
    expect(screen.getByRole('tab', { name: 'Cost' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Cost panel');
  });

  it('selects a tab on click and notifies onTabChange', async () => {
    const user = userEvent.setup();
    const onTabChange = vi.fn();
    render(<Tabs items={items} onTabChange={onTabChange} />);
    await user.click(screen.getByRole('tab', { name: 'Screen' }));
    expect(screen.getByRole('tab', { name: 'Screen' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Screen panel');
    expect(onTabChange).toHaveBeenCalledWith('screen');
  });

  it('moves selection and focus with ArrowRight, wrapping at the end', async () => {
    const user = userEvent.setup();
    render(<Tabs items={items} />);
    const first = screen.getByRole('tab', { name: 'Timeline' });
    await user.click(first);

    await user.keyboard('{ArrowRight}');
    const second = screen.getByRole('tab', { name: 'Screen' });
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(second).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Screen panel');

    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveFocus();
  });

  it('moves selection with ArrowLeft, wrapping to the last tab', async () => {
    const user = userEvent.setup();
    render(<Tabs items={items} />);
    await user.click(screen.getByRole('tab', { name: 'Timeline' }));
    await user.keyboard('{ArrowLeft}');
    const last = screen.getByRole('tab', { name: 'Cost' });
    expect(last).toHaveAttribute('aria-selected', 'true');
    expect(last).toHaveFocus();
  });

  it('uses roving tabindex (selected tab is 0, others -1)', () => {
    render(<Tabs items={items} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(tabs[2]).toHaveAttribute('tabindex', '-1');
  });
});
