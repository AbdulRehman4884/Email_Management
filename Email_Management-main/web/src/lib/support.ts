// F-05 / F-06: public contact address for sales/support. VITE_SUPPORT_EMAIL in the web build env overrides it.
export const SUPPORT_EMAIL: string =
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_SUPPORT_EMAIL?.trim() ||
  'sales@deltaprimeaisolutions.com';
