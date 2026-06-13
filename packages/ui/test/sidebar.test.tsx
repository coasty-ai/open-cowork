import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar, Icon } from '../src/index';

describe('Sidebar', () => {
  it('renders brand, nav items, and footer when expanded', () => {
    render(
      <Sidebar
        collapsed={false}
        onToggleCollapsed={() => {}}
        brand={<span>brand</span>}
        footer={<span>foot</span>}
      >
        <a href="#" className="oc-sidebar__item">
          item
        </a>
      </Sidebar>,
    );
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).toHaveAttribute('data-collapsed', 'false');
    expect(screen.getByText('brand')).toBeInTheDocument();
    expect(screen.getByText('item')).toBeInTheDocument();
    expect(screen.getByText('foot')).toBeInTheDocument();
  });

  it('reflects collapsed state and offers an Expand control', () => {
    render(
      <Sidebar collapsed onToggleCollapsed={() => {}} brand={<span>b</span>}>
        <a href="#">x</a>
      </Sidebar>,
    );
    expect(screen.getByRole('navigation')).toHaveAttribute('data-collapsed', 'true');
    const toggle = screen.getByRole('button', { name: /expand sidebar/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('fires onToggleCollapsed when the toggle is clicked', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <Sidebar collapsed={false} onToggleCollapsed={onToggle} brand={<span>b</span>}>
        <a href="#">x</a>
      </Sidebar>,
    );
    await user.click(screen.getByRole('button', { name: /collapse sidebar/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('Icon', () => {
  it('is decorative (aria-hidden) by default', () => {
    const { container } = render(<Icon name="runs" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('exposes an accessible label when given a title', () => {
    render(<Icon name="settings" title="Settings" />);
    expect(screen.getByRole('img', { name: 'Settings' })).toBeInTheDocument();
  });
});
