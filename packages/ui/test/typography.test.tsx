import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Heading, Text } from '../src/index';

describe('Heading', () => {
  it('defaults to an h2 with the oc-h2 preset', () => {
    render(<Heading>Section</Heading>);
    const el = screen.getByRole('heading', { level: 2, name: 'Section' });
    expect(el).toHaveClass('oc-h2');
  });

  it.each([1, 2, 3, 4] as const)('renders an h%i with the matching oc-h class', (level) => {
    render(<Heading level={level}>L{level}</Heading>);
    const el = screen.getByRole('heading', { level, name: `L${level}` });
    expect(el.tagName.toLowerCase()).toBe(`h${level}`);
    expect(el).toHaveClass(`oc-h${level}`);
  });

  it('passes through id + className', () => {
    render(
      <Heading level={1} id="hero" className="x">
        Hi
      </Heading>,
    );
    const el = screen.getByRole('heading', { level: 1 });
    expect(el).toHaveAttribute('id', 'hero');
    expect(el).toHaveClass('oc-h1', 'x');
  });
});

describe('Text', () => {
  it('renders body as a bare span (no extra class)', () => {
    const { container } = render(<Text>hello</Text>);
    const span = container.querySelector('span');
    expect(span).toBeTruthy();
    expect(span?.className).toBe('');
  });

  it('renders caption as a <p class="oc-caption">', () => {
    const { container } = render(<Text variant="caption">note</Text>);
    const p = container.querySelector('p.oc-caption');
    expect(p).toBeInTheDocument();
    expect(p).toHaveTextContent('note');
  });

  it('applies muted + strong variant classes', () => {
    const { container: a } = render(<Text variant="muted">m</Text>);
    expect(a.querySelector('span.oc-text--muted')).toBeInTheDocument();
    const { container: b } = render(<Text variant="strong">s</Text>);
    expect(b.querySelector('span.oc-text--strong')).toBeInTheDocument();
  });

  it('honors the `as` override', () => {
    const { container } = render(
      <Text variant="muted" as="div">
        d
      </Text>,
    );
    expect(container.querySelector('div.oc-text--muted')).toBeInTheDocument();
  });
});
