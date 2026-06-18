"""
Telethon ingest container (spec §5.1).

A thin Telegram fetcher with NO database access. It listens on port 8080 and
exposes POST /fetch. The ingest Worker POSTs a cursor map (per-chat min_id) and
forwards TG_API_ID / TG_API_HASH / TG_SESSION (via env and/or request headers);
this process connects with TelegramClient(StringSession(...)), pulls messages
newer than each cursor, serializes them to JSON, returns them, and stays warm
until the Worker lets it sleep.

Request  (POST /fetch):
  {
    "cursors": [{"chat_id": int, "min_id": int, "chat_title": str|null}, ...],
    "fetch_limit_per_chat": int,
    "max_chats": int            # 0 => no cap on dialogs discovered
  }

Response:
  {
    "messages": [
      {
        "chat_id": int, "message_id": int, "sender_user_id": int|null,
        "chat_title": str|null, "text": str|null, "msg_date": int (unix secs),
        "is_outgoing": bool, "raw_json": { ...telethon to_dict()... }
      }, ...
    ],
    "cursors": [{"chat_id": int, "last_message_id": int, "chat_title": str|null}, ...],
    "errors": [{"chat_id": int|null, "error": str}, ...]
  }

Cursor semantics: Telethon's iter_messages(min_id=N) returns messages with
id > N. We pass each chat's stored cursor as min_id and report the highest id
seen back as last_message_id. Reading is non-destructive; this stays read-only
on Telegram (spec §12).
"""

import asyncio
import datetime
import json
import logging
import os
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from telethon import TelegramClient
from telethon.sessions import StringSession

# Raw-TCP connectivity probe targets. Control = general egress; the rest are
# Telegram production DC IPs on 443 and 80. Distinguishes a general-egress block
# (even control fails) vs. a Telegram-IP block (control OK, all TG fail) vs. a
# port-specific block (e.g. :443 fails but :80 works).
_PROBE_TARGETS = [
    ("control_1.1.1.1:443", "1.1.1.1", 443),
    ("tg_dc2:443", "149.154.167.51", 443),
    ("tg_dc2:80", "149.154.167.51", 80),
    ("tg_dc4:443", "149.154.167.91", 443),
    ("tg_dc4:80", "149.154.167.91", 80),
]


def _probe_connectivity(timeout: float = 5.0) -> str:
    """Try a raw TCP connect to each target; return a compact OK/<error> summary."""
    out = []
    for label, host, port in _PROBE_TARGETS:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        try:
            s.connect((host, port))
            out.append(f"{label}=OK")
        except Exception as exc:  # noqa: BLE001
            out.append(f"{label}={type(exc).__name__}")
        finally:
            s.close()
    return "; ".join(out)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s ingest-container %(levelname)s %(message)s",
)
log = logging.getLogger("ingest")

PORT = int(os.environ.get("PORT", "8080"))


def _to_unix(value) -> int:
    """Telethon dates are tz-aware datetimes; coerce to unix epoch seconds."""
    if isinstance(value, datetime.datetime):
        return int(value.timestamp())
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def _json_default(obj):
    """Make a Telethon message .to_dict() JSON-serializable (audit trail)."""
    if isinstance(obj, datetime.datetime):
        return obj.isoformat()
    if isinstance(obj, (bytes, bytearray)):
        return obj.hex()
    return str(obj)


def _raw_json(message) -> dict:
    """Best-effort full message snapshot for the raw_json audit column."""
    try:
        raw = message.to_dict()
        # Round-trip through json to drop non-serializable leaves consistently.
        return json.loads(json.dumps(raw, default=_json_default))
    except Exception as exc:  # noqa: BLE001 - never let serialization kill a fetch
        return {"_serialization_error": str(exc), "id": getattr(message, "id", None)}


def _resolve_creds(headers) -> tuple[int, str, str]:
    """Read credentials from request headers first, then container env."""
    api_id_raw = (headers.get("x-tg-api-id") if headers else None) or os.environ.get(
        "TG_API_ID", ""
    )
    api_hash = (headers.get("x-tg-api-hash") if headers else None) or os.environ.get(
        "TG_API_HASH", ""
    )
    session = (headers.get("x-tg-session") if headers else None) or os.environ.get(
        "TG_SESSION", ""
    )
    if not api_id_raw or not api_hash or not session:
        raise RuntimeError(
            "missing Telegram credentials (TG_API_ID / TG_API_HASH / TG_SESSION)"
        )
    return int(api_id_raw), api_hash, session


