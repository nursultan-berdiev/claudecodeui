import { Settings, AlertTriangle, BookOpen, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { TFunction } from 'i18next';

import { useAuth } from '@/modules/auth';
import { ActionMenu, type ActionMenuItem } from '@/shared/ui';
import { IS_PLATFORM } from '@/shared/utils';

type SidebarFooterProps = {
  restartRequired: boolean;
  onShowSettings: () => void;
  t: TFunction;
};

/**
 * Rendered by SidebarContent at the bottom of the panel: the signed-in user,
 * whose menu holds skills, settings and logout. Server update notices concern
 * whoever runs the server, so only administrators see them.
 */
export default function SidebarFooter({
  restartRequired,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';
  const username = typeof user?.username === 'string' ? user.username : '';
  const accountLabel = username || t('actions.settings');

  const menuItems: ActionMenuItem[] = [
    {
      key: 'skills',
      label: t('company.skillsTitle', { ns: 'settings' }),
      icon: BookOpen,
      onSelect: () => navigate('/skills'),
    },
    { key: 'settings', label: t('actions.settings'), icon: Settings, onSelect: onShowSettings },
    ...(!IS_PLATFORM
      ? [{ key: 'logout', label: t('common:navigation.logout'), icon: LogOut, showDividerBefore: true, onSelect: logout }]
      : []),
  ];

  return (
    <div className="flex-shrink-0 px-2 pb-2 pt-1" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom, 0px))' }}>
      {/* The running server differs from the installed version (updated but not restarted). */}
      {isAdmin && restartRequired && (
        <div className="mb-1 flex items-center gap-2.5 rounded-lg border border-amber-300/60 bg-amber-50/80 px-2.5 py-2 dark:border-amber-700/40 dark:bg-amber-900/15">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 text-amber-500 dark:text-amber-400" />
          <span className="min-w-0 flex-1 text-xs font-medium text-amber-700 dark:text-amber-300">
            {t('version.restartRequired')}
          </span>
        </div>
      )}

      <ActionMenu
        label={accountLabel}
        ariaLabel={accountLabel}
        variant="ghost"
        align="left"
        className="flex w-full"
        triggerClassName="h-auto w-full justify-start gap-2.5 rounded-lg px-2 py-2 font-normal hover:bg-accent"
        menuClassName="bottom-full top-auto mb-2 mt-0 w-full min-w-0 rounded-xl p-1.5 shadow-lg"
        triggerContent={(
          <>
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold uppercase text-primary-foreground">
              {(username || '?').slice(0, 1)}
            </span>
            <span className="min-w-0 truncate text-sm text-foreground">{accountLabel}</span>
          </>
        )}
        items={menuItems}
      />
    </div>
  );
}
