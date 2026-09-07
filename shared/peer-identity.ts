import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isValidName, NAME_MAX_LEN } from "./names.ts";

export interface PeerIdentity {
  name: string;
  persona: string | null;
  repository: string;
  instructionPath: string | null;
}

const GENERIC_IDENTITIES = new Set([
  "a", "an", "the", "not", "ai", "assistant", "agent", "codex", "claude", "chatgpt",
  "droid", "gemini", "developer", "engineer", "reviewer", "runtime", "helpful",
  "senior", "expert", "software", "coding", "lead", "principal", "technical",
]);

/** Read declarations, not colleague references, YAML role slugs, or examples. */
export function extractPersona(markdown: string): string | null {
  const names = new Set<string>();
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1]![0]!;
      else if (marker[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    // An unquoted, standalone self declaration is intentional role metadata.
    const match = line.match(/^\s*You are (?:\*\*([^*]+)\*\*(?=[,.!\s]|$)|([A-Z][A-Za-z'-]*(?: [A-Z][A-Za-z'-]*){0,3})(?=[,.!]|$))/);
    if (!match) continue;
    const full = (match[1] ?? match[2])!.trim();
    if (!/^[A-Z][A-Za-z'-]*(?: [A-Z][A-Za-z'-]*){0,3}$/.test(full)) continue;
    const first = full.split(/\s+/)[0]!;
    if (GENERIC_IDENTITIES.has(first.toLowerCase())) continue;
    names.add(first.toLowerCase());
  }
  return names.size === 1 ? [...names][0]! : null;
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    }).trim() || null;
  } catch { return null; }
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Deterministic default shared by launchers and MCP adapters. No registration occurs. */
export function resolvePeerIdentity(options: { cwd: string; harness: string; explicitName?: string }): PeerIdentity {
  const cwd = canonical(options.cwd);
  const root = canonical(git(cwd, "--show-toplevel") ?? cwd);
  const common = git(cwd, "--git-common-dir");
  const commonPath = common ? canonical(isAbsolute(common) ? common : resolve(cwd, common)) : null;
  // Linked worktree directory names are instance labels, not repository names.
  const repositoryRoot = commonPath && basename(commonPath) === ".git" ? dirname(commonPath) : root;
  const repository = slug(basename(repositoryRoot)) || "repo";
  let persona: string | null = null;
  let instructionPath: string | null = null;
  let current = cwd;
  const paths: string[] = [];
  // Nearest scoped instructions may declare a persona; ordinary local rules inherit it.
  for (;;) {
    paths.push(join(current, "AGENTS.md"));
    if (current === root || dirname(current) === current) break;
    current = dirname(current);
  }
  if (repositoryRoot !== root) paths.push(join(repositoryRoot, "AGENTS.md"));
  for (const path of paths) {
    try {
      const candidate = extractPersona(readFileSync(path, "utf8"));
      if (candidate) { persona = candidate; instructionPath = path; break; }
    } catch { /* Missing or unreadable instructions fall back to repository identity. */ }
  }
  if (options.explicitName !== undefined) {
    if (!isValidName(options.explicitName)) throw new Error(`Invalid peer name: expected 1-${NAME_MAX_LEN} letters, digits, underscores or hyphens (not a UUID)`);
    return { name: options.explicitName, persona, repository, instructionPath };
  }
  const harness = slug(options.harness) || "agent";
  const prefix = persona ? `${persona}-` : "";
  // Reserve the longest animal suffix plus its separator; keep the harness visible.
  const budget = NAME_MAX_LEN - 8;
  const tail = `-${harness.slice(0, 16)}`;
  const head = prefix.length > 32 ? `${prefix.slice(0, 31).replace(/-+$/, "")}-` : prefix;
  const repo = repository.slice(0, Math.max(1, budget - head.length - tail.length)).replace(/-+$/, "") || "repo";
  return { name: `${head}${repo}${tail}`, persona, repository, instructionPath };
}

export function defaultPeerName(cwd: string, harness: string, explicitName?: string): string {
  return resolvePeerIdentity({ cwd, harness, explicitName }).name;
}
