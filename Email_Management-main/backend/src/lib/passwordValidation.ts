import { z } from 'zod';

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .refine((p) => /[A-Z]/.test(p), 'Password must include at least one uppercase letter')
  .refine((p) => /[a-z]/.test(p), 'Password must include at least one lowercase letter')
  .refine((p) => /\d/.test(p), 'Password must include at least one number')
  .refine((p) => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(p), 'Password must include at least one special character');

export function validatePassword(password: string): { success: true } | { success: false; message: string } {
  const result = passwordSchema.safeParse(password.trim());
  if (result.success) return { success: true };
  const first = result.error.issues[0];
  return { success: false, message: first?.message ?? 'Invalid password' };
}

export const signupBodySchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name too long'),
});

export const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export const forgotPasswordBodySchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email format'),
});

export const verifyResetOtpBodySchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email format'),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
});

export const resetPasswordBodySchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email format'),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  newPassword: z.string().min(1, 'New password is required'),
  confirmPassword: z.string().min(1, 'Confirm password is required'),
});
