import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Share2, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/modules/auth';
import { api, readApiJson } from '@/shared/api';
import type { CompanyDepartment, ResourceSharing } from '@/shared/types';
import { SharingControls } from '@/modules/company/SharingControls';

/** Used by the workspace header to let the chat owner publish and revoke access. */
export function ChatSharing({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  // Sharing comes from the server whenever the selected chat or its access changes.
  const [sharing, setSharing] = useState<ResourceSharing | null>(null);
  // Only departments available to this owner are shown in the editor.
  const [departments, setDepartments] = useState<CompanyDepartment[]>([]);
  // The editor holds a draft until the owner saves it.
  const [draft, setDraft] = useState<ResourceSharing | null>(null);
  // Feedback explains a refused sharing request.
  const [error, setError] = useState('');
  // Saving prevents duplicate updates.
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [state, list] = await Promise.all([
          readApiJson<ResourceSharing>(await api.company.chatSharing(sessionId)),
          readApiJson<{ departments: CompanyDepartment[]; ownDepartmentIds: number[] }>(await api.company.departments()),
        ]);
        if (active) {
          setSharing(state);
          setDepartments(list.departments.filter((department) => user?.role === 'admin' || list.ownDepartmentIds.includes(department.id)));
        }
      } catch { if (active) setSharing(null); }
    };
    setDraft(null);
    void load();
    window.addEventListener('company-access-changed', load);
    return () => { active = false; window.removeEventListener('company-access-changed', load); };
  }, [sessionId, user?.role]);

  if (!sharing) return null;
  const label = sharing.visibility === 'private' ? t('company.private') : sharing.visibility === 'company' ? t('company.everyone') : t('company.departments');
  const save = async () => {
    if (!draft) return;
    setSaving(true); setError('');
    try { setSharing(await readApiJson<ResourceSharing>(await api.company.updateChatSharing(sessionId, draft))); setDraft(null); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  };
  return <>
    <button type="button" aria-label={sharing.canManage ? t('company.shareChat') : label}
      disabled={!sharing.canManage} onClick={() => { setDraft(sharing); setError(''); }}
      className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-xs disabled:opacity-70">
      {sharing.visibility === 'private' ? <Lock className="h-3.5 w-3.5" /> : <Share2 className="h-3.5 w-3.5" />}
      <span className="hidden sm:inline">{label}</span>
    </button>
    {draft && createPortal(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4" data-escape-layer>
      <section role="dialog" aria-modal="true" aria-label={t('company.shareChat')} className="w-full max-w-md space-y-4 rounded-xl border border-border bg-background p-5 shadow-xl">
        <h2 className="font-semibold">{t('company.shareChat')}</h2>
        <p className="text-sm text-muted-foreground">{t('company.chatShareDescription')}</p>
        <SharingControls {...draft} departments={departments} onChange={(value) => setDraft({ ...draft, ...value })} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => setDraft(null)}>{t('company.cancel')}</button>
          <button disabled={saving} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={() => void save()}>{t('company.save')}</button>
        </div>
      </section>
    </div>, document.body)}
  </>;
}
