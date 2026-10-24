import { useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useProviderAuthStatus } from '@/modules/provider-auth';
import { api, readApiJson } from '@/shared/api';
import { SKILL_AGENT_LABELS } from '@/shared/constants';
import type { SkillHelperDraft } from '@/shared/types';
import { Button } from '@/shared/ui';
import { getErrorMessage } from '@/shared/utils';

type HelperProvider = 'claude' | 'codex';

const HELPER_PROVIDERS: HelperProvider[] = ['claude', 'codex'];

/** Used by the skill editor to draft a new skill from a description or to improve the open one through a signed-in agent. */
export function SkillHelperPanel({ canImprove, currentContent, onDraft }: { canImprove: boolean; currentContent: string; onDraft(draft: SkillHelperDraft): void }) {
  const { t } = useTranslation('settings');
  const { providerAuthStatus, refreshProviderAuthStatuses } = useProviderAuthStatus();
  // The employee's own words for what the skill should do; the helper never sees anything else from the form.
  const [request, setRequest] = useState('');
  // Agent picked by the employee; falls back to the first signed-in one.
  const [provider, setProvider] = useState<HelperProvider | null>(null);
  // Aborts the running draft and marks the panel busy while it is set.
  const [controller, setController] = useState<AbortController | null>(null);
  // Failure of the last run, shown under the buttons.
  const [error, setError] = useState('');

  useEffect(() => { void refreshProviderAuthStatuses(HELPER_PROVIDERS); }, [refreshProviderAuthStatuses]);
  const ready = HELPER_PROVIDERS.filter((item) => providerAuthStatus[item].authenticated);
  const selected = provider && ready.includes(provider) ? provider : ready[0] ?? null;
  const checking = HELPER_PROVIDERS.some((item) => providerAuthStatus[item].loading);

  const run = async (mode: 'draft' | 'improve') => {
    if (!selected) return;
    const abort = new AbortController();
    setController(abort); setError('');
    try {
      const result = await readApiJson<{ draft: SkillHelperDraft }>(await api.company.skillHelper(
        { provider: selected, mode, request: request.trim(), current: mode === 'improve' ? currentContent : '' }, abort.signal));
      onDraft(result.draft);
    } catch (caught) {
      if (!abort.signal.aborted) setError(getErrorMessage(caught));
    } finally { setController(null); }
  };

  return <section className="space-y-2 rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3" aria-label={t('skillsCatalog.helper.title')}>
    <h3 className="flex items-center gap-1.5 text-sm font-medium"><Sparkles className="h-4 w-4 text-primary" />{t('skillsCatalog.helper.title')}</h3>
    <textarea value={request} onChange={(event) => setRequest(event.target.value)} rows={3} maxLength={4000}
      aria-label={t('skillsCatalog.helper.request')} placeholder={t('skillsCatalog.helper.placeholder')}
      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
    <div className="flex flex-wrap items-center gap-2">
      {ready.length > 1 && <select aria-label={t('skillsCatalog.helper.agent')} value={selected ?? ''} onChange={(event) => setProvider(event.target.value as HelperProvider)}
        className="h-9 rounded-md border border-input bg-background pl-2 pr-8 text-sm">
        {ready.map((item) => <option key={item} value={item}>{SKILL_AGENT_LABELS[item]}</option>)}
      </select>}
      {ready.length === 1 && <span className="text-sm text-muted-foreground">{SKILL_AGENT_LABELS[ready[0]]}</span>}
      <Button type="button" size="sm" disabled={!selected || !request.trim() || Boolean(controller)} onClick={() => void run('draft')}>{t('skillsCatalog.helper.draft')}</Button>
      <Button type="button" size="sm" variant="outline" disabled={!selected || !canImprove || Boolean(controller)} onClick={() => void run('improve')}>{t('skillsCatalog.helper.improve')}</Button>
      {controller && <Button type="button" size="sm" variant="ghost" onClick={() => controller.abort()}>{t('skillsCatalog.helper.cancel')}</Button>}
    </div>
    {!checking && !ready.length && <p className="text-xs text-muted-foreground">{t('skillsCatalog.helper.noAgent')}</p>}
    <p className="text-xs text-muted-foreground">{t('skillsCatalog.helper.cost')}</p>
    {controller && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('skillsCatalog.helper.working')}</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>;
}