async def _fetch(req: dict, headers) -> dict:
    api_id, api_hash, session = _resolve_creds(headers)

    cursors = req.get("cursors") or []
    fetch_limit = int(req.get("fetch_limit_per_chat") or 200)
    max_chats = int(req.get("max_chats") or 0)

    # Map of chat_id -> min_id we already have a stored cursor for.
    cursor_by_chat = {int(c["chat_id"]): int(c.get("min_id") or 0) for c in cursors}

    messages: list[dict] = []
    advanced: dict[int, dict] = {}
    errors: list[dict] = []

    client = TelegramClient(StringSession(session), api_id, api_hash)
    # Fail FAST with a precise error instead of hanging until the Worker's 150s
    # abort: a dead/blocked session can make connect() or the auth check hang.
    try:
        await asyncio.wait_for(client.connect(), timeout=15)
    except asyncio.TimeoutError:
        probe = _probe_connectivity()
        raise RuntimeError(
            f"telegram connect timed out after 15s. connectivity probe [{probe}]"
        )
    try:
        authorized = await asyncio.wait_for(client.is_user_authorized(), timeout=20)
        if not authorized:
            raise RuntimeError(
                "telegram session is not authorized (TG_SESSION invalid/revoked — regenerate it)"
            )

        # Discover dialogs. We process: every chat with a stored cursor, plus
        # any new dialogs we have not seen yet (so first-run / new chats catch up).
        seen_chats: set[int] = set()
        dialogs_processed = 0

        async for dialog in client.iter_dialogs():
            if max_chats and dialogs_processed >= max_chats:
                break
            chat_id = int(dialog.id)
            seen_chats.add(chat_id)
            dialogs_processed += 1
            min_id = cursor_by_chat.get(chat_id, 0)
            chat_title = getattr(dialog, "name", None) or getattr(dialog, "title", None)
            try:
                await _fetch_chat(
                    client, chat_id, min_id, chat_title, fetch_limit, messages, advanced
                )
            except Exception as exc:  # noqa: BLE001 - isolate per-chat failures
                log.warning("chat %s fetch failed: %s", chat_id, exc)
                errors.append({"chat_id": chat_id, "error": str(exc)})

        # Any cursor chats not surfaced as dialogs (archived, etc.): fetch directly.
        for chat_id, min_id in cursor_by_chat.items():
            if chat_id in seen_chats:
                continue
            if max_chats and dialogs_processed >= max_chats:
                break
            dialogs_processed += 1
            try:
                await _fetch_chat(
                    client, chat_id, min_id, None, fetch_limit, messages, advanced
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("cursor chat %s fetch failed: %s", chat_id, exc)
                errors.append({"chat_id": chat_id, "error": str(exc)})
    finally:
        await client.disconnect()

    return {
        "messages": messages,
        "cursors": list(advanced.values()),
        "errors": errors,
    }


async def _fetch_chat(
    client: TelegramClient,
    chat_id: int,
    min_id: int,
    chat_title,
    fetch_limit: int,
    messages: list,
    advanced: dict,
) -> None:
    """Pull messages with id > min_id for one chat (oldest-first) and record them."""
    # Use offset_id (NOT min_id) with reverse=True: Telethon's min_id is not
    # reliably applied alongside reverse=True (it re-surfaces already-seen
    # messages, causing a full re-fetch every run). offset_id + reverse=True
    # returns id > offset_id in ascending order, so the cursor advances
    # monotonically. The `mid <= min_id` guard below is a belt-and-suspenders
    # floor in case the server still hands back a boundary message.
    count = 0
    highest = min_id
    async for msg in client.iter_messages(
        chat_id, offset_id=min_id, limit=fetch_limit, reverse=True
    ):
        mid = int(msg.id)
        if mid <= min_id:
            continue  # never re-emit a message at/below the stored cursor
        count += 1
        if mid > highest:
            highest = mid

        sender_id = getattr(msg, "sender_id", None)
        is_outgoing = bool(getattr(msg, "out", False))

        title = chat_title
        if title is None:
            chat = getattr(msg, "chat", None)
            title = (
                getattr(chat, "title", None)
                or getattr(chat, "username", None)
                if chat is not None
                else None
            )

        text = getattr(msg, "message", None)
        if text is None:
            text = getattr(msg, "text", None)

        messages.append(
            {
                "chat_id": chat_id,
                "message_id": mid,
                "sender_user_id": int(sender_id) if sender_id is not None else None,
                "chat_title": title,
                "text": text,
                "msg_date": _to_unix(getattr(msg, "date", None)),
                "is_outgoing": is_outgoing,
                "raw_json": _raw_json(msg),
            }
        )

    if count > 0:
        advanced[chat_id] = {
            "chat_id": chat_id,
            "last_message_id": highest,
            "chat_title": chat_title,
        }
    log.info("chat %s: %d new message(s), cursor -> %d", chat_id, count, highest)


class Handler(BaseHTTPRequestHandler):
    # Quieter access logging; we emit our own structured logs.
    def log_message(self, fmt, *args):  # noqa: N802 - stdlib signature
        log.info("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - stdlib signature
        if self.path == "/health" or self.path == "/":
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"error": "not found"})

    def _read_body(self) -> bytes:
        """Read the full request body, handling BOTH Content-Length and
        Transfer-Encoding: chunked. The DO->container proxy streams the request
        chunked (no Content-Length), so a Content-Length-only reader silently
        gets an empty body — which dropped the cursor map and forced a full
        re-fetch every run."""
        te = (self.headers.get("transfer-encoding") or "").lower()
        if "chunked" in te:
            chunks = []
            while True:
                size_line = self.rfile.readline().strip()
                if not size_line:
                    continue
                try:
                    size = int(size_line.split(b";", 1)[0], 16)
                except ValueError:
                    break
                if size == 0:
                    self.rfile.readline()  # consume trailing CRLF
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.readline()  # consume the CRLF after each chunk
            return b"".join(chunks)
        length = int(self.headers.get("content-length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def do_POST(self):  # noqa: N802 - stdlib signature
        if self.path != "/fetch":
            self._send_json(404, {"error": "not found"})
            return
        try:
            raw = self._read_body()
            req = json.loads(raw or b"{}")
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"error": f"bad request body: {exc}"})
            return

        try:
            # Each request gets its own event loop; the server is threaded.
            result = asyncio.run(_fetch(req, self.headers))
            # Diagnostic echoed back (container stdout does not reach wrangler
            # tail): confirms how many cursors actually arrived + body framing.
            result["debug"] = {
                "received_cursors": len(req.get("cursors") or []),
                "body_bytes": len(raw),
                "transfer_encoding": self.headers.get("transfer-encoding"),
                "content_length": self.headers.get("content-length"),
            }
            self._send_json(200, result)
        except Exception as exc:  # noqa: BLE001
            log.exception("fetch failed")
            self._send_json(500, {"error": str(exc)})


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log.info("listening on :%d", PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
