import React from 'react';
import type { CampaignStatus } from '../../types';

interface StatusBadgeProps {
  status: CampaignStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const statusConfig: Record<CampaignStatus, { label: string; className: string }> = {
    draft: {
      label: 'Draft',
      className: 'bg-gray-100 text-gray-500',
    },
    scheduled: {
      label: 'Scheduled',
      className: 'bg-blue-100 text-blue-600',
    },
    in_progress: {
      label: 'Sending',
      className: 'bg-yellow-100 text-yellow-600',
    },
    paused: {
      label: 'Paused',
      className: 'bg-purple-100 text-purple-600',
    },
    completed: {
      label: 'Completed',
      className: 'bg-green-100 text-green-600',
    },
    cancelled: {
      label: 'Cancelled',
      className: 'bg-red-100 text-red-600',
    },
  };

  const config = statusConfig[status] || statusConfig.draft;

  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium leading-none ${config.className}`}>
      {config.label}
    </span>
  );
}
