import { useState } from 'react';
import { Save } from 'lucide-react';
import { Button, Card, CardContent, useToast } from './ui';
import { useAuthStore } from '../store/authStore';
import { loadBookingLink, storeBookingLink, BOOKING_LINK_MAX } from '../lib/composerStorage';

/** Settings → "Meeting link": saved once, then dropped into an Inbox reply with one click ("Book a call"). */
export function BookingLinkSettings() {
  const toast = useToast();
  const userId = useAuthStore((s) => s.user?.id);
  const [link, setLink] = useState(() => (userId ? loadBookingLink(userId) : ''));

  if (!userId) return null;

  const trimmed = link.trim();
  const looksValid = trimmed === '' || /^https?:\/\/\S+$/i.test(trimmed);

  const save = () => {
    if (!looksValid) {
      toast.error('Enter a full link starting with https://');
      return;
    }
    if (storeBookingLink(userId, trimmed)) toast.success(trimmed ? 'Meeting link saved' : 'Meeting link cleared');
    else toast.error('Could not save the link: this browser blocks local storage');
  };

  return (
    <Card>
      <CardContent className="py-5">
        <h2 className="text-base font-semibold text-gray-900">Meeting link</h2>
        <p className="text-sm text-gray-500 mt-0.5 mb-3">
          Your Calendly or booking link. In the Inbox, one click adds a “Book a call” line to your reply.
          Saved in this browser only.
        </p>
        <input
          type="url"
          aria-label="Meeting link"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          maxLength={BOOKING_LINK_MAX}
          placeholder="https://calendly.com/your-name/15min"
          className={`w-full px-3 py-2 bg-white border rounded-lg text-gray-900 text-sm placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-400 ${
            looksValid ? 'border-gray-300' : 'border-red-400'
          }`}
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-red-500">{looksValid ? ' ' : 'Use a full link starting with https://'}</span>
          <Button size="sm" leftIcon={<Save className="w-4 h-4" />} onClick={save}>
            Save link
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
