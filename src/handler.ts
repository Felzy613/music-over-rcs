import { joinLists, type Bot } from './bot.ts';
import type { UserEvent } from './rbm/webhook.ts';
import type { Reply } from './types.ts';

export interface HandlerDeps {
  bot: Bot;
  rbm: {
    send(to: string, reply: Reply): Promise<void>;
    sendEvent(to: string, eventType: 'IS_TYPING' | 'READ', messageId?: string): Promise<void>;
  };
  /** Ignore events for other agents (a partner-level webhook is shared by all of a partner's agents). */
  agentId?: string;
  /** If set, only these E.164 numbers get answers. */
  allowedSenders?: ReadonlySet<string>;
  log?: (line: string) => void;
}

const SEEN_LIMIT = 1000;
const ERROR_NOTICE = 'Something went wrong on my side. Please try again in a moment.';
const REJECTED_NOTICE = "Google wouldn't accept that file, so I couldn't send it.";

/** Keeps only the last four digits, so logs don't carry full phone numbers. */
export const mask = (phone: string): string => phone.replace(/\d(?=\d{4})/g, '*');

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Turns a webhook event into: read receipt, typing indicator, then the bot's replies sent in order. */
export function createEventHandler(deps: HandlerDeps): (event: UserEvent) => Promise<void> {
  const log = deps.log ?? (() => {});
  const seen = new Set<string>();

  async function attempt(what: string, action: () => Promise<void>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (err) {
      log(`${what} failed: ${errorText(err)}`);
      return false;
    }
  }

  return async (event) => {
    const from = event.senderPhoneNumber;
    const messageId = event.messageId;
    if (!from || !messageId) return;
    if (deps.agentId && event.agentId && event.agentId !== deps.agentId) return;

    // Receipts, shared files, locations and the like carry neither text nor a chip tap.
    const text = typeof event.text === 'string' ? event.text : undefined;
    const postback = event.suggestionResponse?.postbackData;
    if (text === undefined && postback === undefined) return;

    if (deps.allowedSenders && !deps.allowedSenders.has(from)) {
      log(`ignored a message from ${mask(from)} (not in ALLOWED_SENDERS)`);
      return;
    }

    // Google delivers at least once, so the same user message can arrive twice.
    const key = `${from}:${messageId}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);

    log(`<- ${mask(from)} ${postback !== undefined ? `tapped ${postback}` : JSON.stringify(text)}`);
    await attempt('read receipt', () => deps.rbm.sendEvent(from, 'READ', messageId));
    await attempt('typing indicator', () => deps.rbm.sendEvent(from, 'IS_TYPING'));

    let replies: Reply[];
    try {
      replies = await deps.bot.handle({ from, messageId, text, postback });
    } catch (err) {
      log(`bot error: ${errorText(err)}`);
      replies = [{ kind: 'text', text: ERROR_NOTICE }];
    }

    // Options are tappable chips here, so a list stays one message.
    for (const reply of joinLists(replies)) {
      if (await attempt(`sending ${reply.kind} reply`, () => deps.rbm.send(from, reply))) continue;
      if (reply.kind === 'audio') {
        await attempt('sending failure notice', () => deps.rbm.send(from, { kind: 'text', text: REJECTED_NOTICE }));
      }
      break;
    }
  };
}
