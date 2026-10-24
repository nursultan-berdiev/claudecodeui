import { useTranslation } from 'react-i18next';

import type { Project } from '@/shared/types';
import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import { NewChatButton } from '@/modules/company';

type WorkspaceStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
  /** Starts a chat from the empty workspace; absent while loading. */
  onNewSession?: (project: Project) => void;
};

/** Rendered by WorkspaceMain instead of the workspace while projects load or when none is selected. */
export default function WorkspaceStateView({ mode, isMobile, onMenuClick, onNewSession }: WorkspaceStateViewProps) {
  const { t } = useTranslation();

  const isLoading = mode === 'loading';

  return (
    <div className="flex h-full flex-col">
      {isMobile && (
        <div className="pwa-header-safe flex-shrink-0 bg-background p-2 sm:p-3">
          <MobileMenuButton onMenuClick={onMenuClick} compact />
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div
                className="h-full w-full rounded-full border-[3px] border-muted border-t-primary"
                style={{
                  animation: 'spin 1s linear infinite',
                  WebkitAnimation: 'spin 1s linear infinite',
                  MozAnimation: 'spin 1s linear infinite',
                }}
              />
            </div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.loading')}</h2>
            <p className="text-sm">{t('mainContent.settingUpWorkspace')}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-md px-6 pb-12 text-center">
            <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-[28px]">
              {t('mainContent.greeting', { defaultValue: 'What can I help with?' })}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('mainContent.startChatHint', { defaultValue: 'Start a new chat or pick one on the left.' })}
            </p>
            {onNewSession && (
              <div className="mx-auto mt-5 w-fit rounded-full border border-border px-2">
                <NewChatButton onOpenChat={onNewSession} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
