"""Agent Peers desktop wake: wake a Hermes chat that is open in this process.

Why: a chat Mike has open in Hermes Desktop is hosted by a Desktop backend (an Ink
TUI / ``hermes serve`` process) that holds the chat's single-writer slot, so the
Agent Peers gateway wake (shared/hermes-chat-wake.ts) must wait until he closes
it. Hermes's supported plugin API, ``ctx.inject_message(..., session_key=...)``,
queues a prompt on a session hosted in the plugin's own process: an idle session
starts a turn, a busy one only queues (it never interrupts). This plugin uses that
API from inside the hosting process. No credential, tunnel or second client.

Scope and safety (Marco AP10789, AP10806; Kepler §19-§20 as amended AP10808):
- Inert until opted in: ``<state>/chat-wake/desktop-enabled`` must list
  ``<profile> <chat-key>`` (one throwaway chat) or ``<profile> *``, and the
  profile config must set ``plugins.entries.agent-peers-desktop-wake.
  allow_gateway_injection: true``. The exact chat's opt-in, the kill switches and
  the process role are re-checked after the broker read, before the intent is
  written, and again immediately before the inject.
- Only chat-tagged mail (``to_chat``) for this profile's durable peer
  ``<profile>-hermes``; the general mailbox is never woken here. Only chats whose
  registry slot this pid holds (whole compression lineage; the registry entry's
  ``session_id`` is the inject target). It refuses in a classic CLI process, in a
  process with a messaging-gateway injector, and with no TUI/Desktop host.
- Bodyless, labelled automation text; the normal MCP ``check_messages`` reads and
  confirms. Nothing here acks mail.
- ``inject_message() == True`` only means queued/accepted. A durable attempt is
  written before the call (intent) and after it (accepted / not_submitted /
  unknown) into the per-chat ledger the gateway driver uses, under the same
  ``.lock`` (atomic owner publication, owner-checked release, no reaping of a live
  holder). While an attempt is open neither executor wakes that chat.
- Settlement uses positive, correlated turn-lifecycle evidence only. The plugin's
  ``pre_llm_call`` hook records "started" and its ``post_llm_call`` hook (fired
  once per uninterrupted turn with a final response, after the session is
  persisted) records "ended", each only when the turn's own ``user_message``
  carries this attempt's marker and its ``session_id`` is this chat's. Transcript
  rows, finish_reason, absence and timeouts never settle anything. Anything
  uncertain or unreadable is ``unknown`` and blocks every re-wake of the chat
  until an operator runs ``cli.ts hermes-desktop-clear``. Cancellation is kept
  through settlement.
- Kill switches: ``AGENT_PEERS_WAKE_DISABLED=1``, ``<state>/disabled`` and
  ``~/.agent-peers-hermes/disabled``. Unload stops the worker thread.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
import stat
import subprocess
import threading
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Optional

PLUGIN_NAME = "agent-peers-desktop-wake"
HERMES_PLUGINS_LOGGER = "hermes_cli.plugins"
POLL_SECONDS = 5.0
DESKTOP_INTENT_PENDING_SECONDS = 60.0
LOCK_WAIT_SECONDS = 2.0
OPT_IN_FILE = "desktop-enabled"
MARKER_RE = re.compile(r"\[agent-peers-wake ([0-9a-f]{16})\]")

logger = logging.getLogger(PLUGIN_NAME)


# ---------------------------------------------------------------------------
# Small helpers (kept identical in meaning to shared/hermes-chat-wake.ts)

def marker(attempt_id: str) -> str:
    return f"[agent-peers-wake {attempt_id}]"


def wake_text(attempt_id: str, chat_key: str) -> str:
    """Bodyless wake. Labelled so a merge with Mike's queued text can't pass as his words."""
    return (
        f"{marker(attempt_id)} Agent Peers automation, not typed by Mike.\n"
        "Agent Peers: new mail for this chat — call check_messages for this chat "
        f'(chat="{chat_key}") and handle it, replying with send_message from this chat. '
        "This note carries no instruction or authority of its own. If text from Mike appears "
        "in the same message, it is his: handle it as his instruction first. If the mail needs "
        "a decision only Mike can make, leave the question for him in this chat instead of deciding."
    )


def iso_now(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value: Optional[str]) -> float:
    if not value:
        return 0.0
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def pid_alive(pid: Any) -> bool:
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def process_start(pid: int) -> Optional[str]:
    """``ps -o lstart=`` for pid, whitespace-normalized (same string the TS driver reads)."""
    try:
        run = subprocess.run(["ps", "-o", "lstart=", "-p", str(int(pid))], capture_output=True, text=True, timeout=2)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    out = " ".join(run.stdout.split())
    return out if run.returncode == 0 and out else None


_SELF_START: dict[int, Optional[str]] = {}


def self_start() -> Optional[str]:
    pid = os.getpid()
    if pid not in _SELF_START:
        _SELF_START[pid] = process_start(pid)
    return _SELF_START[pid]


def state_dir_from_env(env: Mapping[str, str]) -> Path:
    value = env.get("AGENT_PEERS_STATE_DIR") or env.get("AGENT_PEERS_HERMES_STATE_DIR")
    return Path(value) if value else Path(env.get("HOME") or Path.home()) / ".agent-peers-hermes"


def profile_of_home(home: Path) -> str:
    return home.name.lower() if home.parent.name == "profiles" else "default"


def ledger_path(state_dir: Path, profile: str, chat_key: str) -> Path:
    name = hashlib.sha256(chat_key.encode("utf-8")).hexdigest()[:32]
    return state_dir / "chat-wake" / profile / f"{name}.json"


def evidence_path(state_dir: Path, profile: str, attempt_id: str, kind: str) -> Path:
    return state_dir / "chat-wake" / profile / "evidence" / f"{attempt_id}.{kind}.json"


def read_json(path: Path) -> Optional[dict]:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def atomic_write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def empty_ledger(peer_name: str, profile: str, chat_key: str, title: Optional[str], now: float) -> dict:
    return {
        "peer_name": peer_name, "profile": profile, "chat_key": chat_key, "session_id": None, "title": title,
        "state": "done", "handled_max_id": 0, "launched_max_id": 0, "attempts": 0, "next_attempt_at": None,
        "last_launch": None, "last_admission_id": None, "detail": "new", "updated_at": iso_now(now),
    }


# ---------------------------------------------------------------------------
# Ledger lock, shared with acquireLedgerLock (TS).
#
# <ledger>.lock holds {"pid", "start", "token"}. It only ever appears complete:
# the owner writes a private temp file and link()s it into place (link fails if
# the lock exists). A holder is reaped only when its pid is dead, or alive but
# started at a different time (pid reuse); never on age. Unreadable or foreign
# content counts as a live holder. Reaping renames the lock aside and restores it
# if a fresh owner took it in between. Release removes the lock only if it still
# carries the owner's token.

def _parse_owner(text: str) -> Optional[dict]:
    try:
        value = json.loads(text)
    except ValueError:
        return None
    if isinstance(value, dict) and isinstance(value.get("pid"), int) and isinstance(value.get("token"), str):
        return value
    return None


def _holder_gone(owner: dict) -> bool:
    if not pid_alive(owner["pid"]):
        return True
    recorded = owner.get("start")
    if not isinstance(recorded, str) or not recorded:
        return False
    current = process_start(owner["pid"])
    return current is not None and current != recorded


def _reap(lock: Path, judged: str) -> None:
    aside = lock.with_name(f"{lock.name}.reap.{os.getpid()}.{uuid.uuid4().hex}")
    try:
        os.rename(lock, aside)
    except OSError:
        return
    try:
        taken = aside.read_text("utf-8")
    except OSError:
        taken = None
    if taken != judged:
        try:
            os.link(aside, lock)  # a fresh owner took it between our read and the rename: give it back
        except OSError:
            pass
    try:
        aside.unlink()
    except OSError:
        pass


def acquire_lock(ledger: Path, wait: float = LOCK_WAIT_SECONDS) -> Optional[Callable[[], None]]:
    lock = ledger.with_name(ledger.name + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    me = {"pid": os.getpid(), "start": self_start(), "token": uuid.uuid4().hex}
    body = json.dumps(me)
    deadline = time.monotonic() + wait
    while True:
        tmp = lock.with_name(f"{lock.name}.{os.getpid()}.{me['token']}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(body)
            try:
                os.link(tmp, lock)
                acquired = True
            except FileExistsError:
                acquired = False
        finally:
            try:
                tmp.unlink()
            except OSError:
                pass
        if acquired:
            def release() -> None:
                try:
                    if lock.read_text("utf-8") != body:
                        return  # not ours any more; never remove another owner's lock
                    lock.unlink()
                except OSError:
                    pass
            return release
        try:
            text = lock.read_text("utf-8")
        except FileNotFoundError:
            continue
        except OSError:
            text = ""
        owner = _parse_owner(text)
        if owner is not None and _holder_gone(owner):
            _reap(lock, text)
            continue
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.025)


# ---------------------------------------------------------------------------
# Hermes state (read-only): lineage and the active-session registry

def open_ro(path: Path) -> Optional[sqlite3.Connection]:
    if not path.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2.0)
    except sqlite3.Error:
        return None
    conn.row_factory = sqlite3.Row
    return conn


def _row(db: sqlite3.Connection, sid: str) -> Optional[sqlite3.Row]:
    return db.execute(
        "SELECT id, source, parent_session_id, end_reason, model_config FROM sessions WHERE id = ?", (sid,)
    ).fetchone()


def _is_fork_child(row: sqlite3.Row) -> bool:
    if row["source"] == "tool":
        return True
    try:
        cfg = json.loads(row["model_config"]) if row["model_config"] else None
    except ValueError:
        return False
    if not isinstance(cfg, dict):
        return False
    markers = [cfg.get("_branched_from"), cfg.get("_delegate_from"), cfg.get("_reset_from")]
    parent = row["parent_session_id"]
    return parent in markers if parent else any(m is not None for m in markers)


def lineage_root(db: sqlite3.Connection, sid: str) -> str:
    row = _row(db, sid)
    if row is None:
        return sid
    seen = {row["id"]}
    while row["parent_session_id"] and not _is_fork_child(row):
        parent = _row(db, row["parent_session_id"])
        if parent is None or parent["end_reason"] != "compression" or parent["id"] in seen:
            break
        seen.add(parent["id"])
        row = parent
    return row["id"]


def lineage_ids(db: sqlite3.Connection, root: str) -> list[str]:
    ids = [root]
    current = _row(db, root)
    while current is not None and current["end_reason"] == "compression":
        children = db.execute(
            "SELECT id, source, parent_session_id, end_reason, model_config FROM sessions "
            "WHERE parent_session_id = ? ORDER BY started_at ASC", (current["id"],),
        ).fetchall()
        nxt = next((c for c in children if not _is_fork_child(c)), None)
        if nxt is None or nxt["id"] in ids:
            break
        ids.append(nxt["id"])
        current = nxt
    return ids


def chat_lineage(home: Path, chat_key: str) -> Optional[list[str]]:
    """Every stored session of the chat, root to tip; None when state.db can't be read."""
    db = open_ro(home / "state.db")
    if db is None:
        return None
    try:
        return lineage_ids(db, lineage_root(db, chat_key))
    except sqlite3.Error:
        return None
    finally:
        db.close()


