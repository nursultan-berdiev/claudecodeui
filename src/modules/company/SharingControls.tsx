import { useTranslation } from 'react-i18next';
import type { CompanyDepartment, ResourceVisibility } from '@/shared/types';

type SharingControlsProps = {
  visibility: ResourceVisibility; departmentIds: number[]; departments: CompanyDepartment[];
  disabled?: boolean; onChange(value: { visibility: ResourceVisibility; departmentIds: number[] }): void;
};

/** Used by ChatSharing for the private/department/company access choices of a chat. */
export function SharingControls({ visibility, departmentIds, departments, disabled, onChange }: SharingControlsProps) {
  const { t } = useTranslation('settings');
  return <div className="space-y-3">
    <label className="block text-sm font-medium">{t('company.access')}
      <select aria-label={t('company.access')} disabled={disabled} value={visibility}
        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2"
        onChange={(event) => onChange({ visibility: event.target.value as ResourceVisibility, departmentIds })}>
        <option value="private">{t('company.private')}</option>
        <option value="departments">{t('company.departments')}</option>
        <option value="company">{t('company.everyone')}</option>
      </select>
    </label>
    {visibility === 'departments' && <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 text-sm">{t('company.selectDepartments')}</legend>
      {!departments.length && <p className="text-sm text-muted-foreground">{t('company.noDepartments')}</p>}
      {departments.map((department) => <label key={department.id} className="flex items-center gap-2 text-sm">
        <input type="checkbox" disabled={disabled} checked={departmentIds.includes(department.id)}
          onChange={(event) => onChange({ visibility, departmentIds: event.target.checked
            ? [...departmentIds, department.id] : departmentIds.filter((id) => id !== department.id) })} />
        {department.name}
      </label>)}
    </fieldset>}
  </div>;
}
