import React from 'react';
import type { CampaignStatus } from '../../types';

interface StatusBadgeProps {
  status: CampaignStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const statusConfig: Record<CampaignStatus, { label: string; className: string }> = {
    draft: {
      label: 'Draft',
      className: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
    },
    scheduled: {
      label: 'Scheduled',
      className: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    },
    in_progress: {
      label: 'In Progress',
      className: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    },
    paused: {
      label: 'Paused',
      className: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    },
    completed: {
      label: 'Completed',
      className: 'bg-green-500/20 text-green-400 border-green-500/30',
    },
    cancelled: {
      label: 'Cancelled',
      className: 'bg-red-500/20 text-red-400 border-red-500/30',
    },
  };

  const config = statusConfig[status] || statusConfig.draft;

  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-lg border ${config.className}`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current mr-1.5" />
      {config.label}
    </span>
  );
}
