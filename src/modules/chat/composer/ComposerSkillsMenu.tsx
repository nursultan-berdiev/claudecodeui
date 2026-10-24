import { useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { BookOpen, Pin, Star } from 'lucide-react';

import { ComposerMenuHeading, ComposerMenuSeparator, ComposerMenuSurface } from '@/modules/chat/composer/ComposerMenuPrimitives';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import { useComposerSkillSelection } from '@/modules/chat/hooks/useComposerSkillSelection';
import { useSkillCatalog } from '@/modules/skills-library';
import type { CompanySkillSummary, LLMProvider } from '@/shared/types';
import { cn } from '@/shared/utils';

const RECENT_LIMIT = 5;

/**
 * Rendered by chat's ChatComposer next to the model menu: picks a library skill for the next message
 * or pins it to the whole chat, with search, favourites and recently used skills.
 */
export default function ComposerSkillsMenu({ scope, provider }: { scope: string | null; provider: LLMProvider }) {
  const { t } = useTranslation('chat');
  const navigate = useNavigate();
  // Whether the popover is open; the catalog is fetched only while it is.
  const [isOpen, setIsOpen] = useState(false);
  // Search text typed in the popover.
  const [query, setQuery] = useState('');
  const close = useCallback(() => { setIsOpen(false); setQuery(''); }, []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close, 360);
  const { skills, loading, toggleFavorite } = useSkillCatalog({ enabled: isOpen });
  const selection = useComposerSkillSelection(scope);
  const pinnedIds = new Set(selection.pinned.map((skill) => skill.id));
  const available = skills.filter((skill) => skill.provider === 'all' || skill.provider === provider);
  const search = query.trim().toLowerCase();

  const sections: { key: string; items: CompanySkillSummary[] }[] = [];
  if (search) {
    sections.push({ key: 'all', items: available.filter((skill) => `${skill.name} ${skill.description} ${skill.category}`.toLowerCase().includes(search)) });
  } else {
    const pinned = available.filter((skill) => pinnedIds.has(skill.id));
    const favorites = available.filter((skill) => skill.isFavorite && !pinnedIds.has(skill.id));
    const recent = available.filter((skill) => skill.lastUsedAt && !skill.isFavorite && !pinnedIds.has(skill.id))
      .sort((left, right) => String(right.lastUsedAt).localeCompare(String(left.lastUsedAt))).slice(0, RECENT_LIMIT);
    const shown = new Set([...pinned, ...favorites, ...recent].map((skill) => skill.id));
    sections.push({ key: 'pinned', items: pinned }, { key: 'favorites', items: favorites }, { key: 'recent', items: recent },
      { key: 'all', items: available.filter((skill) => !shown.has(skill.id)) });
  }
  const visibleSections = sections.filter((section) => section.items.length);
  const label = t('composer.skills.menuLabel');

  return <>
    <button ref={triggerRef} type="button" aria-haspopup="menu" aria-expanded={isOpen} aria-label={label} title={label}
      onClick={() => { updateAnchor(); setIsOpen((current) => !current); }}
      className={cn('flex h-9 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        (selection.oneTime || selection.pinned.length > 0) && 'text-foreground')}>
      <BookOpen className="h-4 w-4" aria-hidden />
      <span className="hidden sm:inline">{t('composer.skills.button')}</span>
    </button>
    {isOpen && anchor && createPortal(<ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={label}>
      <div className="p-1.5">
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('composer.skills.search')} aria-label={t('composer.skills.search')}
          className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
      </div>
      {!visibleSections.length && <p className="px-2.5 py-2 text-sm text-muted-foreground">{loading ? '…' : t('composer.skills.empty')}</p>}
      {visibleSections.map((section) => <div key={section.key}>
        <ComposerMenuHeading>{t(`composer.skills.${section.key}`)}</ComposerMenuHeading>
        {section.items.map((skill) => {
          const isPinned = pinnedIds.has(skill.id);
          return <div key={skill.id} className="flex items-start gap-0.5 rounded-lg hover:bg-accent">
            <button type="button" role="menuitem" className="min-w-0 flex-1 px-2.5 py-1.5 text-left" onClick={() => { selection.chooseOnce(skill); close(); }}>
              <span className="block truncate text-sm leading-5">{skill.name}</span>
              {skill.description && <span className="block truncate text-xs text-muted-foreground">{skill.description}</span>}
            </button>
            <button type="button" aria-pressed={skill.isFavorite} aria-label={skill.isFavorite ? t('composer.skills.unfavorite') : t('composer.skills.favorite')}
              title={skill.isFavorite ? t('composer.skills.unfavorite') : t('composer.skills.favorite')}
              onClick={() => void toggleFavorite(skill)} className="mt-1 rounded-md p-1 text-muted-foreground hover:text-foreground">
              <Star className={cn('h-3.5 w-3.5', skill.isFavorite && 'fill-amber-400 text-amber-400')} />
            </button>
            <button type="button" aria-pressed={isPinned} aria-label={isPinned ? t('composer.skills.unpin') : t('composer.skills.pin')}
              title={isPinned ? t('composer.skills.unpin') : t('composer.skills.pin')}
              onClick={() => selection.togglePin(skill)} className={cn('mr-1 mt-1 rounded-md p-1 hover:text-foreground', isPinned ? 'text-foreground' : 'text-muted-foreground')}>
              <Pin className={cn('h-3.5 w-3.5', isPinned && 'fill-current')} />
            </button>
          </div>;
        })}
      </div>)}
      <ComposerMenuSeparator />
      <button type="button" role="menuitem" onClick={() => { close(); navigate('/skills'); }}
        className="w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground">{t('composer.skills.openCatalog')}</button>
    </ComposerMenuSurface>, document.body)}
  </>;
}
