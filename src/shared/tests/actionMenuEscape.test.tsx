import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, test } from 'vitest';

import { ActionMenu } from '@/shared/ui';

/**
 * The chat aborts a running agent on Escape from a document-level capture
 * listener, unless the event was already handled. Menus now sit in the header
 * and the sidebar while an agent works, so closing one with Escape must mark
 * the event handled before that listener sees it — or it stops the agent too.
 */

const seen: { defaultPrevented: boolean | null } = { defaultPrevented: null };
const pageEscape = (event: KeyboardEvent) => {
  if (event.key === 'Escape') seen.defaultPrevented = event.defaultPrevented;
};

afterEach(() => {
  document.removeEventListener('keydown', pageEscape, { capture: true });
  seen.defaultPrevented = null;
});

test('Escape closes an open menu and arrives at page shortcuts already handled', () => {
  document.addEventListener('keydown', pageEscape, { capture: true });
  render(<ActionMenu label="Tools" items={[{ key: 'a', label: 'Item', onSelect: () => {} }]} />);

  fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
  assert.ok(screen.getByRole('menu'));

  fireEvent.keyDown(document.body, { key: 'Escape' });

  assert.equal(screen.queryByRole('menu'), null);
  assert.notEqual(seen.defaultPrevented, false, 'the page listener must not see an unhandled Escape');
});

test('Escape with no menu open still reaches page shortcuts unhandled', () => {
  document.addEventListener('keydown', pageEscape, { capture: true });
  render(<ActionMenu label="Tools" items={[{ key: 'a', label: 'Item', onSelect: () => {} }]} />);

  fireEvent.keyDown(document.body, { key: 'Escape' });

  assert.equal(seen.defaultPrevented, false);
});
