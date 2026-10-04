import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, BookOpen, Plus, Save, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/modules/auth';
import { api, readApiJson } from '@/shared/api';
import type { CompanyDepartment, CompanySkill } from '@/shared/types';
import { SharingControls } from '@/modules/company/SharingControls';

function editableCopy(skill: CompanySkill): CompanySkill {
  return { ...skill, departmentIds: [...skill.departmentIds], files: skill.files.map((file) => {
    if (file.encoding !== 'base64') return { ...file };
    try {
      const bytes = Uint8Array.from(atob(file.content), (letter) => letter.charCodeAt(0));
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return content.includes('\0') ? { ...file } : { ...file, content, encoding: 'utf8' as const };
    } catch { return { ...file }; }
  }) };
}

async function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Used by App's /skills route as the company-wide library of authorized personal and shared skills. */
export function SkillsLibraryPage() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  // The authorized library and departments are refreshed after edits and access changes.
  const [skills, setSkills] = useState<CompanySkill[]>([]);
  const [departments, setDepartments] = useState<CompanyDepartment[]>([]);
  // The selected skill is an editable copy until save; an empty id denotes a new private skill.
  const [draft, setDraft] = useState<CompanySkill | null>(null);
  // Search and provider filters control library discovery without altering grants.
  const [search, setSearch] = useState('');
  // The selected provider narrows the visible library cards.
  const [provider, setProvider] = useState('all');
  // Supporting-file selection lets a skill's scripts and text assets be edited independently.
  const [selectedFile, setSelectedFile] = useState('SKILL.md');
  // The path is collected before a new supporting file is appended to the draft.
  const [newFilePath, setNewFilePath] = useState('');
  // Feedback and pending state describe the current library operation.
  const [error, setError] = useState('');
  // Saving prevents duplicate library writes.
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [library, list] = await Promise.all([
      api.company.skills().then(readApiJson<{ skills: CompanySkill[] }>),
      api.company.departments().then(readApiJson<{ departments: CompanyDepartment[] }>),
    ]);
    setSkills(library.skills); setDepartments(list.departments);
    setDraft((current) => current?.id && !library.skills.some((skill) => skill.id === current.id) ? null : current);
  }, []);
  useEffect(() => {
    const refresh = () => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))); };
    refresh(); window.addEventListener('company-access-changed', refresh);
    return () => window.removeEventListener('company-access-changed', refresh);
  }, [load]);

  const newSkill = () => {
    setDraft({ id: '', ownerUserId: Number(user?.id), visibility: 'private', departmentIds: [], canManage: true,
      name: 'new-skill', description: '', provider: 'all', content: '---\nname: new-skill\ndescription: Describe when to use this skill\n---\n\n# Instructions\n',
      files: [], createdAt: '', updatedAt: '' });
    setSelectedFile('SKILL.md'); setError('');
  };
  const save = async () => {
    if (!draft) return;
    setSaving(true); setError('');
    try {
      const result = await readApiJson<{ skill: CompanySkill }>(await (draft.id ? api.company.updateSkill(draft.id, draft) : api.company.createSkill(draft)));
      setDraft(editableCopy(result.skill)); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!draft?.id || !window.confirm(t('company.confirmDeleteSkill'))) return;
    try { await readApiJson(await api.company.deleteSkill(draft.id)); setDraft(null); await load(); }
    catch (caught) { setError(String(caught)); }
  };
  const importFiles = async (files: File[]) => {
    try {
      if (!files.length) return;
      if (files.length > 500 || files.reduce((sum, file) => sum + file.size, 0) > 30 * 1024 * 1024) throw new Error(t('company.importTooLarge'));
      const definition = files.find((file) => file.name.toLowerCase() === 'skill.md') ?? (files.length === 1 ? files[0] : undefined);
      if (!definition) throw new Error(t('company.skillFileRequired'));
      const root = definition.webkitRelativePath ? definition.webkitRelativePath.slice(0, -definition.name.length) : '';
      const supporting: CompanySkill['files'] = [];
      for (const file of files) {
        if (file === definition) continue;
        const relative = file.webkitRelativePath || file.name;
        if (root && !relative.startsWith(root)) continue;
        supporting.push({ relativePath: root ? relative.slice(root.length) : relative, content: await fileBase64(file), encoding: 'base64' });
      }
      setDraft(editableCopy({ id: '', ownerUserId: Number(user?.id), visibility: 'private', departmentIds: [], canManage: true,
        name: definition.name, description: '', provider: 'all', content: await definition.text(), files: supporting, createdAt: '', updatedAt: '' }));
      setSelectedFile('SKILL.md'); setError('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const visible = skills.filter((skill) => (provider === 'all' || skill.provider === provider || skill.provider === 'all')
    && `${skill.name} ${skill.description}`.toLowerCase().includes(search.toLowerCase()));
  const file = draft?.files.find((item) => item.relativePath === selectedFile);
  return <div className="flex h-screen flex-col bg-background text-foreground">
    <header className="flex flex-wrap items-center gap-3 border-b border-border p-4">
      <a href="/" className="flex items-center gap-1 text-sm"><ArrowLeft className="h-4 w-4" />{t('company.backToChats')}</a>
      <h1 className="flex flex-1 items-center gap-2 text-lg font-semibold"><BookOpen className="h-5 w-5" />{t('company.skillsTitle')}</h1>
      <button className="flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm" onClick={newSkill}><Plus className="h-4 w-4" />{t('company.newSkill')}</button>
      <label className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-3 py-2 text-sm"><Upload className="h-4 w-4" />{t('company.importSkill')}
        <input type="file" accept=".md" className="hidden" onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
      <label className="cursor-pointer rounded-md border border-border px-3 py-2 text-sm">{t('company.importFolder')}
        <input type="file" multiple className="hidden" ref={(node) => { node?.setAttribute('webkitdirectory', ''); }} onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
    </header>
    {error && <p role="alert" className="border-b border-border p-3 text-sm text-destructive">{error}</p>}
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="max-h-64 w-full shrink-0 overflow-auto border-b border-border p-3 md:max-h-none md:w-80 md:border-b-0 md:border-r">
        <input aria-label={t('company.searchSkills')} placeholder={t('company.searchSkills')} value={search} onChange={(event) => setSearch(event.target.value)} className="mb-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
        <select aria-label={t('company.providerFilter')} value={provider} onChange={(event) => setProvider(event.target.value)} className="mb-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
          <option value="all">{t('company.allProviders')}</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="cursor">Cursor</option><option value="opencode">OpenCode</option>
        </select>
        {!visible.length && <p className="p-3 text-sm text-muted-foreground">{t('company.noSkills')}</p>}
        {visible.map((skill) => <button key={skill.id} onClick={() => { setDraft(editableCopy(skill)); setSelectedFile('SKILL.md'); setError(''); }} className={`mb-2 w-full rounded-lg border p-3 text-left ${draft?.id === skill.id ? 'border-primary bg-accent' : 'border-border'}`}>
          <span className="block text-sm font-medium">{skill.name}</span><span className="mt-1 block text-xs text-muted-foreground">{skill.description}</span>
          <span className="mt-2 block text-xs">{skill.visibility === 'private' ? t('company.private') : skill.visibility === 'company' ? t('company.everyone') : t('company.departments')} · {skill.provider} · {skill.ownerName}</span>
        </button>)}
      </aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-auto p-4">
        {!draft ? <p className="text-muted-foreground">{t('company.selectSkill')}</p> : <div className="space-y-4">
          <div className="flex items-center gap-2"><h2 className="flex-1 font-semibold">{draft.id ? draft.name : t('company.newSkill')}</h2>
            {!draft.canManage && <span className="text-xs text-muted-foreground">{t('company.readOnly')}</span>}
            {draft.canManage && <button disabled={saving} onClick={() => void save()} className="flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"><Save className="h-4 w-4" />{t('company.save')}</button>}
            {draft.canManage && draft.id && <button onClick={() => void remove()} className="rounded-md border border-border px-3 py-2 text-sm">{t('company.delete')}</button>}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="block text-sm">{t('company.provider')}<select disabled={!draft.canManage} aria-label={t('company.provider')} value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2">
              <option value="all">{t('company.allProviders')}</option><option value="claude">Claude</option><option value="codex">Codex</option><option value="cursor">Cursor</option><option value="opencode">OpenCode</option>
            </select></label>
            <SharingControls {...draft} departments={departments} disabled={!draft.canManage} onChange={(value) => setDraft({ ...draft, ...value })} />
          </div>
          <div className="flex flex-wrap gap-2"><button className={`rounded-md border px-2 py-1 text-xs ${selectedFile === 'SKILL.md' ? 'border-primary' : 'border-border'}`} onClick={() => setSelectedFile('SKILL.md')}>SKILL.md</button>
            {draft.files.map((item) => <button key={item.relativePath} className={`rounded-md border px-2 py-1 text-xs ${selectedFile === item.relativePath ? 'border-primary' : 'border-border'}`} onClick={() => setSelectedFile(item.relativePath)}>{item.relativePath}</button>)}
          </div>
          {selectedFile === 'SKILL.md' ? <textarea aria-label="SKILL.md" spellCheck={false} readOnly={!draft.canManage} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} className="h-96 w-full rounded-md border border-border bg-background p-3 font-mono text-sm" />
            : file?.encoding === 'base64' ? <div className="space-y-2"><p className="text-sm text-muted-foreground">{t('company.binaryFile')}</p>
              {draft.canManage && <input type="file" aria-label={t('company.replaceFile')} onChange={(event) => {
                const replacement = event.target.files?.[0];
                if (replacement) void fileBase64(replacement).then((content) => setDraft({ ...draft, files: draft.files.map((item) => item.relativePath === selectedFile ? { ...item, content, encoding: 'base64' } : item) }));
              }} />}</div>
            : <textarea aria-label={selectedFile} spellCheck={false} readOnly={!draft.canManage} value={file?.content ?? ''} onChange={(event) => setDraft({ ...draft, files: draft.files.map((item) => item.relativePath === selectedFile ? { ...item, content: event.target.value, encoding: 'utf8' } : item) })} className="h-96 w-full rounded-md border border-border bg-background p-3 font-mono text-sm" />}
          {draft.canManage && <div className="flex flex-wrap gap-2">
            <input aria-label={t('company.filePath')} placeholder="scripts/helper.py" value={newFilePath} onChange={(event) => setNewFilePath(event.target.value)} className="rounded-md border border-border bg-background px-3 py-2 text-sm" />
            <button className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => {
              const relativePath = newFilePath.trim();
              if (relativePath && relativePath.toLowerCase() !== 'skill.md' && !draft.files.some((item) => item.relativePath === relativePath)) {
                setDraft({ ...draft, files: [...draft.files, { relativePath, content: '', encoding: 'utf8' }] }); setSelectedFile(relativePath); setNewFilePath('');
              }
            }}>{t('company.addFile')}</button>
            {selectedFile !== 'SKILL.md' && <button className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => { setDraft({ ...draft, files: draft.files.filter((item) => item.relativePath !== selectedFile) }); setSelectedFile('SKILL.md'); }}>{t('company.removeFile')}</button>}
          </div>}
        </div>}
      </main>
    </div>
  </div>;
}
