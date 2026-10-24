import { useState } from 'react';
import { createPortal } from 'react-dom';
import { SquarePen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, readApiJson } from '@/shared/api';
import { writeSelectedProvider } from '@/shared/selectedProvider';
import type { LLMProvider, Project } from '@/shared/types';

const AGENTS = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }];

async function isSignedIn(agent: string): Promise<boolean> {
  try {
    return (await readApiJson<{ data: { authenticated?: boolean } }>(await api.providers.authStatus(agent))).data.authenticated === true;
  } catch { return false; }
}

/**
 * Used by the sidebar (its header and collapsed rail) and by project-workspace's
 * empty view to open an owner-only chat even when the user has no selected project.
 * `compact` draws the icon alone for the collapsed rail.
 */
export function NewChatButton({ onOpenChat, compact = false }: { onOpenChat: (project: Project) => void; compact?: boolean }) {
  const { t } = useTranslation('settings');
  // The modal collects the provider and shared workspace for a fresh private chat.
  const [open, setOpen] = useState(false);
  // Project choices are fetched when the user opens the dialog.
  const [projects, setProjects] = useState<Project[]>([]);
  // New chats start on the default shared chats workspace unless a project is selected.
  const [projectPath, setProjectPath] = useState('');
  // Only agents with stored credentials are offered: any other fails on the first message.
  const [agents, setAgents] = useState<string[]>([]);
  // Provider selection controls the CLI used by the new chat.
  const [provider, setProvider] = useState('claude');
  // Pending and error state describe the creation request.
  const [pending, setPending] = useState(false);
  // Creation errors stay in the modal so the user can correct the request.
  const [error, setError] = useState('');
  const start = async () => {
    setOpen(true); setError('');
    try {
      const [projectList, signedIn] = await Promise.all([
        readApiJson<Project[]>(await api.projects()),
        Promise.all(AGENTS.map((agent) => isSignedIn(agent.id))),
      ]);
      const ready = AGENTS.filter((_agent, index) => signedIn[index]).map((agent) => agent.id);
      setProjects(projectList); setAgents(ready);
      setProvider((current) => (ready.includes(current) ? current : ready[0] ?? ''));
      if (!ready.length) setError(t('company.noAgentReady'));
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const create = async () => {
    setPending(true); setError('');
    try {
      const workspace = projectPath || '/workspace/chats';
      let project = projects.find((item) => item.fullPath === workspace);
      if (!project) {
        const response = await api.createProject({ path: workspace, customName: t('company.chats') });
        if (response.status !== 409) await readApiJson(response);
        project = (await readApiJson<Project[]>(await api.projects())).find((item) => item.fullPath === workspace);
      }
      if (!project) throw new Error(t('company.chatWorkspaceMissing'));
      writeSelectedProvider(provider as LLMProvider);
      // The composer creates the chat on the first message and names it after that message.
      onOpenChat(project);
      setOpen(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    setPending(false);
  };
  return <>
    {compact ? (
      <button type="button" onClick={() => void start()} aria-label={t('company.newChat')} title={t('company.newChat')}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
        <SquarePen className="h-4 w-4" />
      </button>
    ) : (
      <button type="button" onClick={() => void start()} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent">
        <SquarePen className="h-4 w-4" />{t('company.newChat')}
      </button>
    )}
    {open && createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" data-escape-layer>
      <section role="dialog" aria-modal="true" aria-label={t('company.newChat')} className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-background p-5 shadow-xl">
        <h2 className="font-semibold">{t('company.newChat')}</h2>
        <p className="text-sm text-muted-foreground">{t('company.newChatDescription')}</p>
        <label className="block text-sm">{t('company.provider')}<select aria-label={t('company.provider')} value={provider} onChange={(event) => setProvider(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2">
          {AGENTS.filter((agent) => agents.includes(agent.id)).map((agent) => <option key={agent.id} value={agent.id}>{agent.label}</option>)}
        </select></label>
        <label className="block text-sm">{t('company.project')}<select aria-label={t('company.project')} value={projectPath} onChange={(event) => setProjectPath(event.target.value)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2">
          <option value="">{t('company.defaultWorkspace')}</option>
          {projects.map((project) => <option key={project.projectId} value={project.fullPath}>{project.displayName}</option>)}
        </select></label>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2"><button className="rounded-full border border-border px-4 py-2 text-sm hover:bg-accent" onClick={() => setOpen(false)}>{t('company.cancel')}</button>
          <button disabled={pending || !provider} className="rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={() => void create()}>{t('company.create')}</button></div>
      </section>
    </div>, document.body)}
  </>;
}
