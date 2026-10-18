import { readFileSync } from 'node:fs';

/**
 * Instructions every agent run receives on top of its provider's own, read from
 * the file named by CLOUDCLI_AGENT_INSTRUCTIONS_FILE. The Docker image ships one
 * that describes the document tools it installs.
 */
export function readAgentInstructions(): string | undefined {
  const file = process.env.CLOUDCLI_AGENT_INSTRUCTIONS_FILE;
  if (!file) return undefined;
  try {
    return readFileSync(file, 'utf8').trim() || undefined;
  } catch (error) {
    console.warn(`[agent-instructions] Cannot read ${file}:`, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}