def registry_entries(home: Path) -> Optional[list[dict]]:
    """Registry entries; [] when the file is absent; None when it exists but can't be read."""
    path = home / "runtime" / "active_sessions.json"
    try:
        raw = json.loads(path.read_text("utf-8"))
    except FileNotFoundError:
        return []
    except (OSError, ValueError):
        return None
    entries = raw.get("entries") if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        return None
    return [e for e in entries if isinstance(e, dict)]


def hosted_session(entries: list[dict], ids: list[str], pid: int) -> Optional[str]:
    """The registry ``session_id`` of this chat whose slot ``pid`` holds (the inject target)."""
    wanted = set(ids)
    for entry in entries:
        try:
            entry_pid = int(entry.get("pid"))
        except (TypeError, ValueError):
            continue
        if entry_pid == pid and str(entry.get("session_id") or "") in wanted:
            return str(entry["session_id"])
    return None


# ---------------------------------------------------------------------------
# Evidence and settlement (same rules as classifyDesktopAttempt in TS)

def read_evidence(state_dir: Path, profile: str, attempt_id: str) -> Optional[dict]:
    """{"started": dict|None, "ended": dict|None}, or None when evidence exists but can't be read."""
    out: dict[str, Optional[dict]] = {}
    for kind in ("started", "ended"):
        path = evidence_path(state_dir, profile, attempt_id, kind)
        try:
            value = json.loads(path.read_text("utf-8"))
        except FileNotFoundError:
            out[kind] = None
            continue
        except (OSError, ValueError):
            return None
        if not isinstance(value, dict) or value.get("attempt_id") != attempt_id:
            return None
        out[kind] = value
    return out


