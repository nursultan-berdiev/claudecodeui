import type { CompanySkillFile } from '@/shared/types';

const MAX_FILES = 500;
const MAX_BYTES = 30 * 1024 * 1024;

/** Used by the editor to replace a binary supporting file and by uploads to carry any file losslessly. */
export async function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Used by the editor: text files arrive as base64 from imports and become editable UTF-8; real binaries stay base64. */
export function editableFiles(files: CompanySkillFile[]): CompanySkillFile[] {
  return files.map((file) => {
    if (file.encoding !== 'base64') return { ...file };
    try {
      const bytes = Uint8Array.from(atob(file.content), (letter) => letter.charCodeAt(0));
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return content.includes('\0') ? { ...file } : { ...file, content, encoding: 'utf8' as const };
    } catch { return { ...file }; }
  });
}

/** A rejected upload; `code` is `importTooLarge` or `skillFileRequired`, which the import dialog translates. */
function uploadError(code: 'importTooLarge' | 'skillFileRequired'): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** Used by the import dialog for a single SKILL.md or a whole skill folder chosen in the browser. */
export async function readSkillUpload(files: File[]): Promise<{ content: string; files: CompanySkillFile[] }> {
  if (files.length > MAX_FILES || files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) throw uploadError('importTooLarge');
  const definition = files.find((file) => file.name.toLowerCase() === 'skill.md') ?? (files.length === 1 ? files[0] : undefined);
  if (!definition) throw uploadError('skillFileRequired');
  const root = definition.webkitRelativePath ? definition.webkitRelativePath.slice(0, -definition.name.length) : '';
  const supporting: CompanySkillFile[] = [];
  for (const file of files) {
    if (file === definition) continue;
    const relative = file.webkitRelativePath || file.name;
    if (root && !relative.startsWith(root)) continue;
    supporting.push({ relativePath: root ? relative.slice(root.length) : relative, content: await fileBase64(file), encoding: 'base64' });
  }
  return { content: await definition.text(), files: editableFiles(supporting) };
}

/**
 * Used by the files editor before adding an attachment; mirrors validateFiles on the server.
 * Returns why the path cannot be added (`reserved` for SKILL.md, `invalid` for absolute or `..` paths,
 * `clash` when it equals another file ignoring case or is a folder of one), or null when it is fine.
 */
export function attachedFileProblem(relativePath: string, files: CompanySkillFile[]): 'reserved' | 'invalid' | 'clash' | null {
  const lowered = relativePath.toLowerCase();
  if (lowered === 'skill.md') return 'reserved';
  if (relativePath.startsWith('/') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) return 'invalid';
  return files.some((file) => {
    const other = file.relativePath.toLowerCase();
    return other === lowered || other.startsWith(`${lowered}/`) || lowered.startsWith(`${other}/`);
  }) ? 'clash' : null;
}
