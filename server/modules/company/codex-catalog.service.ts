import type { ManagedSkillRecord } from '@/shared/types.js';
import { AppError, MANAGED_SKILL_LIMITS, readProviderSkillMarkdownDefinitionFromContent } from '@/shared/utils.js';

type CuratedSkill = { name: string; description: string; files: { path: string; size: number }[] };
type CatalogSnapshot = { loadedAt: number; commit: string; skills: CuratedSkill[] };

const REPOSITORY = 'openai/skills';
const CURATED_PREFIX = 'skills/.curated/';
const CACHE_TTL_MS = 60 * 60 * 1000;
// After a failed refresh GitHub is left alone for a while, so an outage does not burn the 60 requests/hour on retries.
const RETRY_AFTER_MS = 2 * 60 * 1000;
let snapshot: CatalogSnapshot | null = null;
let failedAt = 0;
// One download serves every request that arrives while it runs, so a burst cannot spend GitHub's 60 requests/hour.
let loading: Promise<CatalogSnapshot> | null = null;

async function fetchGitHub(url: string): Promise<Response> {
  const response = await fetch(url, { headers: { 'User-Agent': 'cloudcli-skills-import' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return response;
}

function rawUrl(commit: string, repoPath: string): string {
  return `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${repoPath.split('/').map(encodeURIComponent).join('/')}`;
}

/** Listing and import read the same commit; when a refresh fails, the last good snapshot keeps serving. */
async function loadSnapshot(): Promise<CatalogSnapshot> {
  const unavailable = () => new AppError('The Codex skills catalog on GitHub is unavailable right now', { code: 'CURATED_UNAVAILABLE', statusCode: 502 });
  if (snapshot && Date.now() - snapshot.loadedAt < CACHE_TTL_MS) return snapshot;
  if (Date.now() - failedAt < RETRY_AFTER_MS) { if (snapshot) return snapshot; throw unavailable(); }
  loading ??= downloadSnapshot().then((loaded) => (snapshot = loaded)).finally(() => { loading = null; });
  try { return await loading; } catch (error) {
    failedAt = Date.now();
    console.warn('Could not refresh the Codex skills catalog', error instanceof Error ? error.message : String(error));
    if (snapshot) return snapshot;
    throw unavailable();
  }
}

async function downloadSnapshot(): Promise<CatalogSnapshot> {
  const { sha: commit } = await (await fetchGitHub(`https://api.github.com/repos/${REPOSITORY}/commits/main`)).json() as { sha: string };
  const tree = await (await fetchGitHub(`https://api.github.com/repos/${REPOSITORY}/git/trees/${commit}?recursive=1`)).json() as { tree?: { path: string; type: string; size?: number }[]; truncated?: boolean };
  if (!commit || tree.truncated) throw new Error('GitHub returned an incomplete catalog tree');
  const filesByName = new Map<string, CuratedSkill['files']>();
  for (const entry of tree.tree ?? []) {
    if (entry.type !== 'blob' || !entry.path.startsWith(CURATED_PREFIX)) continue;
    const [name, ...rest] = entry.path.slice(CURATED_PREFIX.length).split('/');
    if (!/^[\w.-]+$/.test(name) || !rest.length) continue;
    filesByName.set(name, [...filesByName.get(name) ?? [], { path: entry.path, size: entry.size ?? 0 }]);
  }
  const names = [...filesByName.keys()].filter((name) => filesByName.get(name)!.some((file) => file.path === `${CURATED_PREFIX}${name}/SKILL.md`)).sort();
  const skills: CuratedSkill[] = [];
  for (let index = 0; index < names.length; index += 6) {
    // Descriptions come from raw files, which GitHub does not rate-limit like its API; a failed one fails the load so it is not cached.
    skills.push(...await Promise.all(names.slice(index, index + 6).map(async (name) => {
      const content = await (await fetchGitHub(rawUrl(commit, `${CURATED_PREFIX}${name}/SKILL.md`))).text();
      let description = '';
      try { description = readProviderSkillMarkdownDefinitionFromContent(content, name).description; } catch { /* listed by name only */ }
      return { name, description, files: filesByName.get(name)! };
    })));
  }
  return { loadedAt: Date.now(), commit, skills };
}

/** Used by the skill import service for the curated Codex catalog (github.com/openai/skills, skills/.curated). */
export const codexCatalogService = {
  async list(): Promise<{ name: string; description: string }[]> {
    return (await loadSnapshot()).skills.map(({ name, description }) => ({ name, description }));
  },
  /** Downloads one catalog skill; sizes come from the tree, so an oversized skill is refused before anything is fetched. */
  async read(name: string): Promise<{ content: string; files: ManagedSkillRecord['files'] }> {
    const catalog = await loadSnapshot();
    const skill = catalog.skills.find((item) => item.name === name);
    if (!skill) throw new AppError('Skill not found in the Codex catalog', { code: 'IMPORT_SOURCE_NOT_FOUND', statusCode: 404 });
    if (skill.files.length > MANAGED_SKILL_LIMITS.files + 1 || skill.files.reduce((sum, file) => sum + file.size, 0) > MANAGED_SKILL_LIMITS.fileBytes + MANAGED_SKILL_LIMITS.markdownBytes) {
      throw new AppError('Skill import limit exceeded', { code: 'SKILL_TOO_LARGE', statusCode: 400 });
    }
    const prefix = `${CURATED_PREFIX}${skill.name}/`;
    const folder: { content: string; files: ManagedSkillRecord['files'] } = { content: '', files: [] };
    for (const file of skill.files) {
      const buffer = Buffer.from(await (await fetchGitHub(rawUrl(catalog.commit, file.path))).arrayBuffer());
      const relativePath = file.path.slice(prefix.length);
      if (relativePath === 'SKILL.md') folder.content = buffer.toString('utf8');
      else folder.files.push({ relativePath, content: buffer.toString('base64'), encoding: 'base64' });
    }
    return folder;
  },
};