def classify_attempt(evidence: Optional[dict], attempt: dict, host_alive: bool,
                     held: Optional[bool], now: float) -> str:
    """handled | running | pending | unknown. Only correlated lifecycle evidence settles."""
    if evidence is None:
        return "unknown"  # evidence exists but cannot be read: never a negative
    if evidence.get("ended"):
        return "handled"
    if evidence.get("started"):
        return "running" if host_alive else "unknown"
    if attempt.get("state") == "unknown" or not host_alive:
        return "unknown"
    if attempt.get("state") == "intent":
        return "pending" if now - parse_iso(attempt.get("created_at")) <= DESKTOP_INTENT_PENDING_SECONDS else "unknown"
    if held is None:
        return "unknown"  # registry unreadable
    return "pending" if held else "unknown"


def apply_verdict(ledger: dict, verdict: str, now: float) -> tuple[str, str]:
    """Apply a verdict in place. A cancelled ledger stays cancelled (stopping wakes is independent)."""
    attempt = ledger["desktop_attempt"]
    short = attempt["attempt_id"][:8]
    if verdict == "handled":
        ledger["handled_max_id"] = max(int(ledger.get("handled_max_id") or 0), int(attempt["max_id"]))
        ledger["launched_max_id"] = max(int(ledger.get("launched_max_id") or 0), int(attempt["max_id"]))
        ledger["attempts"] = 0
        ledger["next_attempt_at"] = None
        ledger["last_desktop_attempt"] = {**attempt, "outcome": "handled", "resolved_at": iso_now(now)}
        ledger["desktop_attempt"] = None
        state, detail = "done", f"desktop wake {short} reached the end of its own turn"
    elif verdict == "unknown":
        attempt["state"] = "unknown"
        state, detail = "desktop_unknown", f"desktop wake {short} outcome unknown; no re-wake until cli.ts hermes-desktop-clear"
    elif verdict == "running":
        state, detail = "waiting_desktop", f"desktop wake {short} turn started in pid {attempt['host_pid']}"
    else:
        state, detail = "waiting_desktop", f"desktop wake {short} is {attempt['state']} in pid {attempt['host_pid']}"
    if ledger.get("state") == "cancelled":
        return "cancelled", f"wakes stopped by operator; {detail}"
    return state, detail


