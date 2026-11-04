// Same rules and messages as backend/src/lib/passwordValidation.ts (validatePassword).
export function passwordRuleError(password: string): string | null {
  const p = password.trim();
  if (p.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(p)) return 'Password must include at least one uppercase letter';
  if (!/[a-z]/.test(p)) return 'Password must include at least one lowercase letter';
  if (!/\d/.test(p)) return 'Password must include at least one number';
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(p)) return 'Password must include at least one special character';
  return null;
}
