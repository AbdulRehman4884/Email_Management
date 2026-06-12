/**
 * src/components/ErrorBoundary.tsx
 *
 * React error boundary — catches unhandled render/lifecycle errors in the
 * component tree and shows a safe fallback UI instead of a blank screen.
 *
 * Usage:
 *   <ErrorBoundary>
 *     <SomePage />
 *   </ErrorBoundary>
 *
 *   <ErrorBoundary fallback={<MyCustomFallback />}>
 *     <SomePage />
 *   </ErrorBoundary>
 *
 * The boundary resets when the user clicks "Refresh page" (full reload) or
 * when the `resetKey` prop changes (e.g. on route change).
 */

import React from 'react';

interface Props {
  children: React.ReactNode;
  /** Override the default fallback UI. */
  fallback?: React.ReactNode;
  /**
   * When this prop changes the boundary clears its error state.
   * Pass the current route pathname to auto-reset on navigation.
   */
  resetKey?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // In production this is the only place we learn about render-time crashes.
    // Structured console.error so any external log-drain picks it up.
    console.error(
      '[ErrorBoundary] Unhandled render error',
      { message: error.message, stack: error.stack },
      info.componentStack,
    );
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;

    if (this.props.fallback) return this.props.fallback;

    return (
      <div
        role="alert"
        style={{
          minHeight: '60vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2rem',
        }}
      >
        <div style={{ maxWidth: '28rem', width: '100%', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#111827', marginBottom: '0.5rem' }}>
            Something went wrong
          </h1>
          <p style={{ color: '#6b7280', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
            An unexpected error occurred on this page. Your data is safe.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.5rem 1.25rem',
              background: '#111827',
              color: '#ffffff',
              borderRadius: '0.5rem',
              fontSize: '0.875rem',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Refresh page
          </button>
          {process.env.NODE_ENV !== 'production' && this.state.error && (
            <pre
              style={{
                marginTop: '1rem',
                textAlign: 'left',
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '0.5rem',
                padding: '0.75rem',
                fontSize: '0.75rem',
                color: '#991b1b',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {this.state.error.message}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