# ---------------------------------------------------------------------------
# Broker (read-only: the chat inbox; mail is read and acked by the normal MCP)

def read_secret(path: Path) -> Optional[str]:
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        return None
    if hasattr(os, "getuid") and (st.st_uid != os.getuid() or (st.st_mode & 0o777) != 0o600):
        return None
    try:
        secret = path.read_text("utf-8").strip()
    except OSError:
        return None
    return secret if len(secret) >= 32 else None


def fetch_chat_inbox(env: Mapping[str, str]) -> Optional[list[dict]]:
    secret_path = env.get("AGENT_PEERS_SECRET_PATH") or str(Path(env.get("HOME") or Path.home()) / ".agent-peers-secret")
    secret = read_secret(Path(secret_path))
    if not secret:
        return None
    port = env.get("AGENT_PEERS_PORT") or "7900"
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/chat-inbox", data=b"{}", method="POST",
        headers={"Content-Type": "application/json", "X-Agent-Peers-Secret": secret},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=3) as response:
        entries = json.load(response).get("entries")
    return entries if isinstance(entries, list) else None


# ---------------------------------------------------------------------------
# The worker

class _InjectFailureCapture(logging.Handler):
    """Hermes logs and returns False when the TUI host raised; the prompt may already be queued."""

    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.thread = threading.get_ident()
        self.failed = False

    def emit(self, record: logging.LogRecord) -> None:
        if record.thread == self.thread and "scheduling failed" in record.getMessage():
            self.failed = True


