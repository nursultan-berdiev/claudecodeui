import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2, Lock, ShieldCheck } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthInputField from '@/modules/auth/AuthInputField';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';

type ChangePasswordFormState = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

type ChangePasswordFormProps = {
  variant: 'screen' | 'settings';
};

const initialState: ChangePasswordFormState = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

function validateChangePasswordForm(formState: ChangePasswordFormState, t: (key: string) => string): string | null {
  if (!formState.currentPassword || !formState.newPassword || !formState.confirmPassword) {
    return t('changePassword.errors.requiredFields');
  }

  if (formState.newPassword.length < 8) {
    return t('changePassword.errors.passwordLength');
  }

  if (formState.newPassword !== formState.confirmPassword) {
    return t('changePassword.errors.passwordMismatch');
  }

  if (formState.newPassword === formState.currentPassword) {
    return t('changePassword.errors.passwordUnchanged');
  }

  return null;
}

/** Used by ProtectedRoute (`screen`, for a temporary password) and Settings → Account (`settings`) to replace the user's password. */
export default function ChangePasswordForm({ variant }: ChangePasswordFormProps) {
  const { t } = useTranslation(['auth', 'settings']);
  const { changePassword, logout } = useAuth();

  const [formState, setFormState] = useState<ChangePasswordFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isChanged, setIsChanged] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof ChangePasswordFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
    setIsChanged(false);
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      const validationError = validateChangePasswordForm(formState, t);
      if (validationError) {
        setErrorMessage(validationError);
        return;
      }

      setIsSubmitting(true);
      const result = await changePassword(formState.currentPassword, formState.newPassword);
      setIsSubmitting(false);
      if (!result.success) {
        setErrorMessage(result.error);
        return;
      }
      setFormState(initialState);
      setIsChanged(true);
    },
    [changePassword, formState, t],
  );

  const form = (
    <form onSubmit={handleSubmit} className="space-y-4">
      <AuthInputField
        id="currentPassword"
        name="currentPassword"
        label={t('changePassword.currentPassword')}
        value={formState.currentPassword}
        onChange={(value) => updateField('currentPassword', value)}
        placeholder={t('changePassword.placeholderCurrent')}
        isDisabled={isSubmitting}
        type="password"
        autoComplete="current-password"
        icon={Lock}
      />

      <AuthInputField
        id="newPassword"
        name="newPassword"
        label={t('changePassword.newPassword')}
        value={formState.newPassword}
        onChange={(value) => updateField('newPassword', value)}
        placeholder={t('changePassword.placeholderNew')}
        isDisabled={isSubmitting}
        type="password"
        autoComplete="new-password"
        icon={KeyRound}
      />

      <AuthInputField
        id="confirmNewPassword"
        name="confirmNewPassword"
        label={t('changePassword.confirmPassword')}
        value={formState.confirmPassword}
        onChange={(value) => updateField('confirmPassword', value)}
        placeholder={t('changePassword.placeholderConfirm')}
        isDisabled={isSubmitting}
        type="password"
        autoComplete="new-password"
        icon={ShieldCheck}
      />

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        {t('changePassword.hint')}
      </p>

      <AuthErrorAlert errorMessage={errorMessage} />
      {isChanged && <p role="status" className="text-sm text-green-600">{t('changePassword.success')}</p>}

      <button
        type="submit"
        disabled={isSubmitting}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('changePassword.saving')}
          </>
        ) : (
          t('changePassword.submit')
        )}
      </button>
    </form>
  );

  if (variant === 'settings') {
    return (
      <section className="max-w-md space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-foreground">{t('settings:account.passwordTitle')}</h3>
          <p className="text-sm text-muted-foreground">{t('settings:account.passwordDescription')}</p>
        </div>
        {form}
      </section>
    );
  }

  return (
    <AuthScreenLayout
      title={t('changePassword.title')}
      description={t('changePassword.description')}
      footerText={t('changePassword.footerText')}
    >
      {form}
      <button
        type="button"
        onClick={logout}
        className="mt-3 w-full text-center text-sm text-muted-foreground hover:text-foreground"
      >
        {t('changePassword.signOut')}
      </button>
    </AuthScreenLayout>
  );
}
