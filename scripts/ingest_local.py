#!/usr/bin/env python3
"""
Off-Cloudflare Telegram ingest.

Cloudflare Containers can't complete the MTProto handshake — Telegram accepts the
TCP connection but blocks the protocol from datacenter egress IPs (see the
ingest debugging notes). This script does the SAME ingest loop the CF container
did, but runs on a host with a Telegram-reachable IP (your machine, or a small
always-on VPS) and writes to D1 over the REST API instead of a Worker binding:

  1. read chat_cursors from D1
  2. Telethon catch-up fetch since each cursor (offset_id = last_message_id)
  3. upsert telegram_messages (idempotent on (chat_id,message_id)) + advance cursors
  4. record the 'ingest' heartbeat in system_status so the watchdog sees liveness

Schedule it with cron (e.g. every 10 min) on the host — that replaces the CF
ingest Worker's cron, which is now disabled.

Env:
  TG_API_ID, TG_API_HASH, TG_SESSION            (Telegram — same values as before)
  CF_API_TOKEN                                   (Cloudflare token with D1 Edit;
                                                  reuse your GitHub Actions token)
  CF_ACCOUNT_ID      (default: 4efa81edb9dfe313cb1636ef5f9206f3)
  CF_D1_DATABASE_ID  (default: 43a788cc-7c4d-4e76-a12f-7a858b8bd17b)
  FETCH_LIMIT_PER_CHAT (default 200), MAX_CHATS (default 0 = all dialogs)

Deps:  pip install telethon==1.36.0     (D1 access uses stdlib urllib)
"""

import asyncio
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request

from telethon import TelegramClient
from telethon.network import ConnectionTcpObfuscated
from telethon.sessions import StringSession

ACCOUNT = os.environ.get("CF_ACCOUNT_ID", "4efa81edb9dfe313cb1636ef5f9206f3")
DATABASE = os.environ.get("CF_D1_DATABASE_ID", "43a788cc-7c4d-4e76-a12f-7a858b8bd17b")
D1_URL = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DATABASE}/query"


def _token() -> str:
    t = os.environ.get("CF_API_TOKEN", "")
    if not t:
        print("error: CF_API_TOKEN is required (Cloudflare token with D1 Edit)", file=sys.stderr)
        sys.exit(1)
    return t


def d1(sql: str, params=None):
    """Run one parameterized statement against D1 via the REST API; return rows."""
    body = json.dumps({"sql": sql, "params": params or []}).encode()
    req = urllib.request.Request(
        D1_URL,
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {_token()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"D1 HTTP {e.code}: {e.read().decode()[:300]}")
    if not data.get("success"):
        raise RuntimeError(f"D1 error: {data.get('errors')}")
    return data["result"][0]["results"]


def now() -> int:
    return int(time.time())


def record_status(ok: bool, detail: str) -> None:
    d1(
        "INSERT INTO system_status (component, updated_at, ok, detail) VALUES (?1,?2,?3,?4) "
        "ON CONFLICT(component) DO UPDATE SET updated_at=excluded.updated_at, ok=excluded.ok, detail=excluded.detail",
        ["ingest", now(), 1 if ok else 0, detail[:500]],
    )


def to_unix(value) -> int:
    if isinstance(value, datetime.datetime):
        return int(value.timestamp())
    if isinstance(value, (int, float)):
        return int(value)
    return 0


def raw_json(message) -> str:
    try:
        return json.dumps(message.to_dict(), default=lambda o: o.isoformat()
                          if isinstance(o, datetime.datetime) else str(o))
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"_serialization_error": str(exc), "id": getattr(message, "id", None)})


def upsert_message(m: dict) -> None:
    d1(
        "INSERT INTO telegram_messages "
        "(chat_id, message_id, sender_user_id, chat_title, text, msg_date, is_outgoing, raw_json, ingested_at) "
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) "
        "ON CONFLICT (chat_id, message_id) DO UPDATE SET "
        "sender_user_id=excluded.sender_user_id, chat_title=excluded.chat_title, text=excluded.text, "
        "msg_date=excluded.msg_date, is_outgoing=excluded.is_outgoing, raw_json=excluded.raw_json",
        [m["chat_id"], m["message_id"], m["sender_user_id"], m["chat_title"], m["text"],
         m["msg_date"], 1 if m["is_outgoing"] else 0, m["raw_json"], now()],
    )


def set_cursor(chat_id: int, last_message_id: int, chat_title) -> None:
    d1(
        "INSERT INTO chat_cursors (chat_id, last_message_id, chat_title, updated_at) VALUES (?1,?2,?3,?4) "
        "ON CONFLICT(chat_id) DO UPDATE SET "
        "last_message_id=MAX(chat_cursors.last_message_id, excluded.last_message_id), "
        "chat_title=COALESCE(excluded.chat_title, chat_cursors.chat_title), updated_at=excluded.updated_at",
        [chat_id, last_message_id, chat_title, now()],
    )


async def run() -> dict:
    api_id = int(os.environ["TG_API_ID"])
    api_hash = os.environ["TG_API_HASH"]
    session = os.environ["TG_SESSION"]
    fetch_limit = int(os.environ.get("FETCH_LIMIT_PER_CHAT", "200"))
    max_chats = int(os.environ.get("MAX_CHATS", "0"))

    cursor_rows = d1("SELECT chat_id, last_message_id FROM chat_cursors")
    cursor_by_chat = {int(r["chat_id"]): int(r["last_message_id"]) for r in cursor_rows}

    written = 0
    chats_advanced = 0
    client = TelegramClient(StringSession(session), api_id, api_hash, connection=ConnectionTcpObfuscated)
    await asyncio.wait_for(client.connect(), timeout=30)
    try:
        if not await client.is_user_authorized():
            raise RuntimeError("TG_SESSION not authorized — regenerate via login.py")

        processed = 0
        async for dialog in client.iter_dialogs():
            if max_chats and processed >= max_chats:
                break
            processed += 1
            chat_id = int(dialog.id)
            min_id = cursor_by_chat.get(chat_id, 0)
            title = getattr(dialog, "name", None) or getattr(dialog, "title", None)
            highest = min_id
            count = 0
            async for msg in client.iter_messages(chat_id, offset_id=min_id, limit=fetch_limit, reverse=True):
                mid = int(msg.id)
                if mid <= min_id:
                    continue
                count += 1
                highest = max(highest, mid)
                sender = getattr(msg, "sender_id", None)
                text = getattr(msg, "message", None) or getattr(msg, "text", None)
                upsert_message({
                    "chat_id": chat_id, "message_id": mid,
                    "sender_user_id": int(sender) if sender is not None else None,
                    "chat_title": title, "text": text,
                    "msg_date": to_unix(getattr(msg, "date", None)),
                    "is_outgoing": bool(getattr(msg, "out", False)),
                    "raw_json": raw_json(msg),
                })
                written += 1
            if count > 0:
                set_cursor(chat_id, highest, title)
                chats_advanced += 1
    finally:
        await client.disconnect()

    return {"messages_written": written, "chats_advanced": chats_advanced}


def main() -> None:
    try:
        result = asyncio.run(run())
        record_status(True, json.dumps(result))
        print(f"ingest_local OK: {result}")
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        try:
            record_status(False, msg)
        except Exception as e2:  # noqa: BLE001
            print(f"(also failed to record heartbeat: {e2})", file=sys.stderr)
        print(f"ingest_local FAILED: {msg}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
