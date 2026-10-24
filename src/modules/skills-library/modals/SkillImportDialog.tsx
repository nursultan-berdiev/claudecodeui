import { useEffect, useState } from 'react';
import { FileUp, FolderUp, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SkillImportList } from '@/modules/skills-library/SkillImportList';
import { readSkillUpload } from '@/modules/skills-library/utils/skillFiles';
import { api, readApiJson } from '@/shared/api';
import type { CompanySkillFile, SkillImportItem } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { getErrorMessage } from '@/shared/utils';

type ImportSource = { id: string; items: SkillImportItem[]; error?: string };
type ImportOutcome = { imported: { id: string; name: string }[]; skipped: { key: string; code: string }[] };
type SkillImportDialogProps = {
  onClose(): void;
  /** Called after skills were copied so the catalog reloads. */
  onImported(): void;
  /** Opens the editor with an uploaded SKILL.md or folder. */
  onUpload(seed: { content: string; files: CompanySkillFile[] }): void;
};

// Server codes a skipped import can carry; anything else is shown as a generic failure.
const SKIP_REASONS = ['ALREADY_IMPORTED', 'IMPORT_SOURCE_NOT_FOUND', 'SKILL_NAME_EXISTS', 'CURATED_UNAVAILABLE', 'INVALID_SKILL_FRONTMATTER', 'INVALID_SKILL_NAME', 'INVALID_SKILL_CONTENT', 'SKILL_TOO_LARGE'];
const UPLOAD_ERRORS: Record<string, string> = { importTooLarge: 'skillsCatalog.import.importTooLarge', skillFileRequired: 'skillsCatalog.import.skillFileRequired' };

/** Used by SkillsCatalogPage to copy skills the connected agents see, the claude.ai account skills or the Codex catalog into the library. */
export function SkillImportDialog({ onClose, onImported, onUpload }: SkillImportDialogProps) {
  const { t } = useTranslation('settings');
  // Agent, claude.ai and local sources; null while the server scans them.
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  // Codex catalog from GitHub, loaded only on request because it needs the network.
  const [curated, setCurated] = useState<SkillImportItem[] | null>(null);
  // Keys the employee ticked for import.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Load, network or import failure shown in the footer.
  const [error, setError] = useState('');
  // Counts and per-skill reasons of the last import, so skipped skills are explained.
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  // Which request is running: the catalog download or the import itself.
  const [busy, setBusy] = useState<'curated' | 'import' | null>(null);

  const loadSources = async () => {
    try { setSources((await readApiJson<{ sources: ImportSource[] }>(await api.company.skillImportSources())).sources); }
    catch (caught) { setError(getErrorMessage(caught)); setSources([]); }
  };
  useEffect(() => { void loadSources(); }, []);

  const loadCurated = async () => {
    setBusy('curated'); setError('');
    try { setCurated((await readApiJson<{ items: SkillImportItem[] }>(await api.company.curatedSkills())).items); }
    catch (caught) { setError(getErrorMessage(caught)); }
    finally { setBusy(null); }
  };
  const runImport = async () => {
    setBusy('import'); setError(''); setOutcome(null);
    try {
      setOutcome(await readApiJson<ImportOutcome>(await api.company.importSkills([...selected])));
      setSelected(new Set());
      onImported();
      await loadSources();
      if (curated) await loadCurated();
    } catch (caught) { setError(getErrorMessage(caught)); }
    finally { setBusy(null); }
  };
  const upload = async (files: File[]) => {
    if (!files.length) return;
    try { onUpload(await readSkillUpload(files)); }
    catch (caught) {
      const code = (caught as { code?: unknown } | null)?.code;
      setError(typeof code === 'string' && UPLOAD_ERRORS[code] ? t(UPLOAD_ERRORS[code]) : getErrorMessage(caught));
    }
  };
  const toggle = (key: string, checked: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (checked) next.add(key); else next.delete(key);
    return next;
  });
  const knownItems = [...(sources ?? []).flatMap((source) => source.items), ...curated ?? []];
  const skippedName = (key: string) => knownItems.find((item) => item.key === key)?.name ?? key.slice(key.indexOf(':') + 1);

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[90vh] w-[min(44rem,calc(100vw-1.5rem))] max-w-none flex-col">
      <DialogTitle>{t('skillsCatalog.import.title')}</DialogTitle>
      <header className="border-b border-border px-5 py-3">
        <h2 className="text-base font-semibold">{t('skillsCatalog.import.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('skillsCatalog.import.description')}</p>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"><FileUp className="h-4 w-4" />{t('skillsCatalog.import.file')}
            <input type="file" accept=".md" className="hidden" onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"><FolderUp className="h-4 w-4" />{t('skillsCatalog.import.folder')}
            <input type="file" multiple className="hidden" ref={(node) => { node?.setAttribute('webkitdirectory', ''); }} onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
        </div>
        {outcome && <div role="status" className="rounded-lg border border-border p-3 text-sm">
          <p>{t('skillsCatalog.import.result', { imported: outcome.imported.length, skipped: outcome.skipped.length })}</p>
          {outcome.skipped.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
            {outcome.skipped.map((item) => <li key={item.key}>{skippedName(item.key)}: {t(`skillsCatalog.import.reasons.${SKIP_REASONS.includes(item.code) ? item.code : 'IMPORT_FAILED'}`)}</li>)}
          </ul>}
        </div>}
        {!sources ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('skillsCatalog.loading')}</p>
          : sources.filter((source) => source.items.length || source.id === 'claude-synced' || source.error).map((source) => <section key={source.id}>
            <h3 className="mb-1 text-sm font-medium">{t(`skillsCatalog.import.sources.${source.id}`, { defaultValue: source.id })}</h3>
            {source.error && <p className="text-xs text-destructive">{source.error}</p>}
            {!source.items.length && source.id === 'claude-synced' && <p className="text-xs text-muted-foreground">{t('skillsCatalog.import.syncedEmpty')}</p>}
            <SkillImportList items={source.items} selected={selected} onToggle={toggle} />
          </section>)}
        <section>
          <h3 className="mb-1 text-sm font-medium">{t('skillsCatalog.import.sources.codex-curated')}</h3>
          {curated ? <SkillImportList items={curated} selected={selected} onToggle={toggle} /> : <Button type="button" size="sm" variant="outline" disabled={busy === 'curated'} onClick={() => void loadCurated()}>
            {busy === 'curated' && <Loader2 className="animate-spin" />}{t('skillsCatalog.import.loadCurated')}</Button>}
        </section>
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
        {error && <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">{error}</p>}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('skillsCatalog.close')}</Button>
          <Button type="button" disabled={!selected.size || busy === 'import'} onClick={() => void runImport()}>
            {busy === 'import' && <Loader2 className="animate-spin" />}{t('skillsCatalog.import.submit', { count: selected.size })}</Button>
        </div>
      </footer>
    </DialogContent>
  </Dialog>;
}
