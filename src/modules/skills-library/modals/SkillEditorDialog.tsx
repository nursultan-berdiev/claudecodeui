import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';
import { SkillHelperPanel } from '@/modules/skills-library/SkillHelperPanel';
import { SkillSharingControl } from '@/modules/skills-library/SkillSharingControl';
import { SkillFilesEditor } from '@/modules/skills-library/SkillFilesEditor';
import { SkillFormFields } from '@/modules/skills-library/SkillFormFields';
import { editableFiles } from '@/modules/skills-library/utils/skillFiles';
import { composeSkillMarkdown, parseSkillMarkdown, toSkillName } from '@/modules/skills-library/utils/skillMarkdown';
import { api, readApiJson } from '@/shared/api';
import { SKILL_AGENT_LABELS } from '@/shared/constants';
import type { CompanyDepartment, CompanyPerson, CompanySkill, CompanySkillFile, SkillAgent, SkillHelperDraft, SkillVisibility } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, Pill, PillBar } from '@/shared/ui';
import { getErrorMessage } from '@/shared/utils';

type EditorState = {
  content: string; category: string; examplePrompt: string; provider: SkillAgent;
  visibility: SkillVisibility; departmentIds: number[]; userIds: number[]; files: CompanySkillFile[];
};
type SkillEditorDialogProps = {
  /** The skill being edited, or null for a new one. */
  skill: CompanySkill | null;
  /** Content of an uploaded SKILL.md or folder that starts a new skill. */
  seed?: { content: string; files: CompanySkillFile[] } | null;
  categories: string[];
  onClose(): void;
  onSaved(skill: CompanySkill): void;
};

const fieldClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
const isSkillAgent = (value: string): value is SkillAgent => value === 'all' || Object.prototype.hasOwnProperty.call(SKILL_AGENT_LABELS, value);

