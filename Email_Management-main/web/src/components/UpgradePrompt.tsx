import React from 'react';
import { Link } from 'react-router-dom';
import { Lock, ArrowRight } from 'lucide-react';
import { Button } from './ui';
import { useAuthStore } from '../store/authStore';

interface UpgradePromptProps {
  feature: string;
  requiredPlan?: string;
}

export function UpgradePrompt({ feature, requiredPlan = 'Standard' }: UpgradePromptProps) {
  const plan = useAuthStore((s) => s.user?.plan);
  const currentPlan = plan?.name ?? 'Free';

  return (
    <div className="flex items-center justify-center min-h-[60vh] p-8">
      <div className="max-w-md w-full text-center">
        <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <Lock className="w-8 h-8 text-gray-400" />
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Upgrade to access {feature}</h2>
        <p className="text-gray-500 mb-6">
          Your current plan (<span className="font-medium text-gray-700">{currentPlan}</span>) doesn't
          include {feature}. Upgrade to {requiredPlan} or higher to unlock this feature.
        </p>
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 mb-6 text-sm text-left space-y-2">
          <p className="font-medium text-gray-800">{requiredPlan} plan includes:</p>
          <p className="text-gray-600">✓ {feature}</p>
          <p className="text-gray-600">✓ More SMTP profiles</p>
          <p className="text-gray-600">✓ Higher daily sending limits</p>
        </div>
        <Link to="/packages">
          <Button className="w-full" size="lg">
            View pricing plans
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </Link>
      </div>
    </div>
  );
}
