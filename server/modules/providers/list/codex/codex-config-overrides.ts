import type { CodexOptions } from '@openai/codex-sdk';

export type CodexConfig = NonNullable<CodexOptions['config']>;

/**
 * One config value as an inline TOML literal. Keys are always quoted, so file
 * paths and names with dots or colons stay whole; values TOML cannot hold
 * (null, undefined, bigint, NaN) are refused rather than written wrong.
 */
function toTomlInline(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(toTomlInline).join(', ')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => `${JSON.stringify(key)} = ${toTomlInline(child)}`);
    return `{${entries.join(', ')}}`;
  }
  throw new TypeError(`Cannot write ${String(value)} (${typeof value}) as a Codex config value`);
}

/**
 * Codex config as raw `--config` overrides, one per top-level key. Exec needs
 * this form: the SDK's own `config` flattens nested keys into dotted paths,
 * which splits file paths used as keys (Plan's permissions profile).
 */
export function toCodexConfigOverrides(config: CodexConfig): string[] {
  return Object.entries(config).map(([key, value]) => `${key}=${toTomlInline(value)}`);
}
