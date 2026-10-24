import express from 'express';
import type { ProviderSkill } from '@/shared/types.js';
import { asyncHandler } from '@/shared/utils.js';
import { companyService } from './company.service.js';
import { companySkillsService } from './skills-library.service.js';

const bodyRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Used by the server entrypoint to mount authenticated department, chat-sharing and skill-library operations. */
export function createCompanyRouter(options: {
  discoverSkills(provider: string): Promise<ProviderSkill[]>;
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
  router.get('/chats/:id/sharing', asyncHandler(async (req, res) => { res.json(companyService.chatSharing(String(req.params.id))); }));
  router.put('/chats/:id/sharing', asyncHandler(async (req, res) => {
    const result = companyService.updateChatSharing(String(req.params.id), bodyRecord(req.body)); options.onAccessChanged(); res.json(result);
  }));
  router.get('/skills', asyncHandler(async (_req, res) => {
    for (const provider of ['claude', 'codex', 'cursor', 'opencode']) {
      await companySkillsService.importDiscovered(provider, await options.discoverSkills(provider));
    }
    res.json({ skills: companySkillsService.list() });
  }));
  router.get('/skills/:id', asyncHandler(async (req, res) => { res.json({ skill: companySkillsService.get(String(req.params.id)) }); }));
  router.post('/skills', asyncHandler(async (req, res) => {
    const skill = companySkillsService.save(bodyRecord(req.body)); options.onAccessChanged(); res.status(201).json({ skill });
  }));
  router.put('/skills/:id', asyncHandler(async (req, res) => {
    const skill = companySkillsService.save(bodyRecord(req.body), String(req.params.id)); options.onAccessChanged(); res.json({ skill });
  }));
  router.delete('/skills/:id', asyncHandler(async (req, res) => {
    const result = companySkillsService.remove(String(req.params.id)); options.onAccessChanged(); res.json(result);
  }));
  return router;
}
