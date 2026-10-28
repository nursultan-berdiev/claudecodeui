import type { NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage, readObjectRecord } from '@/shared/utils.js';

/** A text block whose tokens are arriving right now. */
type OpenTextBlock = {
  streamId: string;
  apiMessageId: string;
  index: number;
  text: string;
};

/** A streamed text block whose finished assistant row has not arrived yet. */
type UnclaimedStream = {
  streamId: string;
  apiMessageId: string;
};

/**
 * What one Claude run needs to stream its prose token by token.
 *
 * The SDK, asked for partial messages, sends the raw API stream as
 * `stream_event` wrappers and still sends every finished `assistant` message
 * after it. This turns the first into `stream_delta`/`stream_end` frames and
 * tags the second with the bubble it supersedes, so the client shows one copy
 * of each reply: growing while it streams, then swapped in place for the
 * finished row, which is the one carrying the model and the transcript id.
 */
export type ClaudeLiveStream = {
  /**
   * Consumes one SDK message if it is a partial (`type: 'stream_event'`),
   * sending whatever frames it produces. Returns false for every other
   * message, which the caller handles as before.
   */
  handlePartial: (sdkMessage: unknown) => boolean;
  /**
   * Marks the assistant `text` rows normalized from a finished SDK message
   * with the streamed blocks they replace, in block order. Call before the
   * rows are sent.
   */
  claimFinishedRows: (sdkMessage: unknown, rows: NormalizedMessage[]) => void;
};

/**
 * Used by the Claude runtime (`claude-runtime.provider.js`) for each run, to
 * stream assistant prose while it is generated instead of waiting for the
 * finished message.
 *
 * Only the main thread's text blocks stream. Subagent partials carry a
 * `parent_tool_use_id` and are folded into their Agent card from the finished
 * rows, as before; thinking and tool-input deltas are dropped (reasoning is
 * hidden by default, and a large Write's input would flood the replay buffer).
 *
 * Streams are matched to finished rows by API message id, never by text, so a
 * request the CLI retries or re-sends without streaming cannot leave a stale
 * bubble behind: any stream still unclaimed when a different message starts or
 * finishes is discarded.
 */
export function createClaudeLiveStream(
  send: (message: NormalizedMessage) => void,
  readSessionId: () => string | null,
): ClaudeLiveStream {
  let currentApiMessageId: string | null = null;
  let openBlock: OpenTextBlock | null = null;
  const unclaimed: UnclaimedStream[] = [];

  const sendFrame = (fields: Pick<NormalizedMessage, 'kind'> & Partial<NormalizedMessage>) => {
    send(createNormalizedMessage({ ...fields, sessionId: readSessionId(), provider: 'claude' }));
  };

  const discardStreamsNotFrom = (apiMessageId: string | null) => {
    if (openBlock && openBlock.apiMessageId !== apiMessageId) {
      sendFrame({ kind: 'stream_end', streamId: openBlock.streamId, discard: true });
      openBlock = null;
    }
    for (let index = unclaimed.length - 1; index >= 0; index -= 1) {
      if (unclaimed[index].apiMessageId !== apiMessageId) {
        sendFrame({ kind: 'stream_end', streamId: unclaimed[index].streamId, discard: true });
        unclaimed.splice(index, 1);
      }
    }
  };

  const handleStreamEvent = (event: Record<string, unknown>) => {
    switch (event.type) {
      case 'message_start': {
        const apiMessage = readObjectRecord(event.message);
        currentApiMessageId = typeof apiMessage?.id === 'string' ? apiMessage.id : null;
        // A new request starts only after the previous one's rows arrived, so
        // whatever is still unclaimed belongs to an attempt that was dropped.
        discardStreamsNotFrom(currentApiMessageId);
        return;
      }
      case 'content_block_start': {
        const block = readObjectRecord(event.content_block);
        if (block?.type !== 'text' || typeof event.index !== 'number' || !currentApiMessageId) {
          return;
        }
        openBlock = {
          streamId: `${currentApiMessageId}:${event.index}`,
          apiMessageId: currentApiMessageId,
          index: event.index,
          text: '',
        };
        return;
      }
      case 'content_block_delta': {
        const delta = readObjectRecord(event.delta);
        if (!openBlock || event.index !== openBlock.index || delta?.type !== 'text_delta') {
          return;
        }
        const text = typeof delta.text === 'string' ? delta.text : '';
        if (!text) {
          return;
        }
        openBlock.text += text;
        sendFrame({ kind: 'stream_delta', streamId: openBlock.streamId, content: text });
        return;
      }
      case 'content_block_stop': {
        if (!openBlock || event.index !== openBlock.index) {
          return;
        }
        const finished = openBlock;
        openBlock = null;
        // The normalizer emits no row for an empty text part, so nothing would
        // ever claim this stream; drop its bubble now.
        if (!finished.text) {
          sendFrame({ kind: 'stream_end', streamId: finished.streamId, discard: true });
          return;
        }
        sendFrame({ kind: 'stream_end', streamId: finished.streamId });
        unclaimed.push({ streamId: finished.streamId, apiMessageId: finished.apiMessageId });
        return;
      }
      default:
        return;
    }
  };

  return {
    handlePartial(sdkMessage) {
      const record = readObjectRecord(sdkMessage);
      if (record?.type !== 'stream_event') {
        return false;
      }
      const event = readObjectRecord(record.event);
      if (event && !record.parent_tool_use_id) {
        handleStreamEvent(event);
      }
      return true;
    },

    claimFinishedRows(sdkMessage, rows) {
      const record = readObjectRecord(sdkMessage);
      if (record?.type !== 'assistant' || record.parent_tool_use_id) {
        return;
      }
      const apiMessage = readObjectRecord(record.message);
      const apiMessageId = typeof apiMessage?.id === 'string' ? apiMessage.id : null;
      // A finished message with no stream of its own (the CLI fell back to a
      // non-streaming request, or fabricated a notice) supersedes any partial
      // attempt that is still on screen.
      discardStreamsNotFrom(apiMessageId);

      for (const row of rows) {
        if (row.kind !== 'text' || row.role !== 'assistant') {
          continue;
        }
        const claimedIndex = unclaimed.findIndex((stream) => stream.apiMessageId === apiMessageId);
        if (claimedIndex >= 0) {
          row.replacesStreamId = unclaimed[claimedIndex].streamId;
          unclaimed.splice(claimedIndex, 1);
          continue;
        }
        // The CLI yields a block's finished message before the block's own
        // `content_block_stop`, so the block is usually still open here. Its
        // text is complete in this row: end the stream now, ahead of the row,
        // and let the late stop find nothing open.
        if (openBlock && openBlock.apiMessageId === apiMessageId) {
          sendFrame({ kind: 'stream_end', streamId: openBlock.streamId });
          row.replacesStreamId = openBlock.streamId;
          openBlock = null;
        }
        // A row with no stream of its own was never streamed; it is appended
        // as is, and the rows after it still claim theirs.
      }
    },
  };
}
