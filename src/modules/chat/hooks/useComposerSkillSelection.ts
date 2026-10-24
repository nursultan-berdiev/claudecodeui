import { useCallback, useSyncExternalStore } from 'react';

type ComposerSkill = { id: string; name: string };
type ComposerSkillSelection = { oneTime: ComposerSkill | null; pinned: ComposerSkill[] };

// Pins survive reloads per chat like permissionMode-${sessionId}; the one-message choice lives only in memory.
const PINNED_KEY_PREFIX = 'composerSkills-pinned-';
const MAX_PINNED = 3;
const EMPTY_SELECTION: ComposerSkillSelection = { oneTime: null, pinned: [] };
const oneTimeByScope = new Map<string, ComposerSkill>();
const snapshots = new Map<string, ComposerSkillSelection>();
const listeners = new Set<() => void>();

function readPinned(scope: string): ComposerSkill[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${PINNED_KEY_PREFIX}${scope}`) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is ComposerSkill => typeof item?.id === 'string' && typeof item?.name === 'string') : [];
  } catch { return []; }
}

function writePinned(scope: string, pinned: ComposerSkill[]): void {
  if (pinned.length) localStorage.setItem(`${PINNED_KEY_PREFIX}${scope}`, JSON.stringify(pinned));
  else localStorage.removeItem(`${PINNED_KEY_PREFIX}${scope}`);
}

function emit(): void {
  snapshots.clear();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Cached per scope until the next change, so useSyncExternalStore sees a stable snapshot.
function snapshot(scope: string | null): ComposerSkillSelection {
  if (!scope) return EMPTY_SELECTION;
  let cached = snapshots.get(scope);
  if (!cached) {
    cached = { oneTime: oneTimeByScope.get(scope) ?? null, pinned: readPinned(scope) };
    snapshots.set(scope, cached);
  }
  return cached;
}

/** Used by useChatComposerState to send the one-message skill and the pinned skills of a chat with the next message. */
export function readComposerSkillIds(scope: string | null): string[] {
  const { oneTime, pinned } = snapshot(scope);
  return [...new Set([...(oneTime ? [oneTime.id] : []), ...pinned.map((skill) => skill.id)])];
}

/** Used by useChatComposerState after a send: drops the one-message skill and moves a new chat's pins to its session. */
export function completeComposerSkillSend(scope: string | null, sessionId: string | null): void {
  if (!scope) return;
  oneTimeByScope.delete(scope);
  if (sessionId && sessionId !== scope && scope.startsWith('project:')) {
    const pinned = readPinned(scope);
    if (pinned.length) { writePinned(sessionId, pinned); writePinned(scope, []); }
  }
  emit();
}

/** Used by the composer skill menu and chips to read and change the skills chosen for the open chat. */
export function useComposerSkillSelection(scope: string | null) {
  const selection = useSyncExternalStore(subscribe, () => snapshot(scope));
  const chooseOnce = useCallback((skill: ComposerSkill | null) => {
    if (!scope) return;
    if (skill) oneTimeByScope.set(scope, { id: skill.id, name: skill.name }); else oneTimeByScope.delete(scope);
    emit();
  }, [scope]);
  const togglePin = useCallback((skill: ComposerSkill) => {
    if (!scope) return;
    const pinned = readPinned(scope);
    writePinned(scope, pinned.some((item) => item.id === skill.id) ? pinned.filter((item) => item.id !== skill.id)
      : [...pinned, { id: skill.id, name: skill.name }].slice(-MAX_PINNED));
    // A pinned skill already applies to every message, so it no longer needs the one-message slot.
    if (oneTimeByScope.get(scope)?.id === skill.id) oneTimeByScope.delete(scope);
    emit();
  }, [scope]);
  return { ...selection, chooseOnce, togglePin };
}
