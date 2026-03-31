import React from 'react';
import type { CampaignStatus } from '../../types';

interface StatusBadgeProps {
  status: CampaignStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const statusConfig: Record<CampaignStatus, { label: string; color: string }> = {
    draft: {
      label: 'Draft',
      color: 'text-gray-500',
    },
    scheduled: {
      label: 'Scheduled',
      color: 'text-blue-600',
    },
    in_progress: {
      label: 'Sending',
      color: 'text-orange-500',
    },
    paused: {
      label: 'Paused',
      color: 'text-gray-500',
    },
    completed: {
      label: 'Completed',
      color: 'text-green-600',
    },
    cancelled: {
      label: 'Cancelled',
      color: 'text-red-500',
    },
  };

  const config = statusConfig[status] || statusConfig.draft;

  return (
    <span className={`inline-flex items-center text-sm font-medium ${config.color}`}>
      {config.label}
    </span>
  );
}
