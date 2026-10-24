import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';
import type * as ReactI18next from 'react-i18next';

import type { ChatMessage, ToolGroupItem, TranscriptRevealRequest } from '@/shared/types';
import { TranscriptRevealContext } from '@/modules/chat/context/TranscriptRevealContext';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';

/**
 * A run of agent actions folds into one quiet line. The line has to say what
 * the folded calls are doing — still running, how many, how many failed — and
 * open by itself when a search hit or a background-task chip points inside it.
 */

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));

const { default: ToolGroupContainer } = await import('@/modules/chat/transcript/ToolGroupContainer');

const createDiff = createCachedDiffCalculator();

const call = (id: string, toolResult?: ChatMessage['toolResult']): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: `2026-08-21T10:00:0${id}.000Z`,
  isToolUse: true,
  toolName: 'Read',
  toolId: `tool-${id}`,
  toolInput: JSON.stringify({ file_path: `/repo/${id}.ts` }),
  toolResult,
});

const group = (messages: ChatMessage[], counts: Partial<ToolGroupItem> = {}): ToolGroupItem => ({
  _isGroup: true,
  messages,
  timestamp: messages[0].timestamp,
  previewNames: ['/repo/1.ts'],
  previewExtraCount: messages.length - 1,
  runningCount: 0,
  failedCount: 0,
  ...counts,
});

const renderGroup = (item: ToolGroupItem, reveal: TranscriptRevealRequest | null = null, canStillRun = false) => {
  const element = (request: TranscriptRevealRequest | null) => (
    <TranscriptRevealContext.Provider value={request}>
      <ToolGroupContainer
        group={item}
        prevMessage={null}
        createDiff={createDiff}
        getMessageKey={(message) => String(message.timestamp)}
        provider="claude"
        canStillRun={canStillRun}
      />
    </TranscriptRevealContext.Provider>
  );
  const view = render(element(reveal));
  return { ...view, setReveal: (request: TranscriptRevealRequest | null) => view.rerender(element(request)) };
};

const summaryButton = () => screen.getByRole('button', { name: /toolGroup/ });

test('a finished run says how many actions it took and starts closed', () => {
  const messages = [call('1', { content: 'a' }), call('2', { content: 'b' }), call('3', { content: 'c' })];
  renderGroup(group(messages));

  const button = summaryButton();
  assert.match(button.textContent ?? '', /toolGroup\.done:3/);
  assert.match(button.textContent ?? '', /toolGroup\.more:2/);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
});

test('a run with calls in flight says it is working, and failures are counted', () => {
  renderGroup(group([call('1'), call('2', { content: 'x', isError: true })], { runningCount: 1, failedCount: 1 }), null, true);

  const text = summaryButton().textContent ?? '';
  assert.match(text, /toolGroup\.running/);
  assert.match(text, /toolGroup\.failed:1/);
  assert.doesNotMatch(text, /toolGroup\.done/);
});

test('a call left without a result in history does not keep the group spinning', () => {
  // An interrupted turn leaves a call without a result; reopened later, the
  // session is idle and the group must read as finished.
  renderGroup(group([call('1', { content: 'a' }), call('2')], { runningCount: 1 }));

  const text = summaryButton().textContent ?? '';
  assert.match(text, /toolGroup\.done:2/);
  assert.doesNotMatch(text, /toolGroup\.running/);
});

test('a reveal aimed inside the group opens it, and a later reveal reopens it after the user closed it', () => {
  const messages = [call('1', { content: 'a' }), call('2', { content: 'b' })];
  const { setReveal } = renderGroup(group(messages));
  assert.equal(summaryButton().getAttribute('aria-expanded'), 'false');

  act(() => setReveal({ message: messages[1] }));
  assert.equal(summaryButton().getAttribute('aria-expanded'), 'true');

  fireEvent.click(summaryButton());
  assert.equal(summaryButton().getAttribute('aria-expanded'), 'false');

  act(() => setReveal({ message: messages[1] }));
  assert.equal(summaryButton().getAttribute('aria-expanded'), 'true');
});

test('a reveal of a row outside the group leaves it closed', () => {
  const messages = [call('1', { content: 'a' })];
  renderGroup(group(messages), { message: call('9', { content: 'z' }) });

  assert.equal(summaryButton().getAttribute('aria-expanded'), 'false');
});
