import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hasConversationSchema } from "./hermes-conversation-fence.ts";

interface Disposal { peer_id: string; archive_id: string; state: "pending" | "complete"; archived_messages: number }
export interface OrphanMailbox { peer_id: string; name: string; state: string; unread: number }

export function listConversationOrphans(db: Database): OrphanMailbox[] {
  if (!hasConversationSchema(db)) return [];
  return db.query<OrphanMailbox, []>(`SELECT h.peer_id,h.name,h.state,
    (SELECT COUNT(*) FROM messages m WHERE m.to_id=h.peer_id AND m.acked=0) AS unread
    FROM hermes_conversations h WHERE h.state IN ('orphaned','disposed') ORDER BY h.created_at,h.peer_id`).all();
}

function installDisposalSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS hermes_conversation_disposals (
    peer_id TEXT PRIMARY KEY,
    archive_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('pending','complete')),
    archived_messages INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS hermes_disposed_messages (
    archive_id TEXT NOT NULL, id INTEGER NOT NULL, from_id TEXT NOT NULL,
    to_id TEXT NOT NULL, text TEXT NOT NULL, sent_at TEXT NOT NULL, message_uid TEXT,
    PRIMARY KEY(archive_id,id)
  )`);
}

// Explicit operator action only. Disposed is a fence/tombstone, never an ack.
// Broker mail is archived transactionally first. Files follow an idempotent
// journal; failures remain "pending" and retain recoverable copies on both sides.
export function disposeConversationOrphan(db: Database, peerId: string, apply = false) {
  const mailbox = listConversationOrphans(db).find(row => row.peer_id === peerId);
  if (!mailbox) throw new Error("orphan_mailbox_required");
  if (!apply) return { ...mailbox, action: "would_archive_and_dispose" };
  installDisposalSchema(db);
  const disposal = db.transaction(() => {
    const old = db.query<Disposal, [string]>("SELECT * FROM hermes_conversation_disposals WHERE peer_id=?").get(peerId);
    if (old) return old;
    const row = db.query<{ state: string; owner_lease_until: number }, [string]>(
      "SELECT state,owner_lease_until FROM hermes_conversations WHERE peer_id=?",
    ).get(peerId);
    if (row?.state !== "orphaned" || row.owner_lease_until !== 0
        || db.query("SELECT 1 FROM peers WHERE id=?").get(peerId)) {
      throw new Error("orphan_must_be_released_before_disposal");
    }
    const archiveId = randomUUID();
    const archived = db.query(`INSERT INTO hermes_disposed_messages
      SELECT ?,id,from_id,to_id,text,sent_at,message_uid FROM messages WHERE to_id=? AND acked=0`)
      .run(archiveId, peerId).changes;
    db.query("UPDATE hermes_conversations SET state='disposed',updated_at=? WHERE peer_id=?").run(Date.now(), peerId);
    db.query("DELETE FROM hermes_conversation_tokens WHERE peer_id=?").run(peerId);
    db.query("INSERT INTO hermes_conversation_disposals VALUES (?,?,'pending',?)").run(peerId, archiveId, archived);
    return { peer_id: peerId, archive_id: archiveId, state: "pending" as const, archived_messages: archived };
  }).immediate();
  if (disposal.state === "complete") return { ...disposal, action: "already_disposed" };
  const roots = db.query<{ root: string }, [string]>(
    "SELECT root FROM hermes_conversation_inboxes WHERE peer_id=? ORDER BY root",
  ).all(peerId);
  if (!roots.length) throw new Error("registered_inbox_root_required");
  for (const { root } of roots) {
    if (existsSync(root)) {
      const stat = lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()
          || (stat.mode & 0o777) !== 0o700) throw new Error("unsafe_inbox_directory");
    }
    for (const suffix of [".json", ".metadata.json"]) {
      archiveInbox(join(root, `${encodeURIComponent(peerId)}${suffix}`), disposal.archive_id);
    }
  }
  db.transaction(() => {
    // Delete only exact IDs safely copied into the operator archive, never an
    // open-ended inbox sweep. A retry after either crash boundary is harmless.
    db.query(`DELETE FROM messages WHERE to_id=? AND acked=0 AND id IN
      (SELECT id FROM hermes_disposed_messages WHERE archive_id=?)`).run(peerId, disposal.archive_id);
    db.query("UPDATE hermes_conversation_disposals SET state='complete' WHERE peer_id=?").run(peerId);
  }).immediate();
  return { ...disposal, state: "complete" as const, action: "archived_and_disposed" };
}

function archiveInbox(path: string, archiveId: string): void {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("unsafe_inbox_file");
  }
  const archive = `${path}.disposed-${archiveId}`;
  try { copyFileSync(path, archive, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const copyStat = lstatSync(archive);
  if (!copyStat.isFile() || copyStat.isSymbolicLink() || copyStat.nlink !== 1
      || copyStat.uid !== stat.uid || (copyStat.mode & 0o777) !== 0o600
      || !readFileSync(path).equals(readFileSync(archive))) throw new Error("inbox_archive_mismatch");
  unlinkSync(path);
}
