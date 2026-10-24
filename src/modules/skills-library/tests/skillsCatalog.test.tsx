import assert from 'node:assert/strict';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import { SkillSharingControl } from '@/modules/skills-library/SkillSharingControl';
import { SkillFilesEditor } from '@/modules/skills-library/SkillFilesEditor';
import { SkillHelperPanel } from '@/modules/skills-library/SkillHelperPanel';
import { SkillVersionHistory } from '@/modules/skills-library/SkillVersionHistory';
import { SkillsCatalogPage } from '@/modules/skills-library';
import { SkillEditorDialog } from '@/modules/skills-library/modals/SkillEditorDialog';
import { SkillImportDialog } from '@/modules/skills-library/modals/SkillImportDialog';
import type { CompanySkill, CompanySkillSummary } from '@/shared/types';

const { catalog, signedIn, skillHelper, updateSkill, importSkills, skillVersions } = vi.hoisted(() => ({
  catalog: [] as unknown[],
  signedIn: new Set<string>(),
  skillHelper: vi.fn(),
  updateSkill: vi.fn(),
  importSkills: vi.fn(),
  skillVersions: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: { id: 2, role: 'member', username: 'owner' } }) }));
// The real barrel also exports the login modal, which pulls the terminal and i18n setup into jsdom.
vi.mock('@/modules/provider-auth', async () => {
  const { useCallback, useState } = await import('react');
  const read = (loading: boolean) => Object.fromEntries(['claude', 'codex'].map((agent) => [agent, { authenticated: !loading && signedIn.has(agent), loading }]));
  return { useProviderAuthStatus: () => {
    const [providerAuthStatus, setStatus] = useState(() => read(true));
    const refreshProviderAuthStatuses = useCallback(async () => { setStatus(read(false)); }, []);
    return { providerAuthStatus, refreshProviderAuthStatuses };
  } };
});
vi.mock('@/shared/api', () => ({
  api: {
    company: {
      skills: async () => new Response(JSON.stringify({ skills: catalog, categories: ['Reports', 'Sales'] })),
      setSkillFavorite: async () => new Response('{}'),
      departments: async () => new Response(JSON.stringify({ departments: [], ownDepartmentIds: [] })),
      people: async () => new Response(JSON.stringify({ people: [] })),
      skillImportSources: async () => new Response(JSON.stringify({ sources: [{ id: 'claude', items: [
        { key: 'claude:/skills/a/SKILL.md', name: 'meeting-notes', description: '', scope: 'user', alreadyImported: false, inLibrary: false }] }] })),
      skillHelper, updateSkill, importSkills, skillVersions,
    },
  },
  readApiJson: async (response: Response) => response.json(),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const card = (patch: Partial<CompanySkillSummary>): CompanySkillSummary => ({
  id: patch.name ?? 'id', name: 'skill', description: '', category: '', examplePrompt: '', provider: 'all', version: 1,
  ownerUserId: 2, ownerName: 'owner', ownerDepartments: [], visibility: 'private', departmentIds: [], userIds: [], canManage: true,
  isFavorite: false, lastUsedAt: null, fileCount: 0, createdAt: '2026-10-20 10:00:00', updatedAt: '2026-10-20 10:00:00', ...patch,
});
const names = () => screen.queryAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);

test('the catalog filters by view, agent, category and search', async () => {
  catalog.splice(0, catalog.length,
    card({ name: 'weekly-report', category: 'Reports', isFavorite: true }),
    card({ name: 'codex-review', provider: 'codex', ownerUserId: 9, visibility: 'company', lastUsedAt: '2026-10-24 08:00:00' }),
    card({ name: 'sales-letter', category: 'Sales', description: 'Write to a client', ownerUserId: 9, visibility: 'users' }));
  render(<SkillsCatalogPage />);
  await waitFor(() => assert.deepEqual(names(), ['weekly-report', 'codex-review', 'sales-letter']));

  fireEvent.click(screen.getByRole('button', { name: 'skillsCatalog.views.favorites' }));
  assert.deepEqual(names(), ['weekly-report']);
  fireEvent.click(screen.getByRole('button', { name: 'skillsCatalog.views.shared' }));
  assert.deepEqual(names(), ['codex-review', 'sales-letter']);
  fireEvent.click(screen.getByRole('button', { name: 'skillsCatalog.views.recent' }));
  assert.deepEqual(names(), ['codex-review']);
  fireEvent.click(screen.getByRole('button', { name: 'skillsCatalog.views.all' }));

  fireEvent.change(screen.getByRole('combobox', { name: 'skillsCatalog.agentFilter' }), { target: { value: 'claude' } });
  assert.deepEqual(names(), ['weekly-report', 'sales-letter']);
  fireEvent.click(screen.getByRole('button', { name: 'Sales' }));
  assert.deepEqual(names(), ['sales-letter']);
  fireEvent.click(screen.getByRole('button', { name: 'skillsCatalog.allCategories' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'skillsCatalog.search' }), { target: { value: 'client' } });
  assert.deepEqual(names(), ['sales-letter']);
});

test('members cannot publish company-wide and only share with their own departments and colleagues', () => {
  const onChange = vi.fn();
  const departments = [{ id: 1, name: 'Sales', description: '', memberIds: [] }, { id: 2, name: 'Legal', description: '', memberIds: [] }];
  const people = [{ id: 2, username: 'owner' }, { id: 3, username: 'colleague' }];
  const view = render(<SkillSharingControl visibility="departments" departmentIds={[]} userIds={[]} departments={departments} ownDepartmentIds={[1]}
    people={people} currentUserId={2} isAdmin={false} canKeepCompany={false} onChange={onChange} />);
  assert.equal((screen.getByRole('radio', { name: /skillsCatalog.visibility.company/ }) as HTMLInputElement).disabled, true);
  assert.deepEqual(screen.getAllByRole('checkbox').map((box) => box.parentElement?.textContent), ['Sales']);
  fireEvent.click(screen.getByRole('checkbox'));
  assert.deepEqual(onChange.mock.calls.at(-1)?.[0], { visibility: 'departments', userIds: [], departmentIds: [1] });

  view.rerender(<SkillSharingControl visibility="users" departmentIds={[]} userIds={[]} departments={departments} ownDepartmentIds={[1]}
    people={people} currentUserId={2} isAdmin onChange={onChange} canKeepCompany={false} />);
  assert.equal((screen.getByRole('radio', { name: /skillsCatalog.visibility.company/ }) as HTMLInputElement).disabled, false);
  assert.deepEqual(screen.getAllByRole('checkbox').map((box) => box.parentElement?.textContent), ['colleague']);
});

test('the helper offers only signed-in agents and fills the form with the draft', async () => {
  signedIn.clear(); signedIn.add('codex');
  const draft = { name: 'reply', description: 'Use for replies', category: 'Sales', examplePrompt: 'Reply to Ivan', body: '# Steps' };
  skillHelper.mockResolvedValue(new Response(JSON.stringify({ draft })));
  const onDraft = vi.fn();
  render(<SkillHelperPanel canImprove={false} currentContent="" onDraft={onDraft} />);
  await waitFor(() => screen.getByText('Codex'));
  assert.equal(screen.queryByText('Claude'), null);
  assert.ok(screen.getByText('skillsCatalog.helper.cost'));
  fireEvent.change(screen.getByRole('textbox', { name: 'skillsCatalog.helper.request' }), { target: { value: 'Reply to overdue clients' } });
  fireEvent.click(screen.getByRole('button', { name: 'skillsCatalog.helper.draft' }));
  await waitFor(() => assert.deepEqual(onDraft.mock.calls[0]?.[0], draft));
  assert.deepEqual(skillHelper.mock.calls[0][0], { provider: 'codex', mode: 'draft', request: 'Reply to overdue clients', current: '' });
  assert.equal((screen.getByRole('button', { name: 'skillsCatalog.helper.improve' }) as HTMLButtonElement).disabled, true);
});

test('saving without touching attachments does not resend them, so no new version is recorded', async () => {
  const skill: CompanySkill = { ...card({ name: 'with-file', fileCount: 1 }), content: '---\nname: with-file\ndescription: x\n---\nBody',
    files: [{ relativePath: 'notes.md', content: btoa('hello'), encoding: 'base64' }] };
  updateSkill.mockResolvedValue(new Response(JSON.stringify({ skill })));
  const onSaved = vi.fn();
  render(<SkillEditorDialog skill={skill} categories={[]} onClose={() => undefined} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole('button', { name: 'skillsCatalog.save' }));
  await waitFor(() => assert.equal(onSaved.mock.calls.length, 1));
  assert.equal('files' in updateSkill.mock.calls[0][1], false);
});

test('the import dialog explains why a selected skill was skipped', async () => {
  importSkills.mockResolvedValue(new Response(JSON.stringify({ imported: [], skipped: [{ key: 'claude:/skills/a/SKILL.md', code: 'SKILL_NAME_EXISTS' }] })));
  render(<SkillImportDialog onClose={() => undefined} onImported={() => undefined} onUpload={() => undefined} />);
  fireEvent.click(await screen.findByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'skillsCatalog.import.submit' }));
  await waitFor(() => assert.ok(screen.getByText('meeting-notes: skillsCatalog.import.reasons.SKILL_NAME_EXISTS')));
  assert.deepEqual(importSkills.mock.calls[0][0], ['claude:/skills/a/SKILL.md']);
});

