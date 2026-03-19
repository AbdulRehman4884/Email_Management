import React from 'react';

interface BrandLogoProps {
  iconClassName?: string;
  textClassName?: string;
  className?: string;
}

export function BrandLogo({ iconClassName = 'w-10 h-10', textClassName = 'text-xl font-bold text-gray-900', className = '' }: BrandLogoProps) {
  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <svg viewBox="0 0 96 96" className={iconClassName} aria-hidden="true">
        <rect x="6" y="6" width="84" height="84" rx="28" fill="#111827" />
        <circle cx="48" cy="50" r="17" fill="#f3f4f6" />
      </svg>
      <span className={textClassName}>MailFlow</span>
    </span>
  );
}

