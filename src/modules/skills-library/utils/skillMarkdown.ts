/** The parts of SKILL.md the catalog form edits; `extraFrontmatter` keeps every other frontmatter line verbatim. */
export type SkillMarkdownParts = { name: string; description: string; body: string; extraFrontmatter: string[] };

const BLOCK_SCALAR = /^[|>][+-]?$/;

function decodeScalar(firstValue: string, continuation: string[]): string {
  const value = firstValue.trim();
  if (BLOCK_SCALAR.test(value)) {
    const lines = continuation.map((line) => line.trim());
    return (value.startsWith('|') ? lines.join('\n') : lines.join(' ')).trim();
  }
  const joined = [value, ...continuation.map((line) => line.trim())].join(' ').trim();
  if (joined.startsWith('"')) {
    try { return JSON.parse(joined) as string; } catch { return joined.replace(/^"|"$/g, ''); }
  }
  if (joined.startsWith("'")) return joined.replace(/^'|'$/g, '').replace(/''/g, "'");
  return joined;
}

/** Plain YAML when the value cannot be misread, a JSON (= YAML double-quoted) string otherwise. */
function encodeScalar(value: string): string {
  const plain = /^[^\s\-?:,[\]{}#&*!|>'"%@`][^\n]*$/.test(value) && !value.includes(': ') && !value.includes(' #') && !/[:\s]$/.test(value);
  return plain ? value : JSON.stringify(value);
}

/** Used by the catalog editor and helper to split SKILL.md into form fields without losing unknown frontmatter. */
export function parseSkillMarkdown(content: string): SkillMarkdownParts {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const end = lines[0] === '---' ? lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...')) : -1;
  if (end < 0) return { name: '', description: '', body: normalized, extraFrontmatter: [] };
  const parts: SkillMarkdownParts = { name: '', description: '', body: lines.slice(end + 1).join('\n').replace(/^\n/, ''), extraFrontmatter: [] };
  let index = 1;
  while (index < end) {
    const match = lines[index].match(/^([A-Za-z_][\w-]*):(.*)$/);
    const key = match?.[1];
    const continuation: string[] = [];
    let next = index + 1;
    while (next < end && (/^\s/.test(lines[next]) || lines[next] === '')) continuation.push(lines[next++]);
    if (match && (key === 'name' || key === 'description')) parts[key] = decodeScalar(match[2], continuation);
    else parts.extraFrontmatter.push(lines[index], ...continuation);
    index = next;
  }
  return parts;
}

/** Used by the catalog editor and helper to write form fields back as SKILL.md. */
export function composeSkillMarkdown(parts: SkillMarkdownParts): string {
  const frontmatter = [`name: ${encodeScalar(parts.name)}`, `description: ${encodeScalar(parts.description)}`, ...parts.extraFrontmatter];
  return `---\n${frontmatter.join('\n')}\n---\n\n${parts.body.replace(/^\n+/, '')}`;
}

/** Used by the catalog editor: a skill name is its command, so spaces become hyphens and only letters, digits, dots and hyphens stay. */
export function toSkillName(value: string): string {
  return value.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}.-]/gu, '').replace(/-+/g, '-').slice(0, 100);
}
