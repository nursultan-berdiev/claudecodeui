import { useTranslation } from 'react-i18next';
import { BookOpen, Pin, X } from 'lucide-react';

import { PromptInputHeader } from '@/modules/chat/composer/PromptInput';
import { useComposerSkillSelection } from '@/modules/chat/hooks/useComposerSkillSelection';

/** Rendered by chat's ChatComposer above the textarea to show the skill for the next message and the skills pinned to the chat. */
export default function ComposerSkillChips({ scope }: { scope: string | null }) {
  const { t } = useTranslation('chat');
  const { oneTime, pinned, chooseOnce, togglePin } = useComposerSkillSelection(scope);
  if (!oneTime && !pinned.length) return null;
  const chip = 'inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 pl-2.5 pr-1 text-xs';
  const iconButton = 'rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground';
  return <PromptInputHeader>
    <div className="flex flex-wrap gap-1.5">
      {oneTime && <span className={chip}>
        <BookOpen className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate font-medium">{oneTime.name}</span>
        <span className="text-muted-foreground">· {t('composer.skills.oneMessage')}</span>
        <button type="button" className={iconButton} aria-label={t('composer.skills.pin')} title={t('composer.skills.pin')} onClick={() => togglePin(oneTime)}><Pin className="h-3 w-3" /></button>
        <button type="button" className={iconButton} aria-label={t('composer.skills.remove')} title={t('composer.skills.remove')} onClick={() => chooseOnce(null)}><X className="h-3 w-3" /></button>
      </span>}
      {pinned.map((skill) => <span key={skill.id} className={chip}>
        <Pin className="h-3 w-3 shrink-0 fill-current" aria-hidden />
        <span className="truncate font-medium">{skill.name}</span>
        <button type="button" className={iconButton} aria-label={t('composer.skills.unpin')} title={t('composer.skills.unpin')} onClick={() => togglePin(skill)}><X className="h-3 w-3" /></button>
      </span>)}
    </div>
  </PromptInputHeader>;
}
