#!/usr/bin/env bun
// Explicit-path operator surface, no live defaults, broker start, or migration.
import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { HermesConversationBindings } from "./shared/hermes-conversation-bindings.ts";
import { hasConversationSchema } from "./shared/hermes-conversation-fence.ts";
import { disposeConversationOrphan, listConversationOrphans } from "./shared/hermes-conversation-orphans.ts";

const help = `bin: hermes-conversations-cli.ts
description: Inspect saved Hermes mailboxes or explicitly archive an orphan.
commands:
  bun hermes-conversations-cli.ts status --db /absolute/broker.db
  bun hermes-conversations-cli.ts orphans --db /absolute/broker.db
  bun hermes-conversations-cli.ts inspect <peer-id> --db /absolute/broker.db
  bun hermes-conversations-cli.ts dispose <peer-id> --db /absolute/broker.db [--apply]
dispose: Dry-run by default. --apply archives broker mail and all registered inboxes; never acknowledges mail.
flags: --db (required absolute existing database), --apply (dispose only), --help`;

export function runConversationCli(argv: string[]): number {
  if (argv.length === 1 && ["--version", "-v", "-V"].includes(argv[0]!)) { console.log("0.1.0"); return 0; }
  if (argv.includes("--help")) { console.log(help); return 0; }
  const [command, ...args] = argv;
  if (!["status", "orphans", "inspect", "dispose"].includes(command ?? "")) {
    console.log(`error: "command must be status, orphans, inspect, or dispose"\n${help}`); return 2;
  }
  let dbPath: string | undefined;
  let apply = false;
  let peerId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--db" && dbPath === undefined) dbPath = args[++i];
    else if (arg === "--apply" && command === "dispose" && !apply) apply = true;
    else if (["dispose", "inspect"].includes(command!) && !arg.startsWith("-") && peerId === undefined) peerId = arg;
    else { console.log(`error: ${JSON.stringify(`unknown or duplicate argument: ${arg}`)}\n${help}`); return 2; }
  }
  if (!dbPath || !isAbsolute(dbPath) || (["dispose", "inspect"].includes(command!) && !peerId)) {
    console.log(`error: "absolute --db and inspect/dispose peer-id are required"\n${help}`); return 2;
  }
  let db: Database | undefined;
  try {
    const stat = lstatSync(dbPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid!()
        || (stat.mode & 0o777) !== 0o600) throw new Error("database must be owned regular file with mode 0600");
    db = new Database(dbPath, apply ? { readwrite: true, create: false } : { readonly: true, create: false });
    if (command === "status") {
      const counts = hasConversationSchema(db) ? new HermesConversationBindings(db).status()
        : { active: 0, dormant: 0, orphaned: 0, disposed: 0 };
      for (const [key, value] of Object.entries(counts)) console.log(`${key}: ${value}`);
    } else if (command === "inspect") {
      const row = hasConversationSchema(db) ? new HermesConversationBindings(db).get(peerId!) : null;
      if (!row) throw new Error("conversation_binding_not_found");
      // Actual broker state, not model self-report. Omit credentials, mailbox
      // bodies and status prose; only identity/ordering evidence is disclosed.
      const { peer_id, home, conversation_id, current_session_id, backend_id, adapter_id,
        generation, lifecycle_generation, observed_at, state } = row;
      for (const [key, value] of Object.entries({ peer_id, home, conversation_id, current_session_id,
        backend_id, adapter_id, generation, lifecycle_generation, observed_at, state })) {
        console.log(`${key}: ${JSON.stringify(value)}`);
      }
    } else if (command === "orphans") {
      const rows = listConversationOrphans(db);
      console.log(`mailboxes[${rows.length}]{peer_id,state,unread}:`);
      for (const row of rows) console.log(`  ${JSON.stringify(row.peer_id)},${row.state},${row.unread}`);
      console.log(`count: ${rows.length}`);
    } else {
      const result = disposeConversationOrphan(db, peerId!, apply);
      for (const [key, value] of Object.entries(result)) console.log(`${key}: ${JSON.stringify(value)}`);
    }
    return 0;
  } catch (error) {
    console.log(`error: ${JSON.stringify(error instanceof Error ? error.message : "mailbox operation failed")}`);
    return 1;
  } finally { db?.close(); }
}

if (import.meta.main) process.exitCode = runConversationCli(process.argv.slice(2));
