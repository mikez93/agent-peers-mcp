// T1 multiplex core. The opt-in runtime supplies strict dispatch observations;
// fixtures additionally exercise lifecycle evidence. No autonomous wake here.
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { createAsyncLock } from "./async-lock.ts";
import { CodexInboxStore } from "./codex-inbox.ts";
import { DeliveryState } from "./delivery-state.ts";
import { formatInboxBlock } from "./piggyback.ts";
import {
  canonicalProfileHome, conversationKey, parseHermesConversationContext,
  type HermesConversationContext,
} from "./hermes-conversation-context.ts";
import type { ConversationOwner } from "./hermes-conversation-bindings.ts";
import type { AckMessagesResponse, LeasedMessage } from "./types.ts";

export const HERMES_CONVERSATION_TOOLS = [
  "list_peers", "send_message", "set_summary", "check_messages",
  "wait_for_peer_messages", "rename_peer",
] as const;
export type HermesConversationTool = typeof HERMES_CONVERSATION_TOOLS[number];
export interface ConversationCredential extends ConversationOwner {
  session_token: string;
  name: string;
  inbox_root: string;
}
export interface ConversationToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}
export interface ConversationBrokerPort {
  bind(context: Readonly<HermesConversationContext>): Promise<ConversationCredential>;
  poll(owner: ConversationCredential): Promise<LeasedMessage[]>;
  ack(owner: ConversationCredential, tokens: string[]): Promise<AckMessagesResponse>;
  invoke(owner: ConversationCredential, tool: Exclude<HermesConversationTool,
    "check_messages" | "wait_for_peer_messages">, args: Readonly<Record<string, unknown>>): Promise<string>;
  release(owner: ConversationCredential, reason: "closed" | "reaped" | "orphaned"): Promise<void>;
}
interface Slot {
  lock: ReturnType<typeof createAsyncLock>;
  delivery: DeliveryState;
  pendingAcks: Map<number, string>;
  owner?: ConversationCredential;
  inbox?: CodexInboxStore;
  closing: boolean;
  calls: number;
  epoch: number;
  drained: Set<() => void>;
}
interface Waiter { deadline: number; wake: () => void }

