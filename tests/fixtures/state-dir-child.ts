import { WakeLaunchClaimStore } from "../../shared/wake-launch-claims.ts";
import { CodexInboxStore } from "../../shared/codex-inbox.ts";
const claim = await new WakeLaunchClaimStore().findMatching({ cwd: "/repo", tty: null });
const unread = await new CodexInboxStore({ peerId: "target" }).getUnreadMessages();
console.log(JSON.stringify({ claimId: claim?.claim_id, unread: unread.length }));
