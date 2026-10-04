import { useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquarePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, readApiJson } from '@/shared/api';
import type { Project } from '@/shared/types';

/** Used by the sidebar to create an owner-only chat even when the user has no selected project. */
export function NewChatButton() {
  const { t } = useTranslation('settings');
  // The modal collects the provider and shared workspace for a fresh private chat.
  const [open, setOpen] = useState(false);
  // Project choices are fetched when the user opens the dialog.
  const [projects, setProjects] = useState<Project[]>([]);
  // New chats start on the default shared chats workspace unless a project is selected.
  const [projectPath, setProjectPath] = useState('');
  // Provider selection controls the CLI used by the new chat.
  const [provider, setProvider] = useState('claude');
  // Pending and error state describe the creation request.
  const [pending, setPending] = useState(false);
  // Creation errors stay in the modal so the user can correct the request.
  const [error, setError] = useState('');
  const start = async () => {
    setOpen(true); setError('');
    try { setProjects(await readApiJson<Project[]>(await api.projects())); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const create = async () => {
    setPending(true); setError('');
    try {
      const workspace = projectPath || '/workspace/chats';
      if (!projectPath && !projects.some((project) => project.fullPath === workspace)) {
        const response = await api.createProject({ path: workspace, customName: t('company.chats') });
        if (response.status !== 409) await readApiJson(response);
      }
      const result = await readApiJson<{ data: { sessionId: string } }>(await api.providers.createSession({ provider, projectPath: workspace, initialMessage: t('company.newChat') }));
      window.location.assign(`/session/${encodeURIComponent(result.data.sessionId)}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setPending(false); }
  };
  return <>
    <button type="button" onClick={() => void start()} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent">
      <MessageSquarePlus className="h-4 w-4" />{t('company.newChat')}
    </button>
    {open && createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" data-escape-layer>
      <section role="dialog" aria-modal="true" aria-label={t('company.newChat')} className="w-full max-w-md space-y-4 rounded-xl border border-border bg-background p-5 shadow-xl">
        <h2 className="font-semibold">{t('company.newChat')}</h2>
        <p className="text-sm text-muted-foreground">{t('company.newChatDescription')}</p>
        <label className="block text-sm">{t('company.provider')}<select aria-label={t('company.provider')} value={provider} onChange={(event) => setProvider(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2">
          <option value="claude">Claude Code</option><option value="codex">Codex</option>
        </select></label>
        <label className="block text-sm">{t('company.project')}<select aria-label={t('company.project')} value={projectPath} onChange={(event) => setProjectPath(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2">
          <option value="">{t('company.defaultWorkspace')}</option>
          {projects.map((project) => <option key={project.projectId} value={project.fullPath}>{project.displayName}</option>)}
        </select></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><button className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => setOpen(false)}>{t('company.cancel')}</button>
          <button disabled={pending} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={() => void create()}>{t('company.create')}</button></div>
      </section>
    </div>, document.body)}
  </>;
}
