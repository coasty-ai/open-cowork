import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from '../src/index';

describe('Field', () => {
  it('associates the label with the control via the generated id', () => {
    render(
      <Field label="Email">
        {({ id, describedBy, invalid }) => (
          <input id={id} aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </Field>,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('shows a required marker when required', () => {
    const { container } = render(
      <Field label="Name" required>
        {({ id }) => <input id={id} />}
      </Field>,
    );
    expect(container.querySelector('.oc-field__required')).toBeInTheDocument();
  });

  it('wires error text through aria-describedby and renders it as an alert', () => {
    render(
      <Field label="Email" error="Email is required">
        {({ id, describedBy, invalid }) => (
          <input id={id} aria-describedby={describedBy} aria-invalid={invalid} />
        )}
      </Field>,
    );
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Email is required');
    expect(screen.getByRole('alert')).toHaveTextContent('Email is required');
  });

  it('combines hint and error ids in describedBy', () => {
    render(
      <Field label="Slug" hint="Lowercase letters only" error="Already taken">
        {({ id, describedBy }) => <input id={id} aria-describedby={describedBy} />}
      </Field>,
    );
    const input = screen.getByLabelText('Slug');
    expect(input).toHaveAccessibleDescription('Lowercase letters only Already taken');
  });

  it('works with textarea and select controls too', () => {
    render(
      <>
        <Field label="Notes">{({ id }) => <textarea id={id} />}</Field>
        <Field label="Machine">
          {({ id }) => (
            <select id={id}>
              <option>one</option>
            </select>
          )}
        </Field>
      </>,
    );
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Machine').tagName).toBe('SELECT');
  });
});
