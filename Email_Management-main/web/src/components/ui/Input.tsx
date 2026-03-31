import React from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  required?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helperText, required, className = '', ...props }, ref) => {
    return (
      <div className="space-y-1.5">
        {label && (
          <label className="block text-sm font-medium text-gray-700">
            {label}
            {required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
        )}
        <input
          ref={ref}
          className={`w-full px-4 py-2.5 bg-white border rounded-lg text-gray-900 placeholder-gray-400 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent ${
            error ? 'border-red-500' : 'border-gray-300 hover:border-gray-400'
          } ${className}`}
          {...props}
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        {helperText && !error && (
          <p className="text-sm text-gray-500">{helperText}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
