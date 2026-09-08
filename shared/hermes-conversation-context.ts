// Host-produced MCP metadata. Tool arguments and process environment are never
// alternate identity sources: a missing context must not borrow a sibling chat.
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { appendSuffixWithinLimit, isValidName } from "./names.ts";

export interface HermesConversationContext {
  home: string;
  conversation_id: string;
  session_id: string;
  platform: string;
  backend_id: string;
  ui_session_id?: string;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()
      || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`invalid_session_context:${field}`);
  }
  return value;
}

export function canonicalProfileHome(value: unknown): string {
  const home = requiredText(value, "home");
  // The host resolves symlinks; the adapter rejects lexical aliases instead
  // of touching arbitrary filesystem paths supplied over the transport.
  if (!isAbsolute(home) || normalize(home) !== home || (home.length > 1 && home.endsWith("/"))) {
    throw new Error("invalid_session_context:home");
  }
  return home;
}

export function parseHermesConversationContext(
  meta: unknown,
  expected: { home: string; backend_id: string },
): Readonly<HermesConversationContext> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("session_context_required");
  }
  const values = meta as Record<string, unknown>;
  const home = canonicalProfileHome(values["hermes/home"]);
  const backend_id = requiredText(values["hermes/backend_id"], "backend_id");
  if (home !== expected.home || backend_id !== expected.backend_id) {
    throw new Error("session_context_owner_mismatch");
  }
  const result: HermesConversationContext = {
    home,
    backend_id,
    conversation_id: requiredText(values["hermes/conversation_id"], "conversation_id"),
    session_id: requiredText(values["hermes/session_id"], "session_id"),
    platform: requiredText(values["hermes/platform"], "platform"),
  };
  if (values["hermes/ui_session_id"] !== undefined) {
    result.ui_session_id = requiredText(values["hermes/ui_session_id"], "ui_session_id");
  }
  return Object.freeze(result);
}

export function conversationKey(context: Pick<HermesConversationContext, "home" | "conversation_id">): string {
  return JSON.stringify([canonicalProfileHome(context.home), requiredText(context.conversation_id, "conversation_id")]);
}

export function conversationName(
  context: Pick<HermesConversationContext, "home" | "conversation_id">,
  profile: string,
  hashLength = 12,
): string {
  if (!isValidName(profile) || !Number.isInteger(hashLength) || hashLength < 12 || hashLength > 64) {
    throw new Error("invalid_conversation_name");
  }
  const suffix = createHash("sha256").update(conversationKey(context)).digest("hex").slice(0, hashLength);
  return appendSuffixWithinLimit(profile, suffix);
}