export class HermesConversationAdapter {
  private readonly expected: { home: string; backend_id: string };
  private readonly slots = new Map<string, Slot>();
  private readonly waiters = new Set<Waiter>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly options: {
    home: string;
    backend_id: string;
    inboxRoot: string;
    broker: ConversationBrokerPort;
    now?: () => number;
    onTick?: () => void;
    onRequest?: (context: Readonly<HermesConversationContext>) => void;
  }) {
    // Runtime spawn configuration only. No generated backend fallback and no
    // borrowing identity from tool arguments, current pane, PID, or process env.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.backend_id)) {
      throw new Error("invalid_hermes_backend_id");
    }
    if (!isAbsolute(options.inboxRoot)) throw new Error("absolute_inbox_root_required");
    this.options = Object.freeze({ ...options });
    this.expected = Object.freeze({ home: canonicalProfileHome(options.home), backend_id: options.backend_id });
  }

  // Synchronous entry is intentional: snapshot K AND the causal barrier before
  // registration, a mutex, a wait, or any transport retry can yield.
  call(params: { name: string; arguments?: Record<string, unknown>; _meta?: unknown },
    signal?: AbortSignal): Promise<ConversationToolResult> {
    if (this.stopped) throw new Error("adapter_stopped");
    const context = parseHermesConversationContext(params._meta, this.expected);
    if (!HERMES_CONVERSATION_TOOLS.includes(params.name as HermesConversationTool)) {
      throw new Error("unknown_conversation_tool");
    }
    const args = Object.freeze(structuredClone(params.arguments ?? {}));
    this.options.onRequest?.(context);
    const key = conversationKey(context);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { lock: createAsyncLock(), delivery: new DeliveryState(), pendingAcks: new Map(), closing: false, calls: 0,
        epoch: 0, drained: new Set() };
      this.slots.set(key, slot);
    }
    if (slot.closing) throw new Error("conversation_closing");
    const arrival = slot.delivery.newArrival();
    slot.calls++;
    return this.run(slot, context, params.name as HermesConversationTool, args, arrival, signal)
      .finally(() => {
        slot.calls--;
        if (!slot.calls) {
          for (const notify of slot.drained) notify();
          slot.drained.clear();
        }
        if (!slot.owner && !slot.calls && !slot.closing) this.slots.delete(key);
      });
  }

  private async run(slot: Slot, context: Readonly<HermesConversationContext>,
    tool: HermesConversationTool, args: Readonly<Record<string, unknown>>,
    arrival: number, signal?: AbortSignal): Promise<ConversationToolResult> {
    const callId = randomUUID();
    let epoch = slot.epoch;
    let delivery = slot.delivery;
    const check = () => {
      signal?.throwIfAborted();
      if (slot.closing || this.stopped) throw new Error("conversation_closing");
      if (epoch !== slot.epoch) throw new Error("stale_conversation_call");
    };
    // Runs under the identity lock. Fresh host evidence, not poll heartbeats,
    // renews the binding. On expiry an authenticated new epoch may re-offer
    // persisted mail, but can never confirm an old epoch's presentation.
    const renew = async () => {
      check();
      const owner = Object.freeze(await this.options.broker.bind(context));
      if (owner.inbox_root !== this.options.inboxRoot) throw new Error("conversation_inbox_root_mismatch");
      if (owner.backend_id !== this.expected.backend_id) throw new Error("conversation_backend_mismatch");
      if (slot.owner && (slot.owner.peer_id !== owner.peer_id || slot.owner.adapter_id !== owner.adapter_id
          || slot.owner.generation > owner.generation
          || (slot.owner.generation === owner.generation && slot.owner.session_token !== owner.session_token))) {
        throw new Error("conversation_owner_mismatch");
      }
      if (slot.owner && slot.owner.generation !== owner.generation) {
        epoch = ++slot.epoch;
        slot.delivery = delivery = new DeliveryState();
        slot.pendingAcks.clear();
        arrival = 0;
      }
      // Record the authenticated owner even if close arrived during bind: its
      // drain must revoke THIS credential, not the pre-renewal credential.
      slot.owner = owner;
      slot.inbox ??= new CodexInboxStore({ peerId: owner.peer_id, rootDir: this.options.inboxRoot });
      check();
    };
    try {
      await slot.lock(renew);
      if (tool === "wait_for_peer_messages") {
        const timeout = args.timeout_ms ?? 60_000;
        if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0 || timeout > 60_000) {
          throw new Error("timeout_ms_must_be_between_0_and_60000");
        }
        const deadline = this.now() + timeout;
        while (true) {
          check();
          const found = await slot.lock(async () => {
            await renew();
            await this.poll(slot);
            return (await slot.inbox!.getUnreadMessages()).some(m =>
              !slot.delivery.isBlocked(m.id) && this.matches(m, args.from));
          });
          // Close may have notified existing waiters while this poll yielded.
          // Check again before parking, without relying on another timer tick.
          check();
          if (found || this.now() >= deadline) break;
          await this.wait(deadline, signal);
        }
      }
      let ackNotice = "";
      const messages = await slot.lock(async () => {
        await renew();
        await this.poll(slot);
        // Match the normative shared transport: a later same-identity request
        // confirms model receipt, then durable pruning and broker acknowledgment
        // reconcile separately. A lost ack response must not strand local mail.
        const queued = await slot.inbox!.getUnreadMessages();
        const eligible = new Set(slot.delivery.confirmable(arrival));
        const confirming = queued.filter(m => eligible.has(m.id));
        if (confirming.length) {
          const ids = confirming.map(m => m.id);
          await slot.inbox!.removeByIds(ids);
          slot.delivery.markConfirmed(ids);
          for (const m of confirming) this.queueAck(slot, m);
        }
        if (slot.pendingAcks.size) {
          const pending = [...slot.pendingAcks];
          const result = await this.options.broker.ack(slot.owner!, pending.map(([, token]) => token));
          // Unknown/expired is not broker success. It ends only this attempt:
          // unacknowledged broker rows still re-offer, refreshing their token.
          // Transport failure leaves every entry pending for the next call.
          for (const [id, token] of pending) if (slot.pendingAcks.get(id) === token) slot.pendingAcks.delete(id);
          if (!result.ok || result.acked !== pending.length) {
            ackNotice = `\nBroker reconciliation: ${result.acked}/${pending.length} acknowledged; unacknowledged mail remains eligible for re-offer.`;
          }
        }
        check();
        const fresh = (await slot.inbox!.getUnreadMessages()).filter(m =>
          !slot.delivery.isBlocked(m.id) && (tool !== "wait_for_peer_messages" || this.matches(m, args.from)));
        slot.delivery.draw(callId, fresh.map(m => m.id));
        const oldest = Math.min(...queued.map(m => m.id), Infinity);
        slot.delivery.pruneConfirmedBelow(Math.min(oldest, slot.delivery.maxConfirmed() - 10_000));
        return fresh;
      });
      const text = tool === "check_messages" ? "Checked inbox."
        : tool === "wait_for_peer_messages" ? (messages.length ? "Peer messages arrived." : "No matching peer messages arrived.")
        : await this.options.broker.invoke(slot.owner!, tool, args);
      check();
      const response: ConversationToolResult = {
        content: [{ type: "text", text: formatInboxBlock(messages) + text + ackNotice }],
      };
      delivery.promote(callId);
      return response;
    } catch (error) {
      delivery.rollback(callId);
      throw error;
    }
  }

  private matches(message: LeasedMessage, from: unknown): boolean {
    return from === undefined || from === message.from_id || from === message.from_name;
  }

  private async poll(slot: Slot): Promise<void> {
    const messages = await this.options.broker.poll(slot.owner!);
    if (messages.some(m => m.to_id !== slot.owner!.peer_id)) throw new Error("cross_conversation_mail_refused");
    const fresh = messages.filter(m => {
      if (!slot.delivery.isConfirmed(m.id)) return true;
      this.queueAck(slot, m);
      return false;
    });
    if (fresh.length) await slot.inbox!.queueLeasedMessages(fresh);
    const persisted = await slot.inbox!.getUnreadMessages();
    if (persisted.some(m => m.to_id !== slot.owner!.peer_id)) throw new Error("cross_conversation_inbox_refused");
  }

  private queueAck(slot: Slot, message: LeasedMessage): void {
    slot.pendingAcks.set(message.id, message.lease_token);
    // The broker remains the retry authority if this bounded process-local
    // cache is lost or evicted. A later re-offer refreshes the confirmed ID.
    while (slot.pendingAcks.size > 500) slot.pendingAcks.delete(slot.pendingAcks.keys().next().value!);
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  // One adapter-wide scheduler, never a process, polling loop, or timer per chat.
  start(): void {
    if (this.stopped) throw new Error("adapter_stopped");
    this.timer ??= setInterval(() => this.tick(), 1_000);
    this.timer.unref();
  }
  tick(): void {
    if (!this.stopped) this.options.onTick?.();
    this.wakeWaiters();
  }

  private wakeWaiters(): void {
    for (const waiter of [...this.waiters]) waiter.wake();
  }

  // T1 has no authoritative close/reap feed. Only unload an idle local slot
  // once the broker has suspended that credential's lease. Never infer ack.
  evictExpired(isExpired: (owner: ConversationCredential) => boolean): void {
    for (const [key, slot] of this.slots) {
      if (!slot.calls && !slot.closing && slot.owner && isExpired(slot.owner)) this.slots.delete(key);
    }
  }
  private wait(deadline: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", aborted);
        error ? reject(error) : resolve();
      };
      const waiter: Waiter = { deadline, wake: () => finish() };
      const aborted = () => finish(signal?.reason ?? new Error("request_aborted"));
      this.waiters.add(waiter);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
  }

  async release(meta: unknown, reason: "closed" | "reaped" | "orphaned"): Promise<void> {
    const key = conversationKey(parseHermesConversationContext(meta, this.expected));
    const slot = this.slots.get(key);
    if (!slot) return;
    if (slot.closing) throw new Error("conversation_closing");
    slot.closing = true;
    this.tick();
    if (slot.calls) await new Promise<void>(resolve => { slot.drained.add(resolve); });
    try {
      if (slot.owner) await this.options.broker.release(slot.owner, reason);
      this.slots.delete(key);
    } catch (error) {
      // Retain an unusable slot for diagnosis; never reset it to active after a
      // possibly-successful remote release. Restart/resume must reauthenticate.
      throw error;
    }
  }

  // T2 caller commits the terminal broker fence FIRST. This drains only local
  // calls/state and must not issue a second release or infer acknowledgment.
  async drainFenced(meta: unknown, owner: { peer_id: string; backend_id: string; adapter_id: string; generation: number }): Promise<void> {
    const key = conversationKey(parseHermesConversationContext(meta, this.expected));
    const slot = this.slots.get(key);
    if (!slot) return;
    if (slot.owner && (slot.owner.peer_id !== owner.peer_id || slot.owner.backend_id !== owner.backend_id
        || slot.owner.adapter_id !== owner.adapter_id || slot.owner.generation > owner.generation)) return;
    slot.closing = true;
    // Local cancellation must not depend on unrelated maintenance succeeding.
    this.wakeWaiters();
    if (slot.calls) await new Promise<void>(resolve => { slot.drained.add(resolve); });
    if (this.slots.get(key) === slot) this.slots.delete(key);
  }

  canWake(context: Readonly<HermesConversationContext>): boolean {
    return !this.stopped && context.home === this.expected.home && context.backend_id === this.expected.backend_id
      && !this.slots.get(conversationKey(context))?.closing;
  }

  resources(): { identities: number; calls: number; waiters: number; timers: number; pendingAcks: number } {
    return { identities: this.slots.size, calls: [...this.slots.values()].reduce((n, s) => n + s.calls, 0),
      waiters: this.waiters.size, timers: this.timer ? 1 : 0,
      pendingAcks: [...this.slots.values()].reduce((n, s) => n + s.pendingAcks.size, 0) };
  }

  // Backend loss is not explicit close and not acknowledgment. Durable inboxes
  // and broker bindings survive; their owner leases expire independently.
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.tick();
    await Promise.all([...this.slots.values()].map(async slot => {
      if (slot.calls) await new Promise<void>(resolve => { slot.drained.add(resolve); });
    }));
    this.slots.clear();
  }
}