/** Used by SkillsCatalogPage to create or edit a skill as a form, with a raw markdown fallback, sharing and the helper. */
export function SkillEditorDialog({ skill, seed, categories, onClose, onSaved }: SkillEditorDialogProps) {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const currentUserId = Number(user?.id);
  const isAdmin = user?.role === 'admin';
  // Files as opened; text attachments are decoded for editing, so they are sent back only when the user changed them.
  const [initialFiles] = useState(() => editableFiles(skill?.files ?? seed?.files ?? []));
  // The editable skill; SKILL.md stays the single source of truth so both modes always show the same skill.
  const [state, setState] = useState<EditorState>(() => ({
    content: skill?.content ?? seed?.content ?? composeSkillMarkdown({ name: '', description: '', body: '', extraFrontmatter: [] }),
    category: skill?.category ?? '', examplePrompt: skill?.examplePrompt ?? '', provider: skill?.provider ?? 'all',
    visibility: skill?.visibility ?? 'private', departmentIds: skill?.departmentIds ?? [], userIds: skill?.userIds ?? [],
    files: initialFiles,
  }));
  // Form for most employees; markdown for people who already have a SKILL.md to paste.
  const [mode, setMode] = useState<'form' | 'markdown'>('form');
  // Sharing targets loaded on open: departments with the caller's own ones, and active colleagues.
  const [directory, setDirectory] = useState<{ departments: CompanyDepartment[]; ownDepartmentIds: number[]; people: CompanyPerson[] }>({ departments: [], ownDepartmentIds: [], people: [] });
  // Server validation message from the last save attempt.
  const [error, setError] = useState('');
  // Prevents double submits while the save request is running.
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([
      api.company.departments().then(readApiJson<{ departments: CompanyDepartment[]; ownDepartmentIds: number[] }>),
      api.company.people().then(readApiJson<{ people: CompanyPerson[] }>),
    ]).then(([departments, people]) => setDirectory({ ...departments, people: people.people }))
      .catch((caught) => setError(getErrorMessage(caught)));
  }, []);

  const parts = useMemo(() => parseSkillMarkdown(state.content), [state.content]);
  const suggestions = useMemo(() => [...new Set([...categories, ...t('skillsCatalog.defaultCategories').split(',').map((item) => item.trim())])], [categories, t]);
  const updateParts = (patch: Partial<typeof parts>) => setState((current) => ({ ...current, content: composeSkillMarkdown({ ...parseSkillMarkdown(current.content), ...patch }) }));
  const applyDraft = (draft: SkillHelperDraft) => {
    setState((current) => ({ ...current, category: draft.category || current.category, examplePrompt: draft.examplePrompt || current.examplePrompt,
      content: composeSkillMarkdown({ ...parseSkillMarkdown(current.content), name: toSkillName(draft.name), description: draft.description, body: draft.body }) }));
    setMode('form');
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      const { files, ...fields } = state;
      // Re-sending decoded but untouched files would record a new version on every save.
      const payload = { ...fields, content: state.content.trim(), ...(!skill || files !== initialFiles ? { files } : {}) };
      const result = await readApiJson<{ skill: CompanySkill }>(await (skill ? api.company.updateSkill(skill.id, payload) : api.company.createSkill(payload)));
      onSaved(result.skill);
    } catch (caught) { setError(getErrorMessage(caught)); }
    finally { setSaving(false); }
  };

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[92vh] w-[min(56rem,calc(100vw-1.5rem))] max-w-none flex-col">
      <DialogTitle>{skill ? t('skillsCatalog.editTitle', { name: skill.name }) : t('skillsCatalog.newTitle')}</DialogTitle>
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3">
        <h2 className="flex-1 text-base font-semibold">{skill ? t('skillsCatalog.editTitle', { name: skill.name }) : t('skillsCatalog.newTitle')}</h2>
        <PillBar>
          <Pill isActive={mode === 'form'} onClick={() => setMode('form')}>{t('skillsCatalog.modeForm')}</Pill>
          <Pill isActive={mode === 'markdown'} onClick={() => setMode('markdown')}>{t('skillsCatalog.modeMarkdown')}</Pill>
        </PillBar>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <SkillHelperPanel canImprove={Boolean(parts.body.trim())} currentContent={state.content} onDraft={applyDraft} />
        {mode === 'form' ? <SkillFormFields parts={parts} category={state.category} examplePrompt={state.examplePrompt} categorySuggestions={suggestions}
          onPartsChange={updateParts} onFieldsChange={(patch) => setState({ ...state, ...patch })} />
          : <label className="block text-sm">SKILL.md
          <textarea aria-label="SKILL.md" spellCheck={false} className={`${fieldClass} mt-1 min-h-96 font-mono`} value={state.content} onChange={(event) => setState({ ...state, content: event.target.value })} />
        </label>}

        <SkillFilesEditor files={state.files} onChange={(files) => setState({ ...state, files })} />

        <label className="block max-w-xs text-sm">{t('skillsCatalog.agentOnly')}
          <select className={`${fieldClass} mt-1`} value={state.provider} onChange={(event) => { const provider = event.target.value; if (isSkillAgent(provider)) setState({ ...state, provider }); }}>
            <option value="all">{t('skillsCatalog.allAgents')}</option>
            {Object.entries(SKILL_AGENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>

        <SkillSharingControl visibility={state.visibility} departmentIds={state.departmentIds} userIds={state.userIds}
          departments={directory.departments} ownDepartmentIds={directory.ownDepartmentIds} people={directory.people}
          currentUserId={skill?.ownerUserId ?? currentUserId} isAdmin={isAdmin} canKeepCompany={skill?.visibility === 'company'}
          onChange={(sharing) => setState({ ...state, ...sharing })} />
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
        {error && <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">{error}</p>}
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('skillsCatalog.cancel')}</Button>
          <Button type="button" disabled={saving || !parts.name} onClick={() => void save()}>{t('skillsCatalog.save')}</Button>
        </div>
      </footer>
    </DialogContent>
  </Dialog>;
}
