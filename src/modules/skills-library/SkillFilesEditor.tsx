import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { attachedFileProblem, fileBase64 } from '@/modules/skills-library/utils/skillFiles';
import type { CompanySkillFile } from '@/shared/types';
import { Button, Input } from '@/shared/ui';
import { cn } from '@/shared/utils';

/** Used by the skill editor to add, edit, replace and remove the files attached to a skill. */
export function SkillFilesEditor({ files, onChange }: { files: CompanySkillFile[]; onChange(files: CompanySkillFile[]): void }) {
  const { t } = useTranslation('settings');
  // Attached file shown in the text editor or replace control.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Path typed for a new attached file before it is added.
  const [newFilePath, setNewFilePath] = useState('');
  // Why the typed path was refused, using the same rules the server applies on save.
  const [pathError, setPathError] = useState('');
  const selected = files.find((item) => item.relativePath === selectedPath);
  const replace = (relativePath: string, patch: Partial<CompanySkillFile>) => onChange(files.map((item) => item.relativePath === relativePath ? { ...item, ...patch } : item));
  const add = () => {
    const relativePath = newFilePath.trim().replace(/\\/g, '/');
    if (!relativePath) return;
    const problem = attachedFileProblem(relativePath, files);
    if (problem) {
      setPathError(t(`skillsCatalog.filePathProblem.${problem}`));
      return;
    }
    onChange([...files, { relativePath, content: '', encoding: 'utf8' }]);
    setSelectedPath(relativePath);
    setNewFilePath('');
    setPathError('');
  };

  return <details className="rounded-lg border border-border p-3" open={files.length > 0}>
    <summary className="cursor-pointer text-sm font-medium">{t('skillsCatalog.filesTitle', { count: files.length })}</summary>
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {files.map((item) => <button key={item.relativePath} type="button" onClick={() => setSelectedPath(item.relativePath === selectedPath ? null : item.relativePath)}
          className={cn('rounded-md border px-2 py-1 font-mono text-xs', item.relativePath === selectedPath ? 'border-primary' : 'border-border')}>{item.relativePath}</button>)}
      </div>
      {selected && (selected.encoding === 'base64'
        ? <label className="block text-sm text-muted-foreground">{t('skillsCatalog.binaryFile')}
          <input type="file" className="mt-1 block text-sm" onChange={(event) => {
            const replacement = event.target.files?.[0];
            if (replacement) void fileBase64(replacement).then((content) => replace(selected.relativePath, { content, encoding: 'base64' }));
          }} /></label>
        : <textarea aria-label={selected.relativePath} spellCheck={false} className="min-h-40 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
          value={selected.content} onChange={(event) => replace(selected.relativePath, { content: event.target.value, encoding: 'utf8' })} />)}
      <div className="flex flex-wrap gap-2">
        <Input className="max-w-xs" value={newFilePath} placeholder="scripts/helper.py" aria-label={t('skillsCatalog.filePath')} onChange={(event) => { setNewFilePath(event.target.value); setPathError(''); }} />
        <Button type="button" size="sm" variant="outline" onClick={add}>{t('skillsCatalog.addFile')}</Button>
        {selected && <Button type="button" size="sm" variant="ghost" onClick={() => { onChange(files.filter((item) => item.relativePath !== selected.relativePath)); setSelectedPath(null); }}>
          {t('skillsCatalog.removeFile')}</Button>}
      </div>
      {pathError && <p role="alert" className="text-xs text-destructive">{pathError}</p>}
    </div>
  </details>;
}
