import { useCallback, useEffect, useState } from 'react';
import { Pencil, Star, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';
import { SkillVersionHistory } from '@/modules/skills-library/SkillVersionHistory';
import { parseSkillMarkdown } from '@/modules/skills-library/utils/skillMarkdown';
import { api, readApiJson } from '@/shared/api';
import { SKILL_AGENT_LABELS } from '@/shared/constants';
import type { CompanySkill } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { cn, formatSkillDate, getErrorMessage } from '@/shared/utils';

type SkillDetailDialogProps = {
  skillId: string;
  onClose(): void;
  onEdit(skill: CompanySkill): void;
  onToggleFavorite(skill: CompanySkill): Promise<void>;
  /** Called after delete, rollback or publish so the catalog reloads. */
  onChanged(): void;
};

/** Used by SkillsCatalogPage to show a skill in full with its history, favourite, edit, delete and publish actions. */
export function SkillDetailDialog({ skillId, onClose, onEdit, onToggleFavorite, onChanged }: SkillDetailDialogProps) {
  const { t, i18n } = useTranslation('settings');
  const { user } = useAuth();
  // The opened skill with SKILL.md and files; null while loading.
  const [skill, setSkill] = useState<CompanySkill | null>(null);
  // Failure of the last load or action.
  const [error, setError] = useState('');
  // Disables actions while one request is in flight.
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setSkill((await readApiJson<{ skill: CompanySkill }>(await api.company.skill(skillId))).skill); }
    catch (caught) { setError(getErrorMessage(caught)); }
  }, [skillId]);
  useEffect(() => { void load(); }, [load]);

  const act = async (action: () => Promise<unknown>, closeAfter = false) => {
    setBusy(true); setError('');
    try { await action(); onChanged(); if (closeAfter) onClose(); else await load(); }
    catch (caught) { setError(getErrorMessage(caught)); }
    finally { setBusy(false); }
  };

  const author = skill ? [skill.ownerName, skill.ownerDepartments.join(', ')].filter(Boolean).join(' · ') : '';
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[90vh] w-[min(44rem,calc(100vw-1.5rem))] max-w-none flex-col">
      <DialogTitle>{skill?.name ?? t('skillsCatalog.loading')}</DialogTitle>
      {!skill ? <p className="p-6 text-sm text-muted-foreground">{error || t('skillsCatalog.loading')}</p> : <>
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold">{skill.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{[author, `v${skill.version}`, formatSkillDate(skill.updatedAt, i18n.language)].filter(Boolean).join(' · ')}</p>
          </div>
          <Button type="button" variant="ghost" size="icon" aria-pressed={skill.isFavorite} aria-label={skill.isFavorite ? t('skillsCatalog.unfavorite') : t('skillsCatalog.favorite')}
            onClick={() => void onToggleFavorite(skill).then(load)}>
            <Star className={cn('h-5 w-5', skill.isFavorite && 'fill-amber-400 text-amber-400')} />
          </Button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-sm">
          <div className="flex flex-wrap gap-1.5 text-xs">
            {skill.category && <span className="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground">{skill.category}</span>}
            <span className="rounded-full border border-border px-2 py-0.5">{skill.provider === 'all' ? t('skillsCatalog.allAgents') : SKILL_AGENT_LABELS[skill.provider]}</span>
            <span className="rounded-full border border-border px-2 py-0.5">{t(`skillsCatalog.visibility.${skill.visibility}`)}</span>
          </div>
          <section><h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">{t('skillsCatalog.whenToUse')}</h3><p>{skill.description || t('skillsCatalog.noDescription')}</p></section>
          {skill.examplePrompt && <section><h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">{t('skillsCatalog.examplePrompt')}</h3>
            <p className="rounded-lg bg-muted px-3 py-2">{skill.examplePrompt}</p></section>}
          <section><h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">{t('skillsCatalog.instructions')}</h3>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-3 font-mono text-xs">{parseSkillMarkdown(skill.content).body}</pre></section>
          {skill.files.length > 0 && <section><h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">{t('skillsCatalog.files')}</h3>
            <ul className="space-y-0.5 font-mono text-xs">{skill.files.map((file) => <li key={file.relativePath}>{file.relativePath}</li>)}</ul></section>}
          <SkillVersionHistory skillId={skill.id} currentVersion={skill.version} canManage={skill.canManage} busy={busy}
            onRestore={(version) => void act(() => api.company.rollbackSkill(skill.id, version).then(readApiJson))} />
        </div>
        <footer className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          {error && <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">{error}</p>}
          <div className="ml-auto flex flex-wrap gap-2">
            {user?.role === 'admin' && skill.visibility !== 'company' && <Button type="button" variant="outline" disabled={busy}
              onClick={() => { if (window.confirm(t('skillsCatalog.confirmPublish'))) void act(() => api.company.publishSkill(skill.id).then(readApiJson)); }}>
              <Upload />{t('skillsCatalog.publish')}</Button>}
            {skill.canManage && <Button type="button" variant="outline" disabled={busy}
              onClick={() => { if (window.confirm(t('skillsCatalog.confirmDelete'))) void act(() => api.company.deleteSkill(skill.id).then(readApiJson), true); }}>
              <Trash2 />{t('skillsCatalog.delete')}</Button>}
            {skill.canManage && <Button type="button" disabled={busy} onClick={() => onEdit(skill)}><Pencil />{t('skillsCatalog.edit')}</Button>}
          </div>
        </footer>
      </>}
    </DialogContent>
  </Dialog>;
}
