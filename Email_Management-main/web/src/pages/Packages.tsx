import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Check, Zap, Star, Crown, Eye, EyeOff, X, Loader2 } from 'lucide-react';
import { Button, Input, Card, CardContent } from '../components/ui';
import { BrandLogo } from '../components/BrandLogo';
import { SMTP_DAILY_EMAIL_LIMIT_MAX, SMTP_PROFILES_UNLIMITED, smtpProfilesLabel } from '../lib/smtpLimits';
import { paymentApi } from '../lib/api';
import type { PlanInfo } from '../lib/api';
import { passwordRuleError } from '../lib/passwordRules';
import { SUPPORT_EMAIL } from '../lib/support';
import { useAuthStore } from '../store/authStore';

const EMAIL_REGEX = /^(?!.*\.\.)[a-zA-Z0-9](?:[a-zA-Z0-9._%+-]*[a-zA-Z0-9])?@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

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
    smtpProfilesLabel(plan.smtpLimit),
    // Each SMTP account sends at most SMTP_DAILY_EMAIL_LIMIT_MAX (20) per day, whatever the plan number.
    `${Math.min(plan.dailyEmailLimit, SMTP_DAILY_EMAIL_LIMIT_MAX)} emails/day per SMTP account`,
    'Campaign management',
    'Analytics & tracking',
    // F-06: link clicks are not tracked, only opens and replies.
    'Open & reply tracking',
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
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const [isLoading, setIsLoading] = useState(false);

  // F-09: Esc closes the modal (unless a checkout request is in flight).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isLoading) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, isLoading]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();

    // F-07 / F-08: validate all fields together (same password rules as the server) and focus the first invalid one.
    const errs: typeof fieldErrors = {};
    if (!trimmedName) errs.name = 'Name is required';
    if (!trimmedEmail) errs.email = 'Email is required';
    else if (!EMAIL_REGEX.test(trimmedEmail)) errs.email = 'Please enter a valid email address';
    const pwError = password ? passwordRuleError(password) : 'Password is required';
    if (pwError) errs.password = pwError;
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      document.getElementById(errs.name ? 'register-name' : errs.email ? 'register-email' : 'register-password')?.focus();
      return;
    }

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
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="register-modal-title"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 id="register-modal-title" className="text-lg font-bold text-gray-900">Get Started with {plan.name}</h2>
            <p className="text-sm text-gray-500">${plan.priceUsd}/month · Cancel anytime</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5">
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <Input
              id="register-name"
              label="Full name"
              type="text"
              placeholder="John Smith"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
              disabled={isLoading}
              error={fieldErrors.name}
              autoFocus
            />
            <Input
              id="register-email"
              label="Email address"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              disabled={isLoading}
              error={fieldErrors.email}
            />
            <div className="space-y-1.5">
              <label className="block text-sm font-medium text-gray-700" htmlFor="register-password">
                Password <span className="text-red-500" aria-hidden="true">*</span>
              </label>
              <div className="relative">
                <input
                  id="register-password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Min 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={8}
                  disabled={isLoading}
                  aria-invalid={fieldErrors.password ? true : undefined}
                  aria-describedby="register-password-help"
                  className={`w-full px-4 py-2.5 bg-white border rounded-lg text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent disabled:opacity-50 ${fieldErrors.password ? 'border-red-500' : 'border-gray-300'}`}
                  style={{ paddingRight: '2.75rem' }}
                />
                {/* F-10: same inline positioning as Login/Signup so the icon stays inside the box at narrow widths. */}
                <button
                  type="button"
                  className="text-gray-400 hover:text-gray-600"
                  style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', padding: '0', lineHeight: '0' }}
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-5 h-5" aria-hidden /> : <Eye className="w-5 h-5" aria-hidden />}
                </button>
              </div>
              <p id="register-password-help" className={`text-sm ${fieldErrors.password ? 'text-red-500' : 'text-gray-500'}`} role={fieldErrors.password ? 'alert' : undefined}>
                {fieldErrors.password ?? 'At least 8 characters, with uppercase, lowercase, a number and a special character.'}
              </p>
            </div>

            {error && (
              <p className="text-sm text-red-500 bg-red-50 px-3 py-2 rounded-lg" role="alert">{error}</p>
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
  const isLoggedIn = useAuthStore((s) => !!s.token && !!s.user);

  useEffect(() => {
    paymentApi
      .getPlans()
      .then(({ plans: p }) => setPlans(p))
      .catch(() =>
        setPlans([
          { code: 'basic', name: 'Basic', smtpLimit: 5, dailyEmailLimit: SMTP_DAILY_EMAIL_LIMIT_MAX, inboxEnabled: false, followUpEnabled: false, stripePriceId: null, priceUsd: '9.99' },
          { code: 'standard', name: 'Standard', smtpLimit: 100, dailyEmailLimit: SMTP_DAILY_EMAIL_LIMIT_MAX, inboxEnabled: true, followUpEnabled: true, stripePriceId: null, priceUsd: '24.99' },
          { code: 'premium', name: 'Premium', smtpLimit: SMTP_PROFILES_UNLIMITED, dailyEmailLimit: SMTP_DAILY_EMAIL_LIMIT_MAX, inboxEnabled: true, followUpEnabled: true, stripePriceId: null, priceUsd: '49.99' },
        ])
      )
      .finally(() => setIsLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <Link to="/" className="inline-flex flex-shrink-0">
            <BrandLogo iconClassName="w-8 h-8" textClassName="text-lg font-bold text-gray-900" />
          </Link>
          {/* CK-01: logged-in users get a way back into the app instead of the sign-in prompt.
              N-14: on narrow phones only the short "Sign in" is shown so the header does not wrap. */}
          <Link
            to={isLoggedIn ? '/' : '/login'}
            className="text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors whitespace-nowrap ml-3"
          >
            {isLoggedIn ? 'Go to dashboard' : <><span className="hidden sm:inline">Already have an account? </span>Sign in</>}
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
          // N-04: skeleton cards with the same footprint as the plan cards, so the layout does not jump.
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-4" aria-busy="true" aria-label="Loading plans">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="shadow-sm">
                <CardContent className="p-6 animate-pulse">
                  <div className="h-6 w-28 bg-gray-200 rounded mb-6" />
                  <div className="h-10 w-32 bg-gray-200 rounded mb-2" />
                  <div className="h-4 w-40 bg-gray-100 rounded mb-6" />
                  <div className="space-y-3 mb-6">
                    {[0, 1, 2, 3, 4, 5].map((j) => (
                      <div key={j} className="h-4 bg-gray-100 rounded" />
                    ))}
                  </div>
                  <div className="h-11 bg-gray-200 rounded-lg" />
                </CardContent>
              </Card>
            ))}
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
          {/* F-06: claims match the real plan limits (daily cap per SMTP account, no 24/7 support promise). */}
          <p className="text-sm text-gray-500">
            All plans include campaign management, open &amp; reply tracking and CSV recipient upload. Sending is limited to{' '}
            {SMTP_DAILY_EMAIL_LIMIT_MAX} emails per day per SMTP account.
          </p>
          <p className="text-sm text-gray-400 mt-1">
            Need more?{' '}
            {SUPPORT_EMAIL ? (
              <a
                href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Enterprise pricing')}`}
                className="text-gray-700 underline hover:text-gray-900"
              >
                Contact us for enterprise pricing
              </a>
            ) : (
              'Contact us for enterprise pricing.'
            )}
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
