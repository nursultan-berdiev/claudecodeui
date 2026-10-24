import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';

type ManagedAccount = {
  id: number;
  username: string;
  role: 'admin' | 'member';
  identity_provider: string;
  is_active: number;
  last_login: string | null;
  must_change_password: number;
};

type AccountsResponse = { users: ManagedAccount[] };
type AuditEvent = {
  id: number;
  actor_user_id: number | null;
  action: string;
  target: string | null;
  status_code: number | null;
  created_at: string;
};
type AccountForm = { username: string; password: string; role: 'admin' | 'member' };

/** Used by Settings to manage the local users who share this server's provider runtime. */
export function UsersAdminPanel() {
  const { t } = useTranslation('settings');
  // The server list is the source of truth after every account change.
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  // Recent events show who used shared server capabilities.
  const [events, setEvents] = useState<AuditEvent[]>([]);
  // The form collects credentials for a new local account only.
  const [form, setForm] = useState<AccountForm>({ username: '', password: '', role: 'member' });
  // A reset password is kept only while the administrator edits that account.
  const [reset, setReset] = useState<{ userId: number; password: string; requireChange: boolean } | null>(null);
  // Feedback reports the result of the last request without exposing a password.
  const [feedback, setFeedback] = useState<{ error?: string; success?: string } | null>(null);
  // Loading prevents duplicate requests while the account list refreshes.
  const [loading, setLoading] = useState(false);

  const loadAccounts = useCallback(async () => {
    try {
      const result = await readApiJson<AccountsResponse>(await api.auth.listUsers());
      setAccounts(result.users);
      const audit = await readApiJson<{ events: AuditEvent[] }>(await api.auth.listAudit());
      setEvents(audit.events);
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }, []);

  useEffect(() => {
    void loadAccounts().catch(() => undefined);
  }, [loadAccounts]);

  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setFeedback(null);
    try {
      await readApiJson(await api.auth.createUser(form.username, form.password, form.role));
      setForm({ username: '', password: '', role: 'member' });
      await loadAccounts();
      setFeedback({ success: t('users.created') });
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  };

  const updateAccount = async (id: number, changes: { role?: 'admin' | 'member'; isActive?: boolean }) => {
    setLoading(true);
    setFeedback(null);
    try {
      await readApiJson(await api.auth.updateUser(id, changes));
      await loadAccounts();
      setFeedback({ success: t('users.updated') });
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  };

  const resetAccountPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reset) return;
    setLoading(true);
    setFeedback(null);
    try {
      await readApiJson(await api.auth.resetUserPassword(reset.userId, reset.password, reset.requireChange));
      setReset(null);
      await loadAccounts();
      setFeedback({ success: t('users.passwordUpdated') });
    } catch (error) {
      setFeedback({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-foreground">{t('users.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('users.description')}</p>
      </div>

      <form onSubmit={createAccount} className="grid gap-3 rounded-lg border border-border p-4 md:grid-cols-4">
        <input
          aria-label={t('users.username')}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          autoComplete="off"
          placeholder={t('users.username')}
          value={form.username}
          onChange={(event) => setForm({ ...form, username: event.target.value })}
          required
          minLength={3}
        />
        <input
          aria-label={t('users.password')}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          type="password"
          autoComplete="new-password"
          placeholder={t('users.password')}
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
          required
          minLength={8}
        />
        <select
          aria-label={t('users.role')}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={form.role}
          onChange={(event) => setForm({ ...form, role: event.target.value as AccountForm['role'] })}
        >
          <option value="member">{t('users.member')}</option>
          <option value="admin">{t('users.admin')}</option>
        </select>
        <button disabled={loading} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
          {t('users.create')}
        </button>
      </form>

      {feedback?.error && <p role="alert" className="text-sm text-destructive">{feedback.error}</p>}
      {feedback?.success && <p role="status" className="text-sm text-green-600">{feedback.success}</p>}

      <div className="space-y-3">
        {accounts.map((account) => (
          <div key={account.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
            <div className="min-w-40 flex-1">
              <div className="font-medium text-foreground">{account.username}</div>
              <div className="text-xs text-muted-foreground">
                {account.identity_provider}
                {account.must_change_password === 1 && ` · ${t('users.mustChange')}`}
              </div>
            </div>
            <select
              aria-label={`${t('users.role')}: ${account.username}`}
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              value={account.role}
              disabled={loading}
              onChange={(event) => void updateAccount(account.id, { role: event.target.value as ManagedAccount['role'] })}
            >
              <option value="member">{t('users.member')}</option>
              <option value="admin">{t('users.admin')}</option>
            </select>
            <button
              type="button"
              disabled={loading}
              className="rounded-md border border-border px-3 py-1 text-sm disabled:opacity-50"
              onClick={() => void updateAccount(account.id, { isActive: account.is_active !== 1 })}
            >
              {account.is_active === 1 ? t('users.disable') : t('users.enable')}
            </button>
            {account.identity_provider === 'local' && (
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1 text-sm"
                onClick={() => setReset({ userId: account.id, password: '', requireChange: true })}
              >
                {t('users.resetPassword')}
              </button>
            )}
          </div>
        ))}
      </div>

      {reset && (
        <form onSubmit={resetAccountPassword} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4">
          <input
            aria-label={t('users.newPassword')}
            className="min-w-48 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            type="password"
            autoComplete="new-password"
            placeholder={t('users.newPassword')}
            value={reset.password}
            onChange={(event) => setReset({ ...reset, password: event.target.value })}
            minLength={8}
            required
          />
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={reset.requireChange}
              onChange={(event) => setReset({ ...reset, requireChange: event.target.checked })}
            />
            {t('users.requireChange')}
          </label>
          <button disabled={loading} className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
            {t('users.savePassword')}
          </button>
          <button type="button" className="rounded-md border border-border px-3 py-2 text-sm" onClick={() => setReset(null)}>
            {t('users.cancel')}
          </button>
        </form>
      )}

      <div className="space-y-2">
        <h4 className="font-medium text-foreground">{t('users.auditTitle')}</h4>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
          {events.map((event) => (
            <div key={event.id} className="flex flex-wrap gap-x-3 border-b border-border px-3 py-2 text-xs last:border-b-0">
              <span className="text-muted-foreground">{event.created_at}</span>
              <span>{accounts.find((account) => account.id === event.actor_user_id)?.username ?? '—'}</span>
              <span className="font-mono">{event.action}</span>
              {event.target && <span className="text-muted-foreground">{event.target}</span>}
              {event.status_code && <span>{event.status_code}</span>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
