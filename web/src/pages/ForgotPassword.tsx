import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input, Card, CardContent } from '../components/ui';
import { authApi } from '../lib/api';
import { BrandLogo } from '../components/BrandLogo';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setMessage('');

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setError('Email is required');
      return;
    }
    if (!EMAIL_REGEX.test(trimmedEmail)) {
      setError('Please enter a valid email address');
      return;
    }

    setIsLoading(true);
    try {
      const { message: msg } = await authApi.forgotPassword({ email: trimmedEmail });
      setMessage(msg);
      navigate(`/reset-password?email=${encodeURIComponent(trimmedEmail)}`, { replace: true });
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err && err.response && typeof err.response === 'object' && 'data' in err.response
          ? String((err.response.data as { error?: string })?.error ?? 'Failed to request OTP')
          : 'Failed to request OTP';
      setError(msg);
    } finally {
      setIsLoading(false);
    }
  };

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
            <h1 className="text-xl font-bold text-gray-900 mb-2">Forgot password</h1>
            <p className="text-gray-500 text-sm mb-6">Enter your email and we will send an OTP to reset your password.</p>

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
                error={error || undefined}
              />

              {message && <p className="text-sm text-gray-600">{message}</p>}

              <Button type="submit" className="w-full" size="lg" isLoading={isLoading} disabled={isLoading}>
                Send OTP
              </Button>

              <p className="text-center text-sm text-gray-500">
                Remembered your password?{' '}
                <Link to="/login" className="text-gray-900 hover:text-gray-700 font-medium">
                  Sign in
                </Link>
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

