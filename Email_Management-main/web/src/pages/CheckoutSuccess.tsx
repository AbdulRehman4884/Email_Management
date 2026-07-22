import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle, XCircle, Loader2, ArrowRight } from 'lucide-react';
import { BrandLogo } from '../components/BrandLogo';
import { Button } from '../components/ui';
import { paymentApi } from '../lib/api';

type PageState = 'loading' | 'success' | 'processing' | 'error';

export function CheckoutSuccess() {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id') ?? '';
  const [state, setState] = useState<PageState>('loading');
  const [email, setEmail] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);

  useEffect(() => {
    if (!sessionId) {
      setState('error');
      return;
    }

    let cancelled = false;
    let pollTimer: ReturnType<typeof setTimeout>;

    const check = async () => {
      try {
        const { status, email: e } = await paymentApi.getCheckoutStatus(sessionId);
        if (cancelled) return;

        if (status === 'complete') {
          setState('success');
          setEmail(e);
        } else if (status === 'open') {
          // Payment still processing — poll up to 10 times (30s total)
          setPollCount((n) => {
            const next = n + 1;
            if (next >= 10) {
              setState('error');
            } else {
              setState('processing');
              pollTimer = setTimeout(check, 3000);
            }
            return next;
          });
        } else {
          setState('error');
        }
      } catch {
        if (!cancelled) setState('error');
      }
    };

    void check();
    return () => {
      cancelled = true;
      clearTimeout(pollTimer);
    };
  }, [sessionId]);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center">
          <Link to="/" className="inline-flex">
            <BrandLogo iconClassName="w-8 h-8" textClassName="text-lg font-bold text-gray-900" />
          </Link>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          {state === 'loading' && (
            <div className="space-y-4">
              <Loader2 className="w-12 h-12 animate-spin text-gray-400 mx-auto" />
              <p className="text-gray-600">Verifying your payment...</p>
            </div>
          )}

          {state === 'processing' && (
            <div className="space-y-4">
              <Loader2 className="w-12 h-12 animate-spin text-purple-500 mx-auto" />
              <h1 className="text-xl font-bold text-gray-900">Payment is processing</h1>
              <p className="text-gray-500 text-sm">
                This usually takes a few seconds. Please don't close this page.
                <br />
                Check {pollCount}/10...
              </p>
            </div>
          )}

          {state === 'success' && (
            <div className="space-y-6">
              <div className="flex items-center justify-center">
                <CheckCircle className="w-16 h-16 text-green-500" />
              </div>
              <div>
                <h1 className="text-2xl font-black text-gray-900">Payment successful!</h1>
                <p className="text-gray-500 mt-2">
                  Your account has been created
                  {email ? ` for ${email}` : ''}.
                </p>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 text-sm text-gray-600 text-left space-y-1">
                <p className="font-medium text-gray-800">Next steps:</p>
                <p>1. Go to the login page below</p>
                <p>2. Sign in with your email and password</p>
                <p>3. Start sending campaigns!</p>
              </div>
              <Link to="/login">
                <Button className="w-full" size="lg">
                  Sign in to your account
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              </Link>
            </div>
          )}

          {state === 'error' && (
            <div className="space-y-6">
              <div className="flex items-center justify-center">
                <XCircle className="w-16 h-16 text-red-400" />
              </div>
              <div>
                <h1 className="text-2xl font-black text-gray-900">Something went wrong</h1>
                <p className="text-gray-500 mt-2">
                  We couldn't verify your payment. If you were charged, please contact support with your session ID:
                </p>
                {sessionId && (
                  <code className="block mt-2 text-xs text-gray-400 bg-gray-100 rounded px-3 py-2 break-all">
                    {sessionId}
                  </code>
                )}
              </div>
              <div className="flex flex-col gap-3">
                <Link to="/packages">
                  <Button className="w-full" variant="primary">
                    Try again
                  </Button>
                </Link>
                <Link to="/login">
                  <Button className="w-full" variant="secondary">
                    Already have an account? Sign in
                  </Button>
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
