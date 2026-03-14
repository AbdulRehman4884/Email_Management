import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail } from 'lucide-react';
import { Button, Input, Card, CardContent } from '../components/ui';
import { authApi } from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Login() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setError('Email is required');
      return;
    }
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setError('Please enter a valid email address');
      return;
    }
    if (!password) {
      setError('Password is required');
      return;
    }
    setIsLoading(true);
    try {
      const { user, token } = await authApi.login({ email: trimmedEmail, password });
      setAuth(user, token);
      const preferred = user.preferredTheme ?? 'dark';
      useThemeStore.getState().setThemeFromServer(preferred as 'light' | 'dark' | 'system');
      navigate('/', { replace: true });
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err && err.response && typeof err.response === 'object' && 'data' in err.response && err.response.data && typeof err.response.data === 'object' && 'error' in err.response.data
          ? String((err.response.data as { error: string }).error)
          : 'Invalid email or password';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-2 text-xl font-bold text-white">
            <span className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center">
              <Mail className="w-5 h-5 text-white" />
            </span>
            MailFlow
          </Link>
        </div>
        <Card className="border border-gray-800">
          <CardContent className="p-6 sm:p-8">
            <h1 className="text-xl font-bold text-white mb-2">Sign in</h1>
            <p className="text-gray-400 text-sm mb-6">Enter your email and password to continue.</p>
            <form onSubmit={handleSubmit} className="space-y-4">
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
              <Input
                type="password"
                label="Password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                disabled={isLoading}
              />
              {error && (
                <p className="text-sm text-red-400" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" size="lg" isLoading={isLoading} disabled={isLoading}>
                Sign in
              </Button>
            </form>
            <p className="mt-6 text-center text-sm text-gray-400">
              Don't have an account?{' '}
              <Link to="/signup" className="text-indigo-400 hover:text-indigo-300 font-medium">
                Sign up
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
