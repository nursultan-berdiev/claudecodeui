import assert from 'node:assert/strict';

import { test } from 'vitest';

import { groupConsecutiveTools, isToolGroupItem } from '@/modules/chat/utils/toolGrouping';
import type { ChatMessage, ToolGroupItem } from '@/shared/types';

/**
 * The collapsed group's summary line is built here rather than in
 * ToolGroupContainer because producing it JSON.parses tool inputs, which can be
 * whole file contents. The component's useMemo could never cache it — grouping
 * allocates a fresh messages array on every pass — so it ran on every render of
 * the transcript, including ten times a second while streaming.
 */

const toolMessage = (toolName: string, toolInput: unknown): ChatMessage => ({
  type: 'tool',
  content: '',
  timestamp: '2024-01-01T00:00:00.000Z',
  isToolUse: true,
  toolName,
  toolInput: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput),
});

const textMessage = (content: string): ChatMessage => ({
  type: 'assistant',
  content,
  timestamp: '2024-01-01T00:00:00.000Z',
});

/** The collapsed line's named inputs and its unnamed remainder, in one comparable value. */
const previewOf = (group: ToolGroupItem) => ({ names: group.previewNames, extra: group.previewExtraCount });

const thinkingMessage = (): ChatMessage => ({
  type: 'assistant',
  content: 'deliberating',
  timestamp: '2024-01-01T00:00:00.000Z',
  isThinking: true,
});

test('a run of same-tool calls is grouped and carries a precomputed preview', () => {
  const items = groupConsecutiveTools([
    toolMessage('Read', { file_path: '/a.ts' }),
    toolMessage('Read', { file_path: '/b.ts' }),
  ]);

  assert.equal(items.length, 1);
  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.deepEqual(previewOf(group), { names: ['/a.ts', '/b.ts'], extra: 0 });
});

test('a group of more than two calls reports the remainder', () => {
  const items = groupConsecutiveTools([
    toolMessage('Read', { file_path: '/a.ts' }),
    toolMessage('Read', { file_path: '/b.ts' }),
    toolMessage('Read', { file_path: '/c.ts' }),
    toolMessage('Read', { file_path: '/d.ts' }),
  ]);

  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.deepEqual(previewOf(group), { names: ['/a.ts', '/b.ts'], extra: 2 });
});

test('a single tool call still folds into a summary line', () => {
  // Grouping from the second call rendered the first as a full card, then
  // remounted it collapsed the moment the second one arrived.
  const items = groupConsecutiveTools([toolMessage('Read', { file_path: '/a.ts' })]);

  assert.equal(items.length, 1);
  assert.equal(isToolGroupItem(items[0]), true);
});

test('different tools fold into one run', () => {
  const items = groupConsecutiveTools([
    toolMessage('Read', { file_path: '/a.ts' }),
    toolMessage('Bash', { command: 'ls' }),
    toolMessage('Write', { file_path: '/b.ts' }),
  ]);

  assert.equal(items.length, 1);
  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.equal(group.messages.length, 3);
  assert.deepEqual(previewOf(group), { names: ['/a.ts', 'ls'], extra: 1 });
});

test('plan, question and checklist calls keep their own rows between runs', () => {
  // The plan card holds the only Build/Revise buttons for a pending plan; folded
  // into a closed group it would never mount and the agent would wait forever.
  for (const toolName of ['ExitPlanMode', 'exit_plan_mode', 'AskUserQuestion', 'TodoWrite']) {
    const items = groupConsecutiveTools([
      toolMessage('Read', { file_path: '/a.ts' }),
      toolMessage(toolName, {}),
      toolMessage('Read', { file_path: '/b.ts' }),
    ]);

    assert.equal(items.length, 3, toolName);
    assert.equal(isToolGroupItem(items[1]), false, toolName);
  }
});

