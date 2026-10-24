import { createContext, useContext } from 'react';

import type { TranscriptRevealRequest } from '@/shared/types';

/**
 * The last request (a search hit, a background-task chip) to bring a row into
 * view. A collapsed tool group that holds the row opens itself, because a row
 * inside a closed group has nothing on screen to scroll to.
 */
export const TranscriptRevealContext = createContext<TranscriptRevealRequest | null>(null);

/** The transcript's latest reveal request, or null. */
export function useRevealRequest(): TranscriptRevealRequest | null {
  return useContext(TranscriptRevealContext);
}
