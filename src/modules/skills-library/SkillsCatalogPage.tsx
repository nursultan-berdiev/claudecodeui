import { useMemo, useState } from 'react';
import { ArrowLeft, Download, Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/modules/auth';
import { SkillCard } from '@/modules/skills-library/SkillCard';
import { useSkillCatalog } from '@/modules/skills-library/hooks/useSkillCatalog';
import { SkillDetailDialog } from '@/modules/skills-library/modals/SkillDetailDialog';
import { SkillEditorDialog } from '@/modules/skills-library/modals/SkillEditorDialog';
import { SkillImportDialog } from '@/modules/skills-library/modals/SkillImportDialog';
import { SKILL_AGENT_LABELS } from '@/shared/constants';
import type { CompanySkill, CompanySkillFile, CompanySkillSummary } from '@/shared/types';
import { Button, Input, Pill, PillBar } from '@/shared/ui';
import { cn } from '@/shared/utils';

type CatalogView = 'all' | 'favorites' | 'recent' | 'mine' | 'shared';
type EditorTarget = { skill: CompanySkill | null; seed?: { content: string; files: CompanySkillFile[] } | null };

const VIEWS: CatalogView[] = ['all', 'favorites', 'recent', 'mine', 'shared'];

/** Used by App's /skills route as the employee skills catalog: browse, create, share, import and open skills. */
export function SkillsCatalogPage() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const currentUserId = Number(user?.id);
  const { skills, categories, loading, error, reload, toggleFavorite } = useSkillCatalog();
  // Free-text filter over name, description, category and author.
  const [search, setSearch] = useState('');
  // Which slice of the catalog is shown: everything, favourites, recently used, own or shared with me.
  const [view, setView] = useState<CatalogView>('all');
  // Category chip filter; null shows every category.
  const [category, setCategory] = useState<string | null>(null);
  // Agent filter: skills for that agent plus skills for every agent.
  const [agent, setAgent] = useState('all');
  // Skill opened in the detail dialog.
  const [openSkillId, setOpenSkillId] = useState<string | null>(null);
  // Skill being created or edited; null keeps the editor closed.
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  // Whether the import dialog is open.
  const [importing, setImporting] = useState(false);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = skills.filter((skill) => (view !== 'favorites' || skill.isFavorite) && (view !== 'recent' || skill.lastUsedAt)
      && (view !== 'mine' || skill.ownerUserId === currentUserId) && (view !== 'shared' || skill.ownerUserId !== currentUserId)
      && (!category || skill.category === category) && (agent === 'all' || skill.provider === 'all' || skill.provider === agent)
      && (!query || [skill.name, skill.description, skill.category, skill.ownerName ?? ''].join(' ').toLowerCase().includes(query)));
    return view === 'recent' ? [...matches].sort((left, right) => String(right.lastUsedAt).localeCompare(String(left.lastUsedAt))) : matches;
  }, [agent, category, currentUserId, search, skills, view]);

  const openEditor = (skill: CompanySkillSummary | CompanySkill | null, seed?: EditorTarget['seed']) => {
    setOpenSkillId(null); setImporting(false);
    setEditor({ skill: skill && 'content' in skill ? skill : null, seed });
  };

  return <div className="flex h-screen flex-col bg-background text-foreground">
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
      <a href="/" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />{t('skillsCatalog.backToChats')}</a>
      <h1 className="flex-1 text-lg font-semibold">{t('skillsCatalog.title')}</h1>
      <Button type="button" variant="outline" size="sm" onClick={() => setImporting(true)}><Download />{t('skillsCatalog.importButton')}</Button>
      <Button type="button" size="sm" onClick={() => openEditor(null)}><Plus />{t('skillsCatalog.create')}</Button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-56 flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('skillsCatalog.search')} aria-label={t('skillsCatalog.search')} />
          </div>
          <select aria-label={t('skillsCatalog.agentFilter')} value={agent} onChange={(event) => setAgent(event.target.value)} className="h-9 rounded-md border border-input bg-background pl-2 pr-8 text-sm">
            <option value="all">{t('skillsCatalog.allAgents')}</option>
            {Object.entries(SKILL_AGENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </div>
        <PillBar className="max-w-full overflow-x-auto">
          {VIEWS.map((item) => <Pill key={item} isActive={view === item} onClick={() => setView(item)}>{t(`skillsCatalog.views.${item}`)}</Pill>)}
        </PillBar>
        {categories.length > 0 && <div className="flex flex-wrap gap-1.5">
          {[null, ...categories].map((item) => <button key={item ?? 'all'} type="button" onClick={() => setCategory(item)}
            className={cn('rounded-full border px-3 py-1 text-xs', category === item ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-accent')}>
            {item ?? t('skillsCatalog.allCategories')}</button>)}
        </div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!visible.length && !loading && <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          <p>{skills.length ? t('skillsCatalog.nothingFound') : t('skillsCatalog.empty')}</p>
          {!skills.length && <div className="mt-4 flex justify-center gap-2">
            <Button type="button" size="sm" onClick={() => openEditor(null)}>{t('skillsCatalog.create')}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setImporting(true)}>{t('skillsCatalog.importButton')}</Button>
          </div>}
        </div>}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((skill) => <SkillCard key={skill.id} skill={skill} onOpen={() => setOpenSkillId(skill.id)} onToggleFavorite={() => void toggleFavorite(skill)} />)}
        </div>
      </div>
    </div>
    {openSkillId && <SkillDetailDialog skillId={openSkillId} onClose={() => setOpenSkillId(null)} onEdit={(skill) => openEditor(skill)}
      onToggleFavorite={(skill) => toggleFavorite(skill)} onChanged={() => void reload()} />}
    {editor && <SkillEditorDialog skill={editor.skill} seed={editor.seed} categories={categories} onClose={() => setEditor(null)}
      onSaved={(skill) => { setEditor(null); void reload(); setOpenSkillId(skill.id); }} />}
    {importing && <SkillImportDialog onClose={() => setImporting(false)} onImported={() => void reload()} onUpload={(seed) => openEditor(null, seed)} />}
  </div>;
}
