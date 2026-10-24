import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { CompanySkillSummary } from '@/shared/types';
import { getErrorMessage } from '@/shared/utils';

/** Used by the catalog page and the chat composer's skill menu to read the skills the user may use and toggle favourites. */
export function useSkillCatalog({ enabled = true }: { enabled?: boolean } = {}) {
  // Cards the server says this user may read; refreshed after edits and access changes.
  const [skills, setSkills] = useState<CompanySkillSummary[]>([]);
  // Categories already used in the readable library, offered as filters and editor suggestions.
  const [categories, setCategories] = useState<string[]>([]);
  // True while the first load or a refresh is in flight, so empty states are not shown too early.
  const [loading, setLoading] = useState(false);
  // Last load or favourite failure, shown inline instead of an empty catalog.
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await readApiJson<{ skills: CompanySkillSummary[]; categories: string[] }>(await api.company.skills());
      setSkills(result.skills); setCategories(result.categories); setError('');
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const refresh = () => { void reload(); };
    refresh();
    window.addEventListener('company-access-changed', refresh);
    return () => window.removeEventListener('company-access-changed', refresh);
  }, [enabled, reload]);

  const toggleFavorite = useCallback(async (skill: CompanySkillSummary) => {
    const favorite = !skill.isFavorite;
    setSkills((current) => current.map((item) => item.id === skill.id ? { ...item, isFavorite: favorite } : item));
    try { await readApiJson(await api.company.setSkillFavorite(skill.id, favorite)); }
    catch (caught) {
      setSkills((current) => current.map((item) => item.id === skill.id ? { ...item, isFavorite: !favorite } : item));
      setError(getErrorMessage(caught));
    }
  }, []);

  return { skills, categories, loading, error, reload, toggleFavorite };
}