def _message_text(message: Any) -> str:
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        parts = []
        for part in message:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
            elif isinstance(part, str):
                parts.append(part)
        return "\n".join(parts)
    return "" if message is None else str(message)


class DesktopWake:
    def __init__(self, ctx: Any, *, env: Optional[Mapping[str, str]] = None, clock: Callable[[], float] = time.time,
                 pid: Optional[int] = None, alive: Callable[[Any], bool] = pid_alive,
                 inbox: Optional[Callable[[], Optional[list[dict]]]] = None,
                 start_of: Callable[[int], Optional[str]] = process_start) -> None:
        self.ctx = ctx
        self.manager = ctx._manager
        self.home = Path(self.manager.home_path)
        self.profile = profile_of_home(self.home)
        self.peer_name = f"{self.profile}-hermes"
        self.env = env if env is not None else os.environ
        self.clock = clock
        self.pid = pid if pid is not None else os.getpid()
        self.alive = alive
        self.start_of = start_of
        self.host_start = start_of(self.pid) if pid is None else None
        self.inbox = inbox if inbox is not None else (lambda: fetch_chat_inbox(self.env))
        self.stop = threading.Event()
        self.thread: Optional[threading.Thread] = None
        self._last_note: Optional[str] = None

    # -- gates ----------------------------------------------------------------

    @property
    def state_dir(self) -> Path:
        return state_dir_from_env(self.env)

    def kill_reason(self) -> Optional[str]:
        if self.stop.is_set():
            return "plugin unloaded"
        if self.env.get("AGENT_PEERS_WAKE_DISABLED") == "1":
            return "AGENT_PEERS_WAKE_DISABLED=1"
        home = Path(self.env.get("HOME") or Path.home())
        for flag in (self.state_dir / "disabled", home / ".agent-peers-hermes" / "disabled"):
            if flag.exists():
                return f"{flag} exists"
        return None

    def role_reason(self) -> Optional[str]:
        if getattr(self.manager, "_cli_ref", None) is not None:
            return "classic CLI process (inject would use the interrupt queue)"
        if getattr(self.manager, "has_gateway_message_injector", False):
            return "messaging gateway process (a TUI miss would fall through to the gateway)"
        if not getattr(self.manager, "has_tui_message_injector", False):
            return "no Desktop/TUI host in this process"
        return None

    def opt_in(self) -> tuple[bool, set[str]]:
        """``<profile> *`` wakes every chat; ``<profile> <chat-key>`` wakes one. Anything else: inert."""
        try:
            text = (self.state_dir / "chat-wake" / OPT_IN_FILE).read_text("utf-8")
        except OSError:
            return False, set()
        every, chats = False, set()
        for raw in text.splitlines():
            words = raw.split("#", 1)[0].split()
            if len(words) != 2 or words[0].lower() != self.profile:
                continue
            if words[1] == "*":
                every = True
            else:
                chats.add(words[1])
        return every, chats

    def injection_allowed(self) -> bool:
        check = getattr(self.ctx, "_gateway_injection_allowed", None)
        try:
            return bool(check()) if callable(check) else True
        except Exception:
            return False

    def refusal(self, chat: Optional[str] = None) -> Optional[str]:
        """Every gate, fresh. With a chat: that exact chat must still be opted in."""
        reason = self.kill_reason() or self.role_reason()
        if reason:
            return reason
        every, chats = self.opt_in()
        if not every and not chats:
            return "not opted in"
        if chat is not None and not every and chat not in chats:
            return f"chat {chat} is not opted in"
        if not self.injection_allowed():
            return f"set plugins.entries.{PLUGIN_NAME}.allow_gateway_injection: true"
        return None

    def note(self, message: str) -> None:
        if message != self._last_note:
            logger.info("%s [%s]: %s", PLUGIN_NAME, self.profile, message)
            self._last_note = message

    # -- lifecycle evidence (hooks) ---------------------------------------------

    def _open_attempt(self, attempt_id: str) -> Optional[dict]:
        folder = self.state_dir / "chat-wake" / self.profile
        try:
            names = [n for n in os.listdir(folder) if n.endswith(".json")]
        except OSError:
            return None
        for name in names:
            attempt = (read_json(folder / name) or {}).get("desktop_attempt")
            if isinstance(attempt, dict) and attempt.get("attempt_id") == attempt_id:
                return attempt
        return None

    def _correlated(self, session_id: Any, user_message: Any) -> list[dict]:
        """Open attempts of this process whose marker is in this turn's own prompt and whose chat is this session."""
        found = []
        for attempt_id in set(MARKER_RE.findall(_message_text(user_message))):
            attempt = self._open_attempt(attempt_id)
            if attempt is None or attempt.get("host_pid") != self.pid:
                continue
            ids = chat_lineage(self.home, attempt["chat_key"]) or [attempt["chat_key"]]
            if str(session_id) not in set(ids) | {attempt["session_key"]}:
                continue
            found.append(attempt)
        return found

    def _write_evidence(self, attempt: dict, kind: str, turn_id: Any, session_id: Any) -> None:
        path = evidence_path(self.state_dir, self.profile, attempt["attempt_id"], kind)
        if path.exists():
            return
        atomic_write_json(path, {
            "attempt_id": attempt["attempt_id"], "kind": kind, "turn_id": None if turn_id is None else str(turn_id),
            "session_id": str(session_id), "pid": self.pid, "at": iso_now(self.clock()),
        })

    def on_pre_llm_call(self, session_id: Any = None, turn_id: Any = None, user_message: Any = None, **_: Any) -> None:
        try:
            for attempt in self._correlated(session_id, user_message):
                self._write_evidence(attempt, "started", turn_id, session_id)
        except Exception:
            logger.warning("%s: could not record turn start", PLUGIN_NAME, exc_info=True)
        return None

    def on_post_llm_call(self, session_id: Any = None, turn_id: Any = None, user_message: Any = None, **_: Any) -> None:
        try:
            for attempt in self._correlated(session_id, user_message):
                started = read_json(evidence_path(self.state_dir, self.profile, attempt["attempt_id"], "started"))
                if started and started.get("turn_id") not in (None, str(turn_id)):
                    continue  # a different turn carried the marker; not this wake's end
                self._write_evidence(attempt, "ended", turn_id, session_id)
        except Exception:
            logger.warning("%s: could not record turn end", PLUGIN_NAME, exc_info=True)
        return None

    # -- one pass ---------------------------------------------------------------

    def tick(self) -> list[dict]:
        events: list[dict] = []
        reason = self.refusal()
        if reason:
            self.note(f"inert: {reason}")
            return [{"action": "inert", "why": reason}]
        self.settle_own()
        every, chats = self.opt_in()
        try:
            entries = self.inbox() or []
        except Exception as exc:  # broker down: try next tick
            self.note(f"broker unavailable: {exc}")
            return [{"action": "skip", "why": "broker unavailable"}]
        for entry in entries:
            chat = entry.get("to_chat")
            if not chat:
                continue  # the general mailbox is never woken here
            if entry.get("peer_name") != self.peer_name:
                continue
            if not every and chat not in chats:
                continue  # snapshot filter; consider() re-checks the exact chat after this read
            if int(entry.get("leased") or 0) > 0:
                events.append({"chat": chat, "action": "skip", "why": "mail is being read now"})
                continue
            event = self.consider(chat, int(entry.get("max_id") or 0), entry.get("title"))
            events.append(event)
            if event["action"] == "inject":
                break  # one injection per tick
        return events

    def settle_own(self) -> None:
        """Settle this host's open attempts even when no new mail arrives."""
        folder = self.state_dir / "chat-wake" / self.profile
        try:
            names = [n for n in os.listdir(folder) if n.endswith(".json")]
        except OSError:
            return
        for name in names:
            found = read_json(folder / name) or {}
            attempt = found.get("desktop_attempt")
            if not isinstance(attempt, dict) or attempt.get("host_pid") != self.pid:
                continue
            release = acquire_lock(folder / name)
            if release is None:
                continue
            try:
                ledger = read_json(folder / name)
                if ledger and isinstance(ledger.get("desktop_attempt"), dict):
                    self._settle(folder / name, ledger)
            finally:
                release()

    def _host_alive(self, attempt: dict) -> bool:
        if not self.alive(attempt["host_pid"]):
            return False
        recorded = attempt.get("host_start")
        if not recorded:
            return True
        current = self.start_of(int(attempt["host_pid"]))
        return current is None or current == recorded

    def _settle(self, path: Path, ledger: dict) -> dict:
        attempt = ledger["desktop_attempt"]
        now = self.clock()
        evidence = read_evidence(self.state_dir, self.profile, attempt["attempt_id"])
        ids = (chat_lineage(self.home, attempt["chat_key"]) or [attempt["chat_key"]]) + [attempt["session_key"]]
        entries = registry_entries(self.home)
        held = None if entries is None else any(
            str(e.get("session_id") or "") in ids and str(e.get("pid")) == str(attempt["host_pid"]) for e in entries
        )
        verdict = classify_attempt(evidence, attempt, self._host_alive(attempt), held, now)
        state, detail = apply_verdict(ledger, verdict, now)
        self._save(path, ledger, state, detail)
        return ledger

    def _save(self, path: Path, ledger: dict, state: str, detail: str) -> None:
        ledger["state"] = state
        ledger["detail"] = detail
        ledger["updated_at"] = iso_now(self.clock())
        atomic_write_json(path, ledger)

    def consider(self, chat: str, max_id: int, title: Optional[str]) -> dict:
        path = ledger_path(self.state_dir, self.profile, chat)
        release = acquire_lock(path)
        if release is None:
            return {"chat": chat, "action": "skip", "why": "ledger locked"}
        try:
            ledger = read_json(path) or empty_ledger(self.peer_name, self.profile, chat, title, self.clock())
            if ledger.get("state") == "cancelled":
                return {"chat": chat, "action": "skip", "why": "cancelled"}
            if isinstance(ledger.get("desktop_attempt"), dict):
                ledger = self._settle(path, ledger)
                if isinstance(ledger.get("desktop_attempt"), dict):
                    return {"chat": chat, "action": "skip", "why": f"desktop attempt {ledger['desktop_attempt']['state']}"}
            state = ledger.get("state")
            if state in ("launched", "running"):
                return {"chat": chat, "action": "skip", "why": "gateway wake in flight"}
            if int(ledger.get("handled_max_id") or 0) >= max_id:
                return {"chat": chat, "action": "skip", "why": "already handled"}
            if max_id <= int(ledger.get("launched_max_id") or 0) and state in ("input_required", "exhausted", "not_found"):
                return {"chat": chat, "action": "skip", "why": f"parked: {state}"}
            ids = chat_lineage(self.home, chat)
            if ids is None:
                return {"chat": chat, "action": "skip", "why": "no state.db"}
            db = open_ro(self.home / "state.db")
            try:
                known = db is not None and db.execute("SELECT 1 FROM sessions WHERE id = ?", (chat,)).fetchone() is not None
            finally:
                if db is not None:
                    db.close()
            if not known:
                return {"chat": chat, "action": "skip", "why": "chat not in this profile"}
            entries = registry_entries(self.home)
            session_key = hosted_session(entries or [], ids, self.pid)
            if session_key is None:
                return {"chat": chat, "action": "skip", "why": "not open in this process"}
            # The exact chat's opt-in and every gate, after the broker read and before the intent.
            refusal = self.refusal(chat)
            if refusal:
                return {"chat": chat, "action": "skip", "why": refusal}
            now = self.clock()
            attempt = {
                "attempt_id": uuid.uuid4().hex[:16], "chat_key": chat, "session_key": session_key,
                "max_id": max_id, "host_pid": self.pid, "host_start": self.host_start, "state": "intent",
                "created_at": iso_now(now), "accepted_at": None, "detail": "injecting",
            }
            ledger["desktop_attempt"] = attempt
            ledger["session_id"] = ledger.get("session_id") or ids[0]
            self._save(path, ledger, "waiting_desktop", f"desktop wake {attempt['attempt_id'][:8]} intent in pid {self.pid}")
        finally:
            release()

        refusal = self.refusal(chat)
        result = "not_submitted" if refusal else self._inject(attempt)
        self._record(path, attempt, result, refusal)
        return {"chat": chat, "action": "inject", "result": result, "attempt_id": attempt["attempt_id"], "session_key": session_key}

    def _inject(self, attempt: dict) -> str:
        hermes_log = logging.getLogger(HERMES_PLUGINS_LOGGER)
        capture = _InjectFailureCapture()
        hermes_log.addHandler(capture)
        try:
            accepted = self.ctx.inject_message(wake_text(attempt["attempt_id"], attempt["chat_key"]),
                                               session_key=attempt["session_key"])
        except Exception:
            logger.warning("%s: inject_message raised; outcome unknown", PLUGIN_NAME, exc_info=True)
            return "unknown"
        finally:
            hermes_log.removeHandler(capture)
        if capture.failed:
            return "unknown"
        if accepted:
            return "accepted"
        # False is a clean refusal only if Hermes could have told us about a host failure.
        return "not_submitted" if hermes_log.isEnabledFor(logging.WARNING) else "unknown"

    def _record(self, path: Path, attempt: dict, result: str, refusal: Optional[str]) -> None:
        release = acquire_lock(path, wait=10.0)
        if release is None:
            # The intent stays on disk; the classifier turns a stale intent into unknown.
            logger.warning("%s: could not record %s for %s", PLUGIN_NAME, result, attempt["attempt_id"])
            return
        try:
            ledger = read_json(path) or {}
            current = ledger.get("desktop_attempt")
            if not isinstance(current, dict) or current.get("attempt_id") != attempt["attempt_id"]:
                return
            now = self.clock()
            short = attempt["attempt_id"][:8]
            cancelled = ledger.get("state") == "cancelled"
            if result == "accepted":
                current["state"] = "accepted"
                current["accepted_at"] = iso_now(now)
                current["detail"] = "queued in the open chat; not yet handled"
                state, detail = "waiting_desktop", f"desktop wake {short} accepted in pid {self.pid}"
            elif result == "unknown":
                current["state"] = "unknown"
                current["detail"] = "inject_message failed after it may have queued the wake"
                state, detail = "desktop_unknown", f"desktop wake {short} outcome unknown; no re-wake until cli.ts hermes-desktop-clear"
            else:
                ledger["last_desktop_attempt"] = {**current, "outcome": "not_submitted", "resolved_at": iso_now(now),
                                                  "detail": refusal or "host did not accept (chat not hosted here)"}
                ledger["desktop_attempt"] = None
                state, detail = "waiting_desktop", f"desktop wake {short} not submitted: {refusal or 'host did not accept'}"
            if cancelled:
                state, detail = "cancelled", f"wakes stopped by operator; {detail}"
            self._save(path, ledger, state, detail)
        finally:
            release()

    # -- lifecycle --------------------------------------------------------------

    def run(self) -> None:
        while not self.stop.wait(POLL_SECONDS):
            try:
                self.tick()
            except Exception:
                logger.debug("%s: tick failed", PLUGIN_NAME, exc_info=True)

    def shutdown(self) -> None:
        self.stop.set()
        thread = self.thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=POLL_SECONDS + 1)


def register(ctx: Any) -> None:
    if os.environ.get("AGENT_PEERS_WAKE_DISABLED") == "1":
        logger.info("%s: disabled by AGENT_PEERS_WAKE_DISABLED=1", PLUGIN_NAME)
        return
    wake = DesktopWake(ctx)
    # Evidence hooks are observers: they return None (no prompt context) and never raise.
    ctx.register_hook("pre_llm_call", wake.on_pre_llm_call)
    ctx.register_hook("post_llm_call", wake.on_post_llm_call)
    wake.thread = threading.Thread(target=wake.run, name=f"{PLUGIN_NAME}:{wake.profile}", daemon=True)
    ctx.on_unload(wake.shutdown)
    wake.thread.start()
