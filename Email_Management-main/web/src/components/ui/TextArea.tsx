import React from 'react';

interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
  required?: boolean;
}

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ label, error, helperText, required, className = '', ...props }, ref) => {
    const max = props.maxLength;
    const currentLen = typeof props.value === 'string' ? props.value.length : 0;
    const showCounter = max != null;
    const overLimit = showCounter && currentLen > max;
    const nearLimit = showCounter && !overLimit && currentLen >= Math.floor(max * 0.8);

    const counterColor = overLimit ? '#ef4444' : nearLimit ? '#d97706' : '#9ca3af';

    return (
      <div className="space-y-1.5">
        {label && (
          <label className="block text-sm font-medium text-gray-700">
            {label}
            {required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
        )}
        <textarea
          ref={ref}
          className={`w-full px-4 py-2.5 bg-white border rounded-lg text-gray-900 placeholder-gray-400 transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent resize-none ${
            error ? 'border-red-500' : 'border-gray-300 hover:border-gray-400'
          } ${className}`}
          {...props}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
          <div style={{ flex: 1 }}>
            {error && <p className="text-sm text-red-500">{error}</p>}
            {helperText && !error && <p className="text-sm text-gray-500">{helperText}</p>}
          </div>
          {showCounter && (
            <p style={{ fontSize: '0.75rem', lineHeight: '1.25rem', color: counterColor, flexShrink: 0, marginTop: '0.125rem' }}>
              {currentLen} / {max}
            </p>
          )}
        </div>
      </div>
    );
  }
);

TextArea.displayName = 'TextArea';
