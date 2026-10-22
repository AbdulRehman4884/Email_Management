/**
 * CRM events: one entry point that every part of the app calls when something happens to a lead.
 *
 * The rule engine (ruleEngine.ts) is loaded and registered automatically on the first event, in
 * every process (API, email worker, IMAP worker, CRM worker). Later steps (scoring) add their own
 * handlers with onCrmEvent(). Handlers run one after another; an error in one handler is logged and
 * never reaches the caller.
 *
 * Call sites usually use emit.ts (emitForRecipient), which finds the contact first.
 */
export type CrmEventType =
  | 'email_sent'
  | 'email_delivered'
  | 'email_opened'
  | 'reply_received'
  | 'reply_labeled'
  | 'bounced'
  | 'unsubscribed'
  | 'follow_up_sent'
  | 'manual_move'
  | 'time_tick';

export interface CrmEvent {
  type: CrmEventType;
  /** Optional details, e.g. { replyId, label, previousLabel, source } for reply events. */
  data?: Record<string, unknown>;
  at?: Date;
}

export type CrmEventHandler = (userId: number, contactId: number, event: CrmEvent) => Promise<void> | void;

const handlers: CrmEventHandler[] = [];

let builtins: Promise<void> | null = null;
/** Loads the rule engine once per process (dynamic import keeps this file free of import cycles). */
function ensureBuiltinHandlers(): Promise<void> {
  if (!builtins) {
    builtins = import('./ruleEngine.js')
      .then((m) => {
        handlers.unshift(m.handleCrmEvent);
      })
      .catch((err) => {
        console.error('[crm] could not load the rule engine:', err);
      });
  }
  return builtins;
}

/** Register a handler (rule engine, scoring, ...). Returns a function that removes it. */
export function onCrmEvent(handler: CrmEventHandler): () => void {
  handlers.push(handler);
  return () => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  };
}

export async function emitCrmEvent(userId: number, contactId: number, event: CrmEvent): Promise<void> {
  await ensureBuiltinHandlers();
  const full: CrmEvent = { ...event, at: event.at ?? new Date() };
  for (const handler of [...handlers]) {
    try {
      await handler(userId, contactId, full);
    } catch (err) {
      console.error(`[crm] event handler failed for ${full.type} (contact ${contactId}):`, err);
    }
  }
}