test('version history restores an older version only after confirmation', async () => {
  const version = (number: number, isCurrent: boolean) => ({ version: number, name: 'x', description: '', category: '', createdAt: '2026-10-20 10:00:00', createdByName: 'anna', restoredFrom: null, isCurrent });
  skillVersions.mockResolvedValue(new Response(JSON.stringify({ versions: [version(2, true), version(1, false)] })));
  const onRestore = vi.fn();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<SkillVersionHistory skillId="skill-1" currentVersion={2} canManage busy={false} onRestore={onRestore} />);
  fireEvent.click(screen.getByRole('button', { name: 'skillsCatalog.history' }));
  const restore = await screen.findByRole('button', { name: 'skillsCatalog.restore' });
  fireEvent.click(restore);
  assert.equal(onRestore.mock.calls.length, 0);
  fireEvent.click(restore);
  assert.deepEqual(onRestore.mock.calls, [[1]]);
  confirm.mockRestore();
});

test('the files editor refuses SKILL.md, duplicates, case clashes and file/folder clashes before adding', () => {
  const onChange = vi.fn();
  render(<SkillFilesEditor files={[{ relativePath: 'scripts/run.py', content: '', encoding: 'utf8' }]} onChange={onChange} />);
  const input = screen.getByRole('textbox', { name: 'skillsCatalog.filePath' });
  const add = screen.getByRole('button', { name: 'skillsCatalog.addFile' });
  for (const [refused, problem] of [['SKILL.md', 'reserved'], ['Scripts/Run.py', 'clash'], ['scripts', 'clash'], ['scripts/run.py/inner', 'clash'], ['../escape', 'invalid']]) {
    fireEvent.change(input, { target: { value: refused } });
    fireEvent.click(add);
    assert.equal(screen.getByRole('alert').textContent, `skillsCatalog.filePathProblem.${problem}`);
  }
  assert.equal(onChange.mock.calls.length, 0);
  fireEvent.change(input, { target: { value: 'notes.md' } });
  fireEvent.click(add);
  assert.deepEqual(onChange.mock.calls[0][0].map((file: { relativePath: string }) => file.relativePath), ['scripts/run.py', 'notes.md']);
});

