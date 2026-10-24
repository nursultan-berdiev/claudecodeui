import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, readApiJson } from '@/shared/api';
import type { CompanyDepartment } from '@/shared/types';

type StaffUser = { id: number; username: string; is_active: number };

/** Used by administrator Settings to create departments and assign users to multiple departments. */
export function DepartmentsPanel() {
  const { t } = useTranslation('settings');
  // Department and staff lists are loaded together for membership editing.
  const [departments, setDepartments] = useState<CompanyDepartment[]>([]);
  // Active staff accounts populate each department's membership choices.
  const [users, setUsers] = useState<StaffUser[]>([]);
  // An unsaved department keeps its id at zero until creation succeeds.
  const [draft, setDraft] = useState<CompanyDepartment>({ id: 0, name: '', description: '', memberIds: [] });
  // Feedback and pending state describe the current administrative request.
  const [error, setError] = useState('');
  // A pending save disables duplicate department writes.
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    const [list, staff] = await Promise.all([
      api.company.departments().then(readApiJson<{ departments: CompanyDepartment[] }>),
      api.auth.listUsers().then(readApiJson<{ users: StaffUser[] }>),
    ]);
    setDepartments(list.departments); setUsers(staff.users.filter((user) => user.is_active === 1));
  }, []);
  useEffect(() => { void load().catch((caught) => setError(String(caught))); }, [load]);
  const save = async () => {
    setSaving(true); setError('');
    try {
      const id = draft.id || (await readApiJson<{ id: number }>(await api.company.createDepartment(draft))).id;
      await readApiJson(await api.company.updateDepartment(id, draft));
      setDraft({ ...draft, id }); await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!draft.id || !window.confirm(t('company.confirmDeleteDepartment'))) return;
    try { await readApiJson(await api.company.deleteDepartment(draft.id)); setDraft({ id: 0, name: '', description: '', memberIds: [] }); await load(); }
    catch (caught) { setError(String(caught)); }
  };
  return <section className="space-y-4">
    <h3 className="text-lg font-semibold">{t('company.departmentsTitle')}</h3>
    <p className="text-sm text-muted-foreground">{t('company.departmentsDescription')}</p>
    <div className="flex flex-wrap gap-2">
      {departments.map((department) => <button key={department.id} className={`rounded-md border px-3 py-2 text-sm ${draft.id === department.id ? 'border-primary bg-accent' : 'border-border'}`}
        onClick={() => setDraft({ ...department })}>{department.name} ({department.memberIds.length})</button>)}
      <button className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => setDraft({ id: 0, name: '', description: '', memberIds: [] })}>{t('company.newDepartment')}</button>
    </div>
    <label className="block text-sm">{t('company.departmentName')}<input aria-label={t('company.departmentName')} value={draft.name} maxLength={100}
      onChange={(event) => setDraft({ ...draft, name: event.target.value })} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" /></label>
    <label className="block text-sm">{t('company.description')}<textarea value={draft.description} maxLength={1000}
      onChange={(event) => setDraft({ ...draft, description: event.target.value })} className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2" /></label>
    <fieldset className="space-y-2 rounded-md border border-border p-3"><legend className="px-1 text-sm">{t('company.members')}</legend>
      {users.map((user) => <label key={user.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.memberIds.includes(user.id)}
        onChange={(event) => setDraft({ ...draft, memberIds: event.target.checked ? [...draft.memberIds, user.id] : draft.memberIds.filter((id) => id !== user.id) })} />{user.username}</label>)}
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex gap-2"><button disabled={saving || !draft.name.trim()} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" onClick={() => void save()}>{t('company.save')}</button>
      {draft.id > 0 && <button className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => void remove()}>{t('company.delete')}</button>}</div>
  </section>;
}