test('a group counts the calls still running and the calls that failed', () => {
  const items = groupConsecutiveTools([
    { ...toolMessage('Read', { file_path: '/a.ts' }), toolResult: { content: 'ok' } },
    { ...toolMessage('Bash', { command: 'false' }), toolResult: { content: 'exit 1', isError: true } },
    { ...toolMessage('Bash', { command: 'make' }), toolStatus: 'failed', toolResult: { content: '' } },
    toolMessage('Read', { file_path: '/b.ts' }),
  ]);

  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.equal(group.runningCount, 1);
  assert.equal(group.failedCount, 2);
});

test('a text turn splits a run', () => {
  const items = groupConsecutiveTools([
    toolMessage('Read', { file_path: '/a.ts' }),
    textMessage('some prose'),
    toolMessage('Read', { file_path: '/b.ts' }),
  ]);

  assert.equal(items.length, 3);
  assert.equal(items.filter(isToolGroupItem).length, 2);
});

test('an unparsable tool input does not throw while grouping', () => {
  const items = groupConsecutiveTools([
    toolMessage('Read', '{not json'),
    toolMessage('Read', '{also not json'),
  ]);

  const [group] = items;
  assert.ok(isToolGroupItem(group));
  // Read's getValue reads .file_path off the parsed input; the unparsable input
  // stays a string, so there is nothing to show. The group must still form, the
  // raw JSON must not leak into the summary line, and both calls must be
  // accounted for as unnamed.
  assert.deepEqual(previewOf(group), { names: [], extra: 2 });
});

test('a tool with no config is previewed by what it operated on', () => {
  // Exercises the other half of getToolInputPreview: unknown tools resolve to
  // the Default config, whose title summarizes the input. Previewing the
  // config's own label instead made every unmapped provider tool collapse into
  // an identical, meaningless "Parameters, Parameters" line.
  const items = groupConsecutiveTools([
    toolMessage('SomeUnknownTool', { command: 'npm test' }),
    toolMessage('SomeUnknownTool', { file_path: '/repo/a.ts' }),
  ]);

  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.deepEqual(previewOf(group), { names: ['npm test', '/repo/a.ts'], extra: 0 });
});

test('the group carries the run\u2019s first timestamp, which is what the search jump matches on', () => {
  const items = groupConsecutiveTools([
    { ...toolMessage('Read', { file_path: '/a.ts' }), timestamp: '2024-01-01T10:00:00.000Z' },
    { ...toolMessage('Read', { file_path: '/b.ts' }), timestamp: '2024-01-01T10:00:05.000Z' },
  ]);

  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.equal(group.timestamp, '2024-01-01T10:00:00.000Z');
});

test('a call the line cannot name is counted in the remainder', () => {
  // One of the two is named, so the other is "more" — the badge says x2 and the
  // line accounts for two calls.
  const items = groupConsecutiveTools([
    toolMessage('Read', { file_path: '/a.ts' }),
    toolMessage('Read', {}),
  ]);

  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.deepEqual(previewOf(group), { names: ['/a.ts'], extra: 1 });
});

test('the named calls plus the remainder always add up to the group size', () => {
  // The invariant that keeps the summary honest next to the group's action count.
  // Subtracting the two preview slots instead of the previews that produced text
  // renders "+1 more" for three hidden calls.
  const items = groupConsecutiveTools([
    toolMessage('Read', {}),
    toolMessage('Read', { file_path: '/b.ts' }),
    toolMessage('Read', { file_path: '/c.ts' }),
  ]);

  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.deepEqual(previewOf(group), { names: ['/b.ts'], extra: 2 });
});

test('a group that can name nothing still accounts for every call', () => {
  const items = groupConsecutiveTools([
    toolMessage('Read', {}),
    toolMessage('Read', {}),
    toolMessage('Read', {}),
    toolMessage('Read', {}),
    toolMessage('Read', {}),
  ]);

  const [group] = items;
  assert.ok(isToolGroupItem(group));
  assert.deepEqual(previewOf(group), { names: [], extra: 5 });
});

test('hidden reasoning between two tool calls does not split the run', () => {
  // Codex interleaves reasoning between consecutive tool calls; with thinking
  // turned off those messages render nothing, so splitting on them would show
  // two ungrouped rows with an invisible gap between them.
  const items = groupConsecutiveTools([
    toolMessage('Read', { file_path: '/a.ts' }),
    thinkingMessage(),
    toolMessage('Read', { file_path: '/b.ts' }),
  ], false);

  assert.equal(items.length, 1);
  assert.equal(isToolGroupItem(items[0]), true);
});

