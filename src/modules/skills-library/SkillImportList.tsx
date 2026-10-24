import { useTranslation } from 'react-i18next';

import type { SkillImportItem } from '@/shared/types';
import { cn } from '@/shared/utils';

/** Used by the import dialog to render one source's skills as a checklist; skills the employee already has are disabled. */
export function SkillImportList({ items, selected, onToggle }: { items: SkillImportItem[]; selected: Set<string>; onToggle(key: string, checked: boolean): void }) {
  const { t } = useTranslation('settings');
  return <ul className="space-y-1">
    {items.map((item) => <li key={item.key}>
      <label className={cn('flex gap-2 rounded-md px-2 py-1.5 text-sm', item.alreadyImported ? 'opacity-60' : 'cursor-pointer hover:bg-accent/50')}>
        <input type="checkbox" className="mt-1" disabled={item.alreadyImported} checked={selected.has(item.key)} onChange={(event) => onToggle(item.key, event.target.checked)} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-1.5 font-medium">{item.pluginName ? `${item.pluginName}:${item.name}` : item.name}
            {item.alreadyImported && <span className="rounded-full bg-secondary px-1.5 text-xs font-normal">{t('skillsCatalog.import.alreadyYours')}</span>}
            {!item.alreadyImported && item.inLibrary && <span className="rounded-full border border-border px-1.5 text-xs font-normal">{t('skillsCatalog.import.inLibrary')}</span>}
          </span>
          <span className="line-clamp-2 text-xs text-muted-foreground">{item.description}</span>
        </span>
      </label>
    </li>)}
  </ul>;
}
