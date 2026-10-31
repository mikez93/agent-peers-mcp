// Peer addressing helpers shared by the broker and clients.
//
// An address is `name[@host][/chat]`:
//   - name: an exact peer name, a peer UUID, or a persona ("marco"), matched
//     case-insensitively against the leading tokens of peer names;
//   - host: a federation machine (handled by the federation layer);
//   - chat: a Hermes chat inside that peer, by exact title or session ID.
// Peer names and hosts never contain "/" or "@", so the first "/" starts the
// chat part, which may itself contain any characters.

export interface ParsedAddress {
  name: string;
  host: string | null;
  chat: string | null;
}

export function parseAddress(raw: string): ParsedAddress {
  const text = raw.trim();
  const slash = text.indexOf("/");
  const left = slash === -1 ? text : text.slice(0, slash);
  const chatPart = slash === -1 ? null : text.slice(slash + 1).trim();
  const at = left.indexOf("@");
  const name = (at === -1 ? left : left.slice(0, at)).trim();
  const host = at === -1 ? null : left.slice(at + 1).trim() || null;
  return { name, host, chat: chatPart ? chatPart : null };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The persona a peer row carries. An explicit persona (sent by newer clients
 * from the AGENTS.md declaration) wins. Otherwise it is the first token of a
 * generated `persona-repo-harness` name or an explicit `persona-hermes` name.
 * A `repo-harness` fallback name (no persona declared) has none.
 */
/** Leading name tokens that name a harness or model, never a persona
 *  (e.g. "claude-sender", "codex-receiver", old "opus-*" sessions). */
const HARNESS_WORDS = new Set(["claude", "codex", "hermes", "droid", "opus", "sonnet", "haiku", "fable", "gemini", "agent", "peer"]);

export function personaOf(row: { name: string; persona?: string | null; git_root?: string | null; cwd?: string | null }): string | null {
  if (row.persona && row.persona.trim()) return slug(row.persona) || null;
  const name = row.name.toLowerCase();
  const first = name.split("-")[0] ?? "";
  if (!first || /^[0-9a-f]{8}$/.test(first) || HARNESS_WORDS.has(first)) return null;
  const root = row.git_root || row.cwd || "";
  const repo = slug(root.split("/").filter(Boolean).pop() ?? "");
  if (repo && (name === repo || name.startsWith(`${repo}-`))) return null;
  return first;
}

export function displayPersona(persona: string): string {
  return persona.charAt(0).toUpperCase() + persona.slice(1);
}

/** Prefix a status with the persona so peers are findable by name. */
export function withPersonaPrefix(summary: string, persona: string | null): string {
  if (!persona) return summary;
  const label = displayPersona(persona);
  const trimmed = (summary ?? "").trim();
  if (!trimmed) return `${label}: (no status set)`;
  const lower = trimmed.toLowerCase();
  const p = persona.toLowerCase();
  if (lower.startsWith(p) && (lower.length === p.length || !/[a-z0-9]/.test(lower.charAt(p.length)))) {
    return summary;
  }
  return `${label}: ${trimmed}`;
}

/** True when `query` names this peer by persona or leading name tokens. */
export function matchesPersonaQuery(name: string, query: string): boolean {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  return n === q || n.startsWith(`${q}-`);
}
