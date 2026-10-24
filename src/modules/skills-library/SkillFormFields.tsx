import { useTranslation } from 'react-i18next';

import type { SkillMarkdownParts } from '@/modules/skills-library/utils/skillMarkdown';
import { toSkillName } from '@/modules/skills-library/utils/skillMarkdown';
import { Input } from '@/shared/ui';

type SkillFormFieldsProps = {
  parts: SkillMarkdownParts;
  category: string;
  examplePrompt: string;
  categorySuggestions: string[];
  onPartsChange(patch: Partial<SkillMarkdownParts>): void;
  onFieldsChange(patch: { category?: string; examplePrompt?: string }): void;
};

const fieldClass = 'mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

/** Used by the skill editor's form mode: SKILL.md name, description and instructions plus the catalog-only category and example. */
export function SkillFormFields({ parts, category, examplePrompt, categorySuggestions, onPartsChange, onFieldsChange }: SkillFormFieldsProps) {
  const { t } = useTranslation('settings');
  return <div className="grid gap-3 md:grid-cols-2">
    <label className="block text-sm">{t('skillsCatalog.name')}
      <Input className="mt-1" value={parts.name} placeholder="weekly-report" onChange={(event) => onPartsChange({ name: toSkillName(event.target.value) })} />
      <span className="mt-1 block text-xs text-muted-foreground">{t('skillsCatalog.nameHint', { command: `/${parts.name || 'name'}` })}</span>
    </label>
    <label className="block text-sm">{t('skillsCatalog.category')}
      <Input className="mt-1" list="skill-category-suggestions" maxLength={50} value={category} onChange={(event) => onFieldsChange({ category: event.target.value })} />
      <datalist id="skill-category-suggestions">{categorySuggestions.map((item) => <option key={item} value={item} />)}</datalist>
    </label>
    <label className="block text-sm md:col-span-2">{t('skillsCatalog.whenToUse')}
      <textarea className={fieldClass} rows={2} value={parts.description} placeholder={t('skillsCatalog.whenToUsePlaceholder')}
        onChange={(event) => onPartsChange({ description: event.target.value.replace(/\n/g, ' ') })} />
    </label>
    <label className="block text-sm md:col-span-2">{t('skillsCatalog.examplePrompt')}
      <Input className="mt-1" maxLength={2000} value={examplePrompt} placeholder={t('skillsCatalog.examplePromptPlaceholder')} onChange={(event) => onFieldsChange({ examplePrompt: event.target.value })} />
    </label>
    <label className="block text-sm md:col-span-2">{t('skillsCatalog.instructions')}
      <textarea className={`${fieldClass} min-h-56 font-mono`} value={parts.body} placeholder={t('skillsCatalog.instructionsPlaceholder')} onChange={(event) => onPartsChange({ body: event.target.value })} />
    </label>
  </div>;
}
