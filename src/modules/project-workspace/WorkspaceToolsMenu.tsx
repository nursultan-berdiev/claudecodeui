import { Terminal, Folder, ClipboardCheck, MonitorPlay, MoreHorizontal, type LucideIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { ActionMenu, type ActionMenuItem } from '@/shared/ui';
import type { AppTab } from '@/shared/types';
import { usePlugins, PluginIcon } from '@/modules/plugins';
import { useAuth } from '@/modules/auth';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import { isWorkspaceTabVisible } from '@/shared/utils';

type WorkspaceToolsMenuProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
};

type BuiltInTool = {
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

const BASE_TOOLS: BuiltInTool[] = [
  { id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { id: 'files', labelKey: 'tabs.files', icon: Folder },
];

const BROWSER_TOOL: BuiltInTool = { id: 'browser', labelKey: 'tabs.browser', icon: MonitorPlay };

const TASKS_TOOL: BuiltInTool = { id: 'tasks', labelKey: 'tabs.tasks', icon: ClipboardCheck };

/**
 * Rendered by WorkspaceHeader as the "…" menu that opens the workspace views
 * beside the chat (terminal, files, browser, tasks, plugins). Renders nothing
 * when the user can see none of them.
 */
export default function WorkspaceToolsMenu({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
}: WorkspaceToolsMenuProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const { user } = useAuth();
  const preferences = useUiPreferences();

  const builtInTools: BuiltInTool[] = [
    ...BASE_TOOLS.filter((tool) => isWorkspaceTabVisible(tool.id, preferences, user?.role === 'admin')),
    ...(shouldShowBrowserTab ? [BROWSER_TOOL] : []),
    ...(shouldShowTasksTab ? [TASKS_TOOL] : []),
  ];

  const items: ActionMenuItem[] = [
    ...builtInTools.map((tool) => ({
      key: tool.id,
      label: t(tool.labelKey),
      icon: tool.icon,
      checked: tool.id === activeTab,
      onSelect: () => setActiveTab(tool.id),
    })),
    ...plugins
      .filter((plugin) => plugin.enabled)
      .map((plugin, index) => {
        const id = `plugin:${plugin.name}` as AppTab;
        return {
          key: id,
          label: plugin.displayName,
          iconNode: (
            <PluginIcon
              pluginName={plugin.name}
              iconFile={plugin.icon}
              className="flex h-4 w-4 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
            />
          ),
          checked: id === activeTab,
          showDividerBefore: index === 0 && builtInTools.length > 0,
          onSelect: () => setActiveTab(id),
        };
      }),
  ];

  if (items.length === 0) {
    return null;
  }

  const label = t('tabs.views', { defaultValue: 'Workspace views' });

  return (
    <ActionMenu
      label={label}
      ariaLabel={label}
      icon={MoreHorizontal}
      iconOnly
      variant="ghost"
      triggerClassName="h-9 w-9 rounded-full p-0 text-muted-foreground hover:text-foreground"
      menuClassName="w-56 rounded-xl p-1.5 shadow-lg"
      items={items}
    />
  );
}