test('a rejected upload is explained by its error code and the agent select only accepts known agents', async () => {
  const view = render(<SkillImportDialog onClose={() => undefined} onImported={() => undefined} onUpload={() => undefined} />);
  const folderInput = view.baseElement.querySelector('input[type="file"][multiple]') as HTMLInputElement;
  const loose = [new File(['a'], 'a.md'), new File(['b'], 'b.md')];
  fireEvent.change(folderInput, { target: { files: loose } });
  await waitFor(() => assert.equal(screen.getByRole('alert').textContent, 'skillsCatalog.import.skillFileRequired'));
  cleanup();

  const skill: CompanySkill = { ...card({ name: 'agent-bound' }), content: '---\nname: agent-bound\ndescription: x\n---\nBody', files: [] };
  updateSkill.mockResolvedValue(new Response(JSON.stringify({ skill })));
  const onSaved = vi.fn();
  render(<SkillEditorDialog skill={skill} categories={[]} onClose={() => undefined} onSaved={onSaved} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'skillsCatalog.agentOnly' }), { target: { value: 'codex' } });
  fireEvent.click(screen.getByRole('button', { name: 'skillsCatalog.save' }));
  await waitFor(() => assert.equal(onSaved.mock.calls.length, 1));
  assert.equal(updateSkill.mock.calls.at(-1)?.[1].provider, 'codex');
});
