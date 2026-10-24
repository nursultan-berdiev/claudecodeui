import { useCallback, useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import type { CompanySkillVersion } from '@/shared/types';
import { Button } from '@/shared/ui';
import { formatSkillDate, getErrorMessage } from '@/shared/utils';

type SkillVersionHistoryProps = {
  skillId: string;
  /** Current version of the opened skill; an open history reloads when a restore or edit changes it. */
  currentVersion: number;
  canManage: boolean;
  busy: boolean;
  onRestore(version: number): void;
};

/** Used by the skill detail dialog to list stored versions and offer restoring one as a new version. */
export function SkillVersionHistory({ skillId, currentVersion, canManage, busy, onRestore }: SkillVersionHistoryProps) {
  const { t, i18n } = useTranslation('settings');
  // History is fetched only after the employee asks for it.
  const [open, setOpen] = useState(false);
  // Stored revisions, newest first.
  const [versions, setVersions] = useState<CompanySkillVersion[]>([]);
  // Failure of the last history load.
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setVersions((await readApiJson<{ versions: CompanySkillVersion[] }>(await api.company.skillVersions(skillId))).versions); setError(''); }
    catch (caught) { setError(getErrorMessage(caught)); }
  }, [skillId]);
  useEffect(() => { if (open) void load(); }, [open, currentVersion, load]);

  if (!open) return <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}><History />{t('skillsCatalog.history')}</Button>;
  return <section>
    <h3 className="mb-1 text-xs font-medium uppercase text-muted-foreground">{t('skillsCatalog.history')}</h3>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <ul className="divide-y divide-border rounded-lg border border-border">
      {versions.map((version) => <li key={version.version} className="flex items-center gap-2 px-3 py-2">
        <span className="w-10 font-medium">v{version.version}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {[formatSkillDate(version.createdAt, i18n.language), version.createdByName, version.restoredFrom ? t('skillsCatalog.restoredFrom', { version: version.restoredFrom }) : ''].filter(Boolean).join(' · ')}
        </span>
        {version.isCurrent ? <span className="text-xs text-muted-foreground">{t('skillsCatalog.currentVersion')}</span>
          : canManage && <Button type="button" size="sm" variant="ghost" disabled={busy}
            onClick={() => { if (window.confirm(t('skillsCatalog.confirmRestore', { version: version.version }))) onRestore(version.version); }}>
            {t('skillsCatalog.restore')}</Button>}
      </li>)}
    </ul>
  </section>;
}
