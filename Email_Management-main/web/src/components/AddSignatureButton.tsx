import { PenLine } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { loadSignature, signatureHtml } from '../lib/composerStorage';

/** Campaign editor: appends the signature from Settings to the email. Hidden when there is no signature. */
export function AddSignatureButton({ onAdd }: { onAdd: (html: string) => void }) {
  const userId = useAuthStore((s) => s.user?.id);
  const signature = userId ? loadSignature(userId) : '';
  if (!signature.trim()) return null;
  return (
    <button
      type="button"
      onClick={() => onAdd(signatureHtml(signature))}
      className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-gray-900"
    >
      <PenLine className="w-4 h-4" aria-hidden />
      Add my signature
    </button>
  );
}
