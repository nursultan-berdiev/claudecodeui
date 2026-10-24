import { companyDb, resourceAccessDb, userDb } from '@/modules/database/index.js';
import type { ResourceVisibility } from '@/shared/types.js';
import { AppError, getAccessActor } from '@/shared/utils.js';

function requireActor() {
  const actor = getAccessActor();
  if (!actor) throw new AppError('Authentication required', { code: 'AUTH_REQUIRED', statusCode: 401 });
  return actor;
}

function requireAdmin(): void {
  if (requireActor().role !== 'admin') throw new AppError('Administrator access required', { code: 'AUTH_ADMIN_REQUIRED', statusCode: 403 });
}

function departmentInput(input: Record<string, unknown>) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!name || name.length > 100 || description.length > 1000) throw new AppError('Invalid department name or description', { code: 'INVALID_DEPARTMENT', statusCode: 400 });
  return { name, description };
}

function validateDepartmentId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) throw new AppError('Invalid department id', { code: 'INVALID_DEPARTMENT_ID', statusCode: 400 });
}

/** Used by Company routes and Skills to validate visibility against current department membership. */
export function validateResourceSharing(input: Record<string, unknown>, ownDepartmentsOnly = false): { visibility: ResourceVisibility; departmentIds: number[] } {
  const actor = requireActor();
  const visibility = input.visibility ?? 'private';
  if (!['private', 'departments', 'company'].includes(String(visibility))) throw new AppError('Invalid visibility', { code: 'INVALID_VISIBILITY', statusCode: 400 });
  const departmentIds = visibility === 'departments' && Array.isArray(input.departmentIds) ? [...new Set(input.departmentIds.map(Number))] : [];
  const departments = companyDb.departments();
  const allowed = ownDepartmentsOnly && actor.role !== 'admin' ? companyDb.ownDepartmentIds(actor.id) : departments.map((row) => row.id);
  if (visibility === 'departments' && (!departmentIds.length || departmentIds.some((id) => !Number.isSafeInteger(id) || !allowed.includes(id)))) {
    throw new AppError('Select departments you are allowed to share with', { code: 'INVALID_DEPARTMENT_SHARES', statusCode: 400 });
  }
  return { visibility: visibility as ResourceVisibility, departmentIds };
}

/** Used by the company transport adapter to manage departments and chat sharing. */
export const companyService = {
  listDepartments() {
    const actor = requireActor();
    return { departments: companyDb.departments().map((row) => actor.role === 'admin' ? row : { ...row, memberIds: [] }),
      ownDepartmentIds: companyDb.ownDepartmentIds(actor.id) };
  },
  createDepartment(input: Record<string, unknown>) {
    requireAdmin();
    const values = departmentInput(input);
    try { return { id: companyDb.createDepartment(values.name, values.description) }; }
    catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new AppError('Department already exists', { code: 'DEPARTMENT_EXISTS', statusCode: 409 });
      throw error;
    }
  },
  updateDepartment(id: number, input: Record<string, unknown>) {
    requireAdmin();
    validateDepartmentId(id);
    if (!companyDb.departments().some((row) => row.id === id)) throw new AppError('Department not found', { code: 'DEPARTMENT_NOT_FOUND', statusCode: 404 });
    const { name, description } = departmentInput(input);
    const memberIds = Array.isArray(input.memberIds) ? [...new Set(input.memberIds.map(Number))] : [];
    const activeUsers = userDb.listUsers().filter((user) => user.is_active === 1).map((user) => Number(user.id));
    if (memberIds.some((userId) => !activeUsers.includes(userId))) throw new AppError('Invalid department members', { code: 'INVALID_MEMBERS', statusCode: 400 });
    try { companyDb.updateDepartment(id, name, description, memberIds); }
    catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new AppError('Department already exists', { code: 'DEPARTMENT_EXISTS', statusCode: 409 });
      throw error;
    }
    return { success: true };
  },
  deleteDepartment(id: number) { requireAdmin(); validateDepartmentId(id); companyDb.deleteDepartment(id); return { success: true }; },
  /** Active colleagues for the "selected people" picker; only ids and logins, no roles or memberships. */
  people() {
    requireActor();
    return { people: userDb.listUsers().filter((user) => user.is_active === 1).map((user) => ({ id: Number(user.id), username: user.username })) };
  },
  chatSharing(sessionId: string) { requireActor(); return resourceAccessDb.sessionSharing(sessionId); },
  updateChatSharing(sessionId: string, input: Record<string, unknown>) {
    const sharing = validateResourceSharing(input, true);
    resourceAccessDb.setSessionSharing(sessionId, sharing.visibility, sharing.departmentIds);
    return resourceAccessDb.sessionSharing(sessionId);
  },
};
