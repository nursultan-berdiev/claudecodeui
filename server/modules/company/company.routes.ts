import express from 'express';

import type { ProviderAuthStatus, ProviderSkill } from '@/shared/types.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

import { companyService } from './company.service.js';
import { skillHelperService } from './skill-helper.service.js';
import { skillImportService } from './skill-import.service.js';
import { companySkillsService } from './skills-library.service.js';

const bodyRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Used by the server entrypoint to mount authenticated department, chat-sharing and skill-library operations. */
export function createCompanyRouter(options: {
  discoverSkills(provider: string): Promise<ProviderSkill[]>;
  providerAuthStatus(provider: string): Promise<ProviderAuthStatus>;
  onAccessChanged(): void;
}): express.Router {
  const router = express.Router();
  router.get('/departments', asyncHandler(async (_req, res) => { res.json(companyService.listDepartments()); }));
  router.post('/departments', asyncHandler(async (req, res) => {
    const result = companyService.createDepartment(bodyRecord(req.body)); options.onAccessChanged(); res.status(201).json(result);
  }));
  router.put('/departments/:id', asyncHandler(async (req, res) => {
    const result = companyService.updateDepartment(Number(req.params.id), bodyRecord(req.body)); options.onAccessChanged(); res.json(result);
  }));
  router.delete('/departments/:id', asyncHandler(async (req, res) => {
    const result = companyService.deleteDepartment(Number(req.params.id)); options.onAccessChanged(); res.json(result);
  }));
  router.get('/people', asyncHandler(async (_req, res) => { res.json(companyService.people()); }));
  router.get('/chats/:id/sharing', asyncHandler(async (req, res) => { res.json(companyService.chatSharing(String(req.params.id))); }));
  router.put('/chats/:id/sharing', asyncHandler(async (req, res) => {
    const result = companyService.updateChatSharing(String(req.params.id), bodyRecord(req.body)); options.onAccessChanged(); res.json(result);
  }));

  router.get('/skills', asyncHandler(async (_req, res) => { res.json(companySkillsService.list()); }));
  router.post('/skills', asyncHandler(async (req, res) => {
    const skill = companySkillsService.save(bodyRecord(req.body)); options.onAccessChanged(); res.status(201).json({ skill });
  }));
  router.get('/skills/import/sources', asyncHandler(async (_req, res) => { res.json(await skillImportService.listSources(options.discoverSkills)); }));
  router.get('/skills/import/curated', asyncHandler(async (_req, res) => { res.json(await skillImportService.listCurated()); }));
  router.post('/skills/import', asyncHandler(async (req, res) => {
    const keys = bodyRecord(req.body).keys;
    if (!Array.isArray(keys) || !keys.length || keys.length > 50 || keys.some((key) => typeof key !== 'string')) {
      throw new AppError('Select between 1 and 50 skills to import', { code: 'INVALID_IMPORT_KEYS', statusCode: 400 });
    }
    const result = await skillImportService.importSelected(keys as string[], options.discoverSkills); options.onAccessChanged(); res.json(result);
  }));
  router.post('/skills/helper', asyncHandler(async (req, res) => {
    const body = bodyRecord(req.body);
    const provider = body.provider === 'claude' || body.provider === 'codex' ? body.provider : null;
    const mode = body.mode === 'draft' || body.mode === 'improve' ? body.mode : null;
    const request = typeof body.request === 'string' ? body.request.trim() : '';
    const current = typeof body.current === 'string' ? body.current : '';
    if (!provider || !mode || request.length > 4000 || current.length > 1024 * 1024 || (mode === 'draft' ? !request : !current.trim())) {
      throw new AppError('Describe the skill or open one to improve', { code: 'INVALID_HELPER_REQUEST', statusCode: 400 });
    }
    // Closing the page cancels the agent run instead of spending the subscription on an unread draft.
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const draft = await skillHelperService.draft({ provider, mode, request, current }, { authStatus: options.providerAuthStatus, signal: controller.signal });
    res.json({ draft });
  }));
  router.get('/skills/:id', asyncHandler(async (req, res) => { res.json({ skill: companySkillsService.get(String(req.params.id)) }); }));
  router.put('/skills/:id', asyncHandler(async (req, res) => {
    const skill = companySkillsService.save(bodyRecord(req.body), String(req.params.id)); options.onAccessChanged(); res.json({ skill });
  }));
  router.delete('/skills/:id', asyncHandler(async (req, res) => {
    const result = companySkillsService.remove(String(req.params.id)); options.onAccessChanged(); res.json(result);
  }));
  router.get('/skills/:id/versions', asyncHandler(async (req, res) => { res.json({ versions: companySkillsService.versions(String(req.params.id)) }); }));
  router.post('/skills/:id/versions/:version/rollback', asyncHandler(async (req, res) => {
    const version = Number(req.params.version);
    if (!Number.isSafeInteger(version) || version < 1) throw new AppError('Invalid skill version', { code: 'INVALID_SKILL_VERSION', statusCode: 400 });
    const skill = companySkillsService.rollback(String(req.params.id), version); options.onAccessChanged(); res.json({ skill });
  }));
  router.put('/skills/:id/favorite', asyncHandler(async (req, res) => {
    res.json(companySkillsService.setFavorite(String(req.params.id), bodyRecord(req.body).favorite === true));
  }));
  router.post('/skills/:id/publish', asyncHandler(async (req, res) => {
    const skill = companySkillsService.publish(String(req.params.id)); options.onAccessChanged(); res.json({ skill });
  }));
  return router;
}
