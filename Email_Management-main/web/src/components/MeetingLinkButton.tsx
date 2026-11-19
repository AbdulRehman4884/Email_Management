import { CalendarClock } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { loadBookingLink, bookingLineText } from '../lib/composerStorage';

/** Inbox composer: one click drops the saved "Book a call: <link>" line into the reply. Hidden when no link is set. */
export function MeetingLinkButton({ onInsert }: { onInsert: (line: string) => void }) {
  const userId = useAuthStore((s) => s.user?.id);
  const link = userId ? loadBookingLink(userId) : '';
  if (!link) return null;
  return (
    <button
      type="button"
      onClick={() => onInsert(bookingLineText(link))}
      title={`Insert your meeting link: ${link}`}
      aria-label="Insert meeting link"
      className="p-2 flex-shrink-0 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
    >
      <CalendarClock className="w-4 h-4" aria-hidden />
    </button>
  );
}
