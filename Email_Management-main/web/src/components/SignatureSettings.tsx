import { useState } from 'react';
import { Save } from 'lucide-react';
import { Button, Card, CardContent, useToast } from './ui';
import { useAuthStore } from '../store/authStore';
import { loadSignature, storeSignature, SIGNATURE_MAX } from '../lib/composerStorage';

/** Settings → "Email signature": added to Inbox replies, and to campaign emails with "Add my signature". */
export function SignatureSettings() {
  const toast = useToast();
  const userId = useAuthStore((s) => s.user?.id);
  const [signature, setSignature] = useState(() => (userId ? loadSignature(userId) : ''));

  if (!userId) return null;

  const save = () => {
    if (storeSignature(userId, signature)) toast.success('Signature saved');
    else toast.error('Could not save the signature: this browser blocks local storage');
  };

  return (
    <Card>
      <CardContent className="py-5">
        <h2 className="text-base font-semibold text-gray-900">Email signature</h2>
        <p className="text-sm text-gray-500 mt-0.5 mb-3">
          Added to the end of your Inbox replies. In a campaign, use “Add my signature” in the email editor.
          Saved in this browser only.
        </p>
        <textarea
          aria-label="Email signature"
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          maxLength={SIGNATURE_MAX}
          rows={4}
          placeholder={'Your Name\nJob title, Company\n+92 300 0000000'}
          className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 resize-y"
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-gray-400">{signature.length}/{SIGNATURE_MAX}</span>
          <Button size="sm" leftIcon={<Save className="w-4 h-4" />} onClick={save}>
            Save signature
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
