import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Check, Zap, Star, Crown, Eye, EyeOff, X, Loader2 } from 'lucide-react';
import { Button, Input, Card, CardContent } from '../components/ui';
import { BrandLogo } from '../components/BrandLogo';
import { paymentApi } from '../lib/api';
import type { PlanInfo } from '../lib/api';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PLAN_META: Record<string, { icon: React.ReactNode; color: string; popular?: boolean }> = {
  basic: {
    icon: <Zap className="w-6 h-6" />,
    color: 'text-blue-600',
  },
  standard: {
    icon: <Star className="w-6 h-6" />,
    color: 'text-purple-600',
    popular: true,
  },
  premium: {
    icon: <Crown className="w-6 h-6" />,
    color: 'text-amber-600',
  },
};

function planFeatures(plan: PlanInfo): string[] {
  const features = [
    `${plan.smtpLimit} SMTP profile${plan.smtpLimit > 1 ? 's' : ''}`,
    `${plan.dailyEmailLimit} emails/day per SMTP`,
    'Campaign management',
    'Analytics & tracking',
    'Open & click tracking',
    'CSV recipient upload',
  ];
  if (plan.inboxEnabled) features.push('Inbox & reply management');
  if (plan.followUpEnabled) features.push('Follow-up automation');
  return features;
}

interface RegisterModalProps {
  plan: PlanInfo;
  onClose: () => void;
}

function RegisterModal({ plan, onClose }: RegisterModalProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();

    if (!trimmedName) return setError('Name is required');
    if (!EMAIL_REGEX.test(trimmedEmail)) return setError('Please enter a valid email address');
    if (password.length < 8) return setError('Password must be at least 8 characters');

    setIsLoading(true);
    try {
      const { url } = await paymentApi.createCheckoutSession({
        name: trimmedName,
        email: trimmedEmail,
        password,
        planCode: plan.code as 'basic' | 'standard' | 'premium',
      });
      window.location.href = url;
    } catch (err: unknown) {
      const msg =
        err && typeof err === 'object' && 'response' in err
          ? String((err as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'Failed to start checkout')
          : 'Failed to start checkout. Please try again.';
      setError(msg);
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Get Started with {plan.name}</h2>
            <p className="text-sm text-gray-500">${plan.priceUsd}/month · Cancel anytime</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5">
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Full name"
              type="text"
              placeholder="John Smith"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
              disabled={isLoading}
            />
            <Input
              label="Email address"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              disabled={isLoading}
            />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700">
                Password <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Min 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  disabled={isLoading}
                  className="w-full px-4 py-2.5 bg-white border border-gray-300 rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent disabled:opacity-50"
                  style={{ paddingRight: '2.75rem' }}
                />
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
            )}

            <Button type="submit" className="w-full" size="lg" isLoading={isLoading} disabled={isLoading}>
              {isLoading ? 'Redirecting to payment...' : `Continue to Payment · $${plan.priceUsd}/mo`}
            </Button>
          </form>

          <p className="mt-4 text-center text-xs text-gray-400">
            Secured by Stripe · Your account is created after payment
          </p>
        </div>
      </div>
    </div>
  );
}

export function Packages() {
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<PlanInfo | null>(null);

  useEffect(() => {
    paymentApi
      .getPlans()
      .then(({ plans: p }) => setPlans(p))
      .catch(() =>
        setPlans([
          { code: 'basic', name: 'Basic', smtpLimit: 1, dailyEmailLimit: 10, inboxEnabled: false, followUpEnabled: false, stripePriceId: null, priceUsd: '0.10' },
          { code: 'standard', name: 'Standard', smtpLimit: 3, dailyEmailLimit: 25, inboxEnabled: true, followUpEnabled: true, stripePriceId: null, priceUsd: '24.99' },
          { code: 'premium', name: 'Premium', smtpLimit: 5, dailyEmailLimit: 50, inboxEnabled: true, followUpEnabled: true, stripePriceId: null, priceUsd: '49.99' },
        ])
      )
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="inline-flex">
            <BrandLogo iconClassName="w-8 h-8" textClassName="text-lg font-bold text-gray-900" />
          </Link>
          <Link
            to="/login"
            className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
          >
            Already have an account? Sign in
          </Link>
        </div>
      </header>

      {/* Hero */}
      <div className="max-w-6xl mx-auto px-4 pt-16 pb-8 text-center">
        <h1 className="text-4xl font-black text-gray-900 tracking-tight">
          Simple, transparent pricing
        </h1>
        <p className="mt-4 text-lg text-gray-500 max-w-2xl mx-auto">
          Choose the plan that fits your sending volume. No hidden fees, cancel anytime. Your account is activated immediately after payment.
        </p>
      </div>

      {/* Plans */}
      <div className="max-w-6xl mx-auto px-4 pb-20">
        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4">
            {plans.map((plan) => {
              const meta = PLAN_META[plan.code] ?? { icon: <Zap className="w-6 h-6" />, color: 'text-gray-600' };
              const features = planFeatures(plan);

              return (
                <Card
                  key={plan.code}
                  className={`relative flex flex-col ${meta.popular ? 'ring-2 ring-gray-900 shadow-xl' : 'shadow-sm'}`}
                >
                  {meta.popular && (
                    <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                      <span className="bg-gray-900 text-white text-xs font-bold px-3 py-1 rounded-full">
                        Most Popular
                      </span>
                    </div>
                  )}
                  <CardContent className="p-6 flex flex-col flex-1">
                    {/* Plan header */}
                    <div className="flex items-center gap-3 mb-4">
                      <div className={`${meta.color}`}>{meta.icon}</div>
                      <h2 className="text-xl font-bold text-gray-900">{plan.name}</h2>
                    </div>

                    {/* Price */}
                    <div className="mb-6">
                      <div className="flex items-end gap-1">
                        <span className="text-4xl font-black text-gray-900">${plan.priceUsd}</span>
                        <span className="text-gray-500 mb-1">/month</span>
                      </div>
                      <p className="text-sm text-gray-400 mt-1">Billed monthly · Cancel anytime</p>
                    </div>

                    {/* Features */}
                    <ul className="space-y-3 flex-1 mb-6">
                      {features.map((f) => (
                        <li key={f} className="flex items-start gap-2.5 text-sm text-gray-700">
                          <Check className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                          {f}
                        </li>
                      ))}
                    </ul>

                    {/* CTA */}
                    <Button
                      className="w-full"
                      size="lg"
                      variant={meta.popular ? 'primary' : 'secondary'}
                      onClick={() => setSelectedPlan(plan)}
                    >
                      Get Started
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Feature comparison note */}
        <div className="mt-12 text-center">
          <p className="text-sm text-gray-500">
            All plans include unlimited campaigns, email tracking, and 24/7 email support.
          </p>
          <p className="text-sm text-gray-400 mt-1">
            Need more? Contact us for enterprise pricing.
          </p>
        </div>
      </div>

      {/* Registration modal */}
      {selectedPlan && (
        <RegisterModal
          plan={selectedPlan}
          onClose={() => setSelectedPlan(null)}
        />
      )}
    </div>
  );
}
