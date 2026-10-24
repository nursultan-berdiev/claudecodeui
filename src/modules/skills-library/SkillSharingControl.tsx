import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CompanyDepartment, CompanyPerson, SkillVisibility } from '@/shared/types';
import { Input } from '@/shared/ui';
import { cn } from '@/shared/utils';

type SkillSharing = { visibility: SkillVisibility; departmentIds: number[]; userIds: number[] };
type SkillSharingControlProps = SkillSharing & {
  departments: CompanyDepartment[];
  ownDepartmentIds: number[];
  people: CompanyPerson[];
  currentUserId: number;
  isAdmin: boolean;
  /** An owner may keep an already published skill company-wide, but only an administrator publishes. */
  canKeepCompany: boolean;
  onChange(value: SkillSharing): void;
};

const LEVELS: SkillVisibility[] = ['private', 'users', 'departments', 'company'];

/** Used by the skill editor for the four access levels: only me, selected people, departments, whole company. */
export function SkillSharingControl({ visibility, departmentIds, userIds, departments, ownDepartmentIds, people, currentUserId, isAdmin, canKeepCompany, onChange }: SkillSharingControlProps) {
  const { t } = useTranslation('settings');
  // Narrows the colleague list; long companies would otherwise make the picker unusable.
  const [personQuery, setPersonQuery] = useState('');
  const allowedDepartments = isAdmin ? departments : departments.filter((department) => ownDepartmentIds.includes(department.id));
  const colleagues = people.filter((person) => person.id !== currentUserId && person.username.toLowerCase().includes(personQuery.trim().toLowerCase()));
  const toggle = (list: number[], id: number, checked: boolean) => checked ? [...list, id] : list.filter((item) => item !== id);

  return <fieldset className="space-y-3">
    <legend className="mb-2 text-sm font-medium">{t('skillsCatalog.access')}</legend>
    <div className="grid gap-2 sm:grid-cols-2">
      {LEVELS.map((level) => {
        const locked = level === 'company' && !isAdmin && !canKeepCompany;
        return <label key={level} className={cn('flex cursor-pointer gap-2 rounded-lg border p-3 text-sm', visibility === level ? 'border-primary bg-primary/5' : 'border-border', locked && 'cursor-not-allowed opacity-60')}>
          <input type="radio" name="skill-visibility" className="mt-0.5" checked={visibility === level} disabled={locked}
            onChange={() => onChange({ visibility: level, departmentIds, userIds })} />
          <span><span className="block font-medium">{t(`skillsCatalog.visibility.${level}`)}</span>
            <span className="block text-xs text-muted-foreground">{locked ? t('skillsCatalog.companyAdminOnly') : t(`skillsCatalog.visibilityHint.${level}`)}</span></span>
        </label>;
      })}
    </div>
    {visibility === 'departments' && <div className="space-y-1 rounded-lg border border-border p-3">
      {!allowedDepartments.length && <p className="text-sm text-muted-foreground">{t('skillsCatalog.noOwnDepartments')}</p>}
      {allowedDepartments.map((department) => <label key={department.id} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={departmentIds.includes(department.id)}
          onChange={(event) => onChange({ visibility, userIds, departmentIds: toggle(departmentIds, department.id, event.target.checked) })} />
        {department.name}
      </label>)}
    </div>}
    {visibility === 'users' && <div className="space-y-2 rounded-lg border border-border p-3">
      <Input value={personQuery} onChange={(event) => setPersonQuery(event.target.value)} placeholder={t('skillsCatalog.searchPeople')} aria-label={t('skillsCatalog.searchPeople')} />
      <div className="max-h-48 space-y-1 overflow-y-auto">
        {!colleagues.length && <p className="text-sm text-muted-foreground">{t('skillsCatalog.noPeople')}</p>}
        {colleagues.map((person) => <label key={person.id} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={userIds.includes(person.id)}
            onChange={(event) => onChange({ visibility, departmentIds, userIds: toggle(userIds, person.id, event.target.checked) })} />
          {person.username}
        </label>)}
      </div>
      {userIds.length > 0 && <p className="text-xs text-muted-foreground">{t('skillsCatalog.selectedPeople', { count: userIds.length })}</p>}
    </div>}
  </fieldset>;
}
