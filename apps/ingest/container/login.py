"""
One-time Telegram session generator (spec §8).

Run this LOCALLY (not in the container, not on Cloudflare) to produce the
`TG_SESSION` string that the ingest container authenticates with. It performs an
interactive MTProto login (phone number -> code -> optional 2FA password) and
prints a Telethon StringSession. Copy that value into the Worker secret:

    cd apps/ingest && wrangler secret put TG_SESSION

The session string is ACCOUNT-LEVEL Telegram access — treat it like a password,
never commit it, and rotate (re-run this) if it leaks. Ingestion stays read-only
on Telegram; this script only logs in to mint the session.

Usage:
    export TG_API_ID=...        # from https://my.telegram.org/apps
    export TG_API_HASH=...
    python login.py             # or: TG_API_ID=.. TG_API_HASH=.. python login.py

Requires the same dependency as the container:
    pip install telethon==1.36.0
"""

import asyncio
import os
import sys

from telethon import TelegramClient
from telethon.sessions import StringSession


def _require(name: str) -> str:
    val = os.environ.get(name) or ""
    if not val:
        try:
            val = input(f"{name}: ").strip()
        except EOFError:
            val = ""
    if not val:
        print(f"error: {name} is required", file=sys.stderr)
        sys.exit(1)
    return val


async def _run(api_id: int, api_hash: str) -> tuple[str, str]:
    # Empty StringSession() => a fresh session we populate via interactive login.
    client = TelegramClient(StringSession(), api_id, api_hash)
    # start() handles the interactive phone -> code -> optional 2FA prompts.
    await client.start()
    # Save the session string FIRST so we always emit it, even if the cosmetic
    # "logged in as" lookup below fails.
    session_str = client.session.save()
    try:
        me = await client.get_me()
        handle = (
            getattr(me, "username", None)
            or getattr(me, "first_name", None)
            or getattr(me, "id", None)
        )
    except Exception:  # noqa: BLE001 - never let a display lookup hide the session
        handle = "(unknown)"
    await client.disconnect()
    return session_str, str(handle)


def main() -> None:
    api_id = int(_require("TG_API_ID"))
    api_hash = _require("TG_API_HASH")

    session_str, handle = asyncio.run(_run(api_id, api_hash))

    print("\n" + "=" * 72)
    print(f"Logged in as: {handle}")
    print("TG_SESSION (set this as a Worker secret — keep it secret):\n")
    print(session_str)
    print("=" * 72)
    print("\nNext:  cd apps/ingest && pnpm exec wrangler secret put TG_SESSION")


if __name__ == "__main__":
    main()
