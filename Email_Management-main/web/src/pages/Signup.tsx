import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import { Button, Input, Card, CardContent } from '../components/ui';
import { authApi } from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import { BrandLogo } from '../components/BrandLogo';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HAS_UPPER = /[A-Z]/;
const HAS_LOWER = /[a-z]/;
const HAS_DIGIT = /\d/;
const HAS_SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/;

function usePasswordRules(password: string) {
  return {
    minLength: password.length >= 8,
    upper: HAS_UPPER.test(password),
    lower: HAS_LOWER.test(password),
    digit: HAS_DIGIT.test(password),
    special: HAS_SPECIAL.test(password),
  };
}

function allRulesMet(rules: ReturnType<typeof usePasswordRules>) {
  return rules.minLength && rules.upper && rules.lower && rules.digit && rules.special;
}

export function Signup() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const passwordRules = usePasswordRules(password);
  const passwordValid = allRulesMet(passwordRules);
  const confirmMatch = password === confirmPassword && confirmPassword.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedName) {
      setError('Name is required');
      return;
    }
    if (!trimmedEmail) {
      setError('Email is required');
      return;
    }
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setError('Please enter a valid email address');
      return;
    }
    if (!passwordValid) {
      setError('Password must meet all requirements below');
      return;
    }
    if (!confirmMatch) {
      setError('Passwords do not match');
      return;
    }
    setIsLoading(true);
    try {
      const { user, token } = await authApi.signup({
        email: trimmedEmail,
        password,
        name: trimmedName,
      });
      setAuth(user, token);
      const preferred = user.preferredTheme ?? 'light';
      useThemeStore.getState().setThemeFromServer(preferred as 'light' | 'dark' | 'system');
      navigate('/', { replace: true });
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err && err.response && typeof err.response === 'object' && 'data' in err.response && err.response.data && typeof err.response.data === 'object' && 'error' in err.response.data
          ? String((err.response.data as { error: string }).error)
          : 'Registration failed. Please try again.';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  const Rule = ({ met, label }: { met: boolean; label: string }) => (
    <span className={`flex items-center gap-2 text-sm ${met ? 'text-green-600' : 'text-gray-400'}`}>
      {met ? <Check className="w-4 h-4" /> : <X className="w-4 h-4" />}
      {label}
    </span>
  );

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex">
            <BrandLogo iconClassName="w-12 h-12" textClassName="text-5xl font-black text-gray-900 tracking-tight" />
          </Link>
        </div>
        <Card>
          <CardContent className="p-6 sm:p-8">
            <h1 className="text-xl font-bold text-gray-900 mb-2">Create an account</h1>
            <p className="text-gray-500 text-sm mb-6">Enter your details to get started.</p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                type="text"
                label="Name"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                required
                disabled={isLoading}
              />
              <Input
                type="email"
                label="Email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                disabled={isLoading}
              />
              <div>
                <Input
                  type="password"
                  label="Password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  disabled={isLoading}
                />
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
                  <Rule met={passwordRules.minLength} label="At least 8 characters" />
                  <Rule met={passwordRules.upper} label="One uppercase letter" />
                  <Rule met={passwordRules.lower} label="One lowercase letter" />
                  <Rule met={passwordRules.digit} label="One number" />
                  <Rule met={passwordRules.special} label="One special character" />
                </div>
              </div>
              <Input
                type="password"
                label="Confirm password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
                error={confirmPassword.length > 0 && !confirmMatch ? 'Passwords do not match' : undefined}
                disabled={isLoading}
              />
              {error && (
                <p className="text-sm text-red-500" role="alert">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full"
                size="lg"
                isLoading={isLoading}
                disabled={isLoading || !passwordValid || !confirmMatch}
              >
                Sign up
              </Button>
            </form>
            <p className="mt-6 text-center text-sm text-gray-500">
              Already have an account?{' '}
              <Link to="/login" className="text-gray-900 hover:text-gray-700 font-medium">
                Sign in
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
