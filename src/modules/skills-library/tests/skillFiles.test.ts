import assert from 'node:assert/strict';

import { test } from 'vitest';

import { editableFiles, readSkillUpload } from '@/modules/skills-library/utils/skillFiles';

// jsdom's File has neither webkitRelativePath nor text(), which browsers provide.
const upload = (content: string, relativePath: string, inFolder = true) => {
  const file = new File([content], relativePath.split('/').at(-1)!);
  Object.defineProperty(file, 'webkitRelativePath', { value: inFolder ? relativePath : '' });
  Object.defineProperty(file, 'text', { value: async () => content });
  return file;
};
const inFolder = (content: string, relativePath: string) => upload(content, relativePath);

test('a single markdown file becomes the skill and a folder keeps paths relative to its SKILL.md', async () => {
  assert.deepEqual(await readSkillUpload([upload('# Only', 'notes.md', false)]), { content: '# Only', files: [] });
  const folder = await readSkillUpload([
    inFolder('---\nname: report\n---\nBody', 'report/SKILL.md'),
    inFolder('print(1)', 'report/scripts/run.py'),
    inFolder('outside', 'other/readme.md'),
  ]);
  assert.equal(folder.content, '---\nname: report\n---\nBody');
  assert.deepEqual(folder.files, [{ relativePath: 'scripts/run.py', content: 'print(1)', encoding: 'utf8' }]);
});

test('uploads without SKILL.md or over the limits are refused with translatable codes', async () => {
  await assert.rejects(readSkillUpload([inFolder('a', 'x/a.md'), inFolder('b', 'x/b.md')]), /skillFileRequired/);
  const many = Array.from({ length: 501 }, (_, index) => inFolder('x', `big/f${index}.txt`));
  await assert.rejects(readSkillUpload(many), /importTooLarge/);
});

test('text attachments are decoded for editing while binary ones stay base64', () => {
  const text = btoa('hello');
  const binary = btoa(String.fromCharCode(0, 255, 1));
  assert.deepEqual(editableFiles([{ relativePath: 'a.txt', content: text, encoding: 'base64' }, { relativePath: 'b.bin', content: binary, encoding: 'base64' }]),
    [{ relativePath: 'a.txt', content: 'hello', encoding: 'utf8' }, { relativePath: 'b.bin', content: binary, encoding: 'base64' }]);
});