test('reasoning the user can see does split the run', () => {
  const items = groupConsecutiveTools([
    toolMessage('Read', { file_path: '/a.ts' }),
    thinkingMessage(),
    toolMessage('Read', { file_path: '/b.ts' }),
  ], true);

  assert.equal(items.length, 3);
  assert.equal(items.filter(isToolGroupItem).length, 2);
});

test('showThinking defaults to on, so a caller that omits it does not collapse a visible turn', () => {
  const withThinkingShown = groupConsecutiveTools([
    toolMessage('Read', { file_path: '/a.ts' }),
    thinkingMessage(),
    toolMessage('Read', { file_path: '/b.ts' }),
  ]);

  assert.equal(withThinkingShown.length, 3);
});

test('a subagent container is never absorbed into a group', () => {
  // It renders its own nested transcript, so collapsing it into a one-line
  // summary would hide the whole subagent run.
  const items = groupConsecutiveTools([
    toolMessage('Task', { prompt: 'a' }),
    { ...toolMessage('Task', { prompt: 'b' }), isSubagentContainer: true },
  ]);

  assert.equal(items.length, 2);
  assert.equal(isToolGroupItem(items[1]), false);
});

test('consecutive workflow launches keep their own cards instead of folding into a run', () => {
  // A collapsed run mounts nothing until expanded, which would hide two
  // workflows' names, statuses and the anchors the background-tasks strip
  // scrolls to.
  const items = groupConsecutiveTools([
    toolMessage('Workflow', { script: "export const meta = { name: 'a' }" }),
    toolMessage('Workflow', { script: "export const meta = { name: 'b' }" }),
  ]);

  assert.equal(items.length, 2);
  assert.ok(items.every((item) => !isToolGroupItem(item)));
});

/**
 * Grouping re-runs on every 100ms stream tick over a fresh array. The group
 * objects it hands back are props of the memoized ToolGroupContainer, so a run
 * whose rows did not change has to come back as the very same object — or
 * every collapsed group in the transcript re-renders ten times a second.
 */
test('an unchanged run comes back as the same group object', () => {
  const first = toolMessage('Read', { file_path: '/a.ts' });
  const second = toolMessage('Read', { file_path: '/b.ts' });
  const tail = textMessage('done');

  const [groupA] = groupConsecutiveTools([first, second, tail]);
  // A later tick: same rows, new array, plus a row appended after the run.
  const [groupB] = groupConsecutiveTools([first, second, tail, textMessage('more')]);

  assert.ok(isToolGroupItem(groupA) && isToolGroupItem(groupB));
  assert.equal(groupB, groupA, 'the group object must survive a stream tick');
  assert.equal(groupB.messages, groupA.messages, 'and so must its messages array');
});

test('a run that grew, changed rows, or changed showThinking is rebuilt', () => {
  const first = toolMessage('Read', { file_path: '/a.ts' });
  const second = toolMessage('Read', { file_path: '/b.ts' });

  const [initial] = groupConsecutiveTools([first, second]);
  assert.ok(isToolGroupItem(initial));

  const [grown] = groupConsecutiveTools([first, second, toolMessage('Read', { file_path: '/c.ts' })]);
  assert.ok(isToolGroupItem(grown));
  assert.notEqual(grown, initial);
  assert.deepEqual(previewOf(grown), { names: ['/a.ts', '/b.ts'], extra: 1 });

  // A tool result arriving re-projects the row into a new object.
  const [replaced] = groupConsecutiveTools([first, { ...second, toolResult: { content: 'ok' } }]);
  assert.ok(isToolGroupItem(replaced));
  assert.notEqual(replaced, initial);

  // Hidden reasoning both joins runs and changes what the preview names.
  const [rehidden] = groupConsecutiveTools([first, thinkingMessage(), second], false);
  assert.ok(isToolGroupItem(rehidden));
  assert.notEqual(rehidden, initial);
});
