import { FileText, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SKILL_AGENT_LABELS } from '@/shared/constants';
import type { CompanySkillSummary } from '@/shared/types';
import { cn, formatSkillDate } from '@/shared/utils';

type SkillCardProps = {
  skill: CompanySkillSummary;
  onOpen(): void;
  onToggleFavorite(): void;
};

/** Used by SkillsCatalogPage to show one skill in the catalog grid. */
export function SkillCard({ skill, onOpen, onToggleFavorite }: SkillCardProps) {
  const { t, i18n } = useTranslation('settings');
  const author = [skill.ownerName, skill.ownerDepartments.join(', ')].filter(Boolean).join(' · ');
  return <article className="group relative flex flex-col rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/30">
    <button type="button" onClick={onOpen} className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('skillsCatalog.open', { name: skill.name })} />
    <div className="flex items-start gap-2">
      <h3 className="min-w-0 flex-1 truncate font-medium">{skill.name}</h3>
      <button type="button" onClick={onToggleFavorite} aria-pressed={skill.isFavorite}
        aria-label={skill.isFavorite ? t('skillsCatalog.unfavorite') : t('skillsCatalog.favorite')}
        className="relative z-10 -m-1 rounded-md p-1 text-muted-foreground hover:text-foreground">
        <Star className={cn('h-4 w-4', skill.isFavorite && 'fill-amber-400 text-amber-400')} />
      </button>
    </div>
    <p className="mt-1 line-clamp-3 flex-1 text-sm text-muted-foreground">{skill.description || t('skillsCatalog.noDescription')}</p>
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {skill.category && <span className="rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground">{skill.category}</span>}
      {skill.provider !== 'all' && <span className="rounded-full border border-border px-2 py-0.5">{SKILL_AGENT_LABELS[skill.provider]}</span>}
      <span className="rounded-full border border-border px-2 py-0.5">{t(`skillsCatalog.visibility.${skill.visibility}`)}</span>
    </div>
    <div className="mt-3 flex items-center gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{author}</span>
      {skill.fileCount > 0 && <span className="flex items-center gap-0.5" title={t('skillsCatalog.files')}><FileText className="h-3 w-3" />{skill.fileCount}</span>}
      <span>v{skill.version}</span>
      <span>{formatSkillDate(skill.updatedAt, i18n.language)}</span>
    </div>
  </article>;
}
