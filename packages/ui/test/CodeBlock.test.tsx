import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CodeBlock } from '../src/index';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

afterEach(() => {
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

describe('CodeBlock', () => {
  it('renders the code in a monospace pre>code block', () => {
    const { container } = render(<CodeBlock code="pyautogui.click(1, 2)" language="python" />);
    const code = container.querySelector('pre > code');
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent('pyautogui.click(1, 2)');
    expect(code).toHaveClass('language-python');
  });

  it('copies the code via navigator.clipboard and shows Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(<CodeBlock code="curl https://coasty.ai/v1/models" />);

    const button = screen.getByRole('button', { name: 'Copy code' });
    expect(button).toHaveTextContent('Copy');
    fireEvent.click(button);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('curl https://coasty.ai/v1/models'));
    await waitFor(() => expect(button).toHaveTextContent('Copied'));
  });

  it('stays idle when the clipboard write fails', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    stubClipboard(writeText);
    render(<CodeBlock code="x" />);

    const button = screen.getByRole('button', { name: 'Copy code' });
    fireEvent.click(button);

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(button).toHaveTextContent('Copy');
  });
});
