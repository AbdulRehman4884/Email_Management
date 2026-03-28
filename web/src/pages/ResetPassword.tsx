import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Input, Card, CardContent } from '../components/ui';
import { authApi } from '../lib/api';
import { BrandLogo } from '../components/BrandLogo';

export function ResetPassword() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const queryEmail = searchParams.get('email') ?? '';
  const [email, setEmail] = useState(queryEmail);
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (queryEmail) setEmail(queryEmail);
  }, [queryEmail]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) {
      setError('Email is required');
      return;
    }
    if (otp.trim().length !== 6) {
      setError('OTP must be 6 digits');
      return;
    }
    if (newPassword.trim().length === 0) {
      setError('New password is required');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setIsLoading(true);
    try {
      await authApi.resetPassword({
        email: trimmedEmail,
        otp: otp.trim(),
        newPassword,
        confirmPassword,
      });
      navigate('/login', { replace: true });
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err && err.response && typeof err.response === 'object' && 'data' in err.response
          ? String((err.response.data as { error?: string })?.error ?? 'Failed to reset password')
          : 'Failed to reset password';
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
            <h1 className="text-xl font-bold text-gray-900 mb-2">Reset password</h1>
            <p className="text-gray-500 text-sm mb-6">Enter OTP and set a new password.</p>

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
                type="text"
                label="OTP"
                placeholder="123456"
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                autoComplete="one-time-code"
                required
                disabled={isLoading}
              />

              <Input
                type="password"
                label="New password"
                placeholder="••••••••"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                required
                disabled={isLoading}
              />

              <Input
                type="password"
                label="Confirm password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                required
                disabled={isLoading}
              />

              {error && (
                <p className="text-sm text-red-500" role="alert">
                  {error}
                </p>
              )}

              <Button type="submit" className="w-full" size="lg" isLoading={isLoading} disabled={isLoading}>
                Change password
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

