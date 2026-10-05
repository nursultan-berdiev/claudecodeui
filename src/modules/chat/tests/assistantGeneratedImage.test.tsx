import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

import '@/modules/i18n';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import { UiPreferencesProvider } from '@/shared/context/UiPreferencesContext';

vi.mock('@/modules/chat/transcript/ChatMessageImages', () => ({
  default: ({ images, variant }: { images: Array<{ path?: string }>; variant?: string }) => (
    <div data-testid="chat-images" data-variant={variant}>{images.map((image) => image.path).join(',')}</div>
  ),
}));

test('an image the agent generated reaches the transcript as an assistant reply', () => {
  const [reply] = normalizedToChatMessages([{
    id: 'row-1',
    sessionId: 'session-1',
    timestamp: '2026-10-05T02:38:46.000Z',
    provider: 'codex',
    kind: 'text',
    role: 'assistant',
    content: '',
    images: [{ path: '/home/node/.cloudcli/assets/codex-thread-cake.png', name: 'cake.png' }],
  }]);
  assert.equal(reply?.type, 'assistant');

  render(
    <UiPreferencesProvider>
      <MessageComponent message={reply!} prevMessage={null} createDiff={() => []} provider="codex" />
    </UiPreferencesProvider>,
  );
  assert.equal(screen.getByTestId('chat-images').textContent, '/home/node/.cloudcli/assets/codex-thread-cake.png');
  assert.equal(screen.getByTestId('chat-images').dataset.variant, 'reply');
});
