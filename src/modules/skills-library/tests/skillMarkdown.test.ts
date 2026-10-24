import assert from 'node:assert/strict';

import { test } from 'vitest';

import { composeSkillMarkdown, parseSkillMarkdown, toSkillName } from '@/modules/skills-library/utils/skillMarkdown';

test('form fields survive a round trip and unknown frontmatter stays as written', () => {
  const source = '---\nname: weekly-report\ndescription: >\n  Use when the manager asks\n  for the weekly report\nallowed-tools: Read Grep\nmetadata:\n  owner: sales\n---\n\n# Steps\n1. Collect';
  const parts = parseSkillMarkdown(source);
  assert.deepEqual(parts, {
    name: 'weekly-report', description: 'Use when the manager asks for the weekly report', body: '# Steps\n1. Collect',
    extraFrontmatter: ['allowed-tools: Read Grep', 'metadata:', '  owner: sales'],
  });
  const edited = composeSkillMarkdown({ ...parts, description: 'Отчёт: когда просят # итоги недели' });
  assert.deepEqual(parseSkillMarkdown(edited), { ...parts, description: 'Отчёт: когда просят # итоги недели' });
  assert.match(edited, /^---\nname: weekly-report\ndescription: "Отчёт: когда просят # итоги недели"\nallowed-tools: Read Grep\nmetadata:\n {2}owner: sales\n---\n\n# Steps/);
});

test('quoted values are decoded and a file without frontmatter keeps its text as the body', () => {
  assert.equal(parseSkillMarkdown("---\nname: 'it''s-mine'\ndescription: \"Line one\\nline two\"\n---\nBody").description, 'Line one\nline two');
  assert.equal(parseSkillMarkdown("---\nname: 'it''s-mine'\n---\n").name, "it's-mine");
  assert.deepEqual(parseSkillMarkdown('# Just instructions'), { name: '', description: '', body: '# Just instructions', extraFrontmatter: [] });
  assert.equal(composeSkillMarkdown({ name: 'plain', description: 'Simple text', body: '\n\nDo it', extraFrontmatter: [] }), '---\nname: plain\ndescription: Simple text\n---\n\nDo it');
});

test('skill names become command-safe without dropping Cyrillic letters', () => {
  assert.equal(toSkillName('Ответы Клиентам_по просрочке!'), 'ответы-клиентам-по-просрочке');
  assert.equal(toSkillName('Weekly  Report v2.1'), 'weekly-report-v2.1');
});
