import React from 'react';
import { Link } from 'react-router-dom';
import { buttonClassName } from '../components/ui';

/** F-11: shown for any unknown URL inside the app instead of an empty page. */
export function NotFound() {
  return (
    <div className="text-center py-16">
      <p className="text-sm font-semibold text-gray-500">404</p>
      <h1 className="text-2xl font-bold text-gray-900 mt-1">Page not found</h1>
      <p className="text-gray-500 mt-2 mb-6">The page you are looking for does not exist or was moved.</p>
      <Link to="/" className={buttonClassName('primary', 'md')}>
        Go to dashboard
      </Link>
    </div>
  );
}
