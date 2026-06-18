# Durable off-Cloudflare ingest (systemd on a VPS)

Telegram blocks MTProto from Cloudflare container IPs, so the Telegram fetch runs
on a VPS via a `systemd` timer (every 10 min) and writes to D1 over the REST API.
The rest of the pipeline stays on Cloudflare.

## Install (run on the VPS as root / with sudo)

```bash
# 1. Code + a dedicated unprivileged user.
#    NOTE: don't make /opt/tg-crm-system the user's home (--create-home would
#    populate it with skeleton files and git clone would refuse the non-empty dir).
sudo useradd --system --shell /usr/sbin/nologin tgingest
sudo git clone https://github.com/tkkwon1998/tg-crm-system /opt/tg-crm-system
sudo chown -R tgingest:tgingest /opt/tg-crm-system

# If you already ran the old `useradd --create-home --home-dir /opt/tg-crm-system`
# (so the dir exists and clone fails), initialize the repo IN PLACE instead:
#   sudo -u tgingest git -C /opt/tg-crm-system init -q
#   sudo -u tgingest git -C /opt/tg-crm-system remote add origin https://github.com/tkkwon1998/tg-crm-system
#   sudo -u tgingest git -C /opt/tg-crm-system fetch -q --depth 1 origin main
#   sudo -u tgingest git -C /opt/tg-crm-system checkout -q -f -b main FETCH_HEAD

# 2. Python venv with telethon
sudo -u tgingest python3 -m venv /opt/tg-crm-system/.venv
sudo -u tgingest /opt/tg-crm-system/.venv/bin/pip install --upgrade pip
sudo -u tgingest /opt/tg-crm-system/.venv/bin/pip install telethon==1.36.0

# 3. Secrets file (chmod 600 so only root reads it)
sudo cp /opt/tg-crm-system/deploy/tg-ingest.env.example /etc/tg-crm-ingest.env
sudo nano /etc/tg-crm-ingest.env          # fill TG_API_ID/HASH/SESSION + CF_API_TOKEN
sudo chmod 600 /etc/tg-crm-ingest.env

# 4. Install + enable the timer
sudo cp /opt/tg-crm-system/deploy/tg-ingest.service /etc/systemd/system/
sudo cp /opt/tg-crm-system/deploy/tg-ingest.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tg-ingest.timer

# 5. Smoke-test one run immediately
sudo systemctl start tg-ingest.service
journalctl -u tg-ingest.service -n 20 --no-pager     # expect: "ingest_local OK: {...}"
```

If you cloned somewhere other than `/opt/tg-crm-system` or use a different user,
edit the `User=`, `WorkingDirectory=`, and `ExecStart=` lines in
`tg-ingest.service` to match.

## Verify it's durable
```bash
systemctl list-timers tg-ingest.timer        # shows NEXT/LAST run
journalctl -u tg-ingest.service -f           # follow runs live
```
From your terminal: `make status` should show the `ingest` heartbeat `ok=1`,
refreshing every ~10 min. Two consecutive green heartbeats = fully durable.

## Updating
```bash
sudo -u tgingest git -C /opt/tg-crm-system pull
# no restart needed — the timer runs the latest script each tick
```

## Notes
- Logs go to journald: `journalctl -u tg-ingest.service`.
- The script records the `ingest` heartbeat in `system_status` on every run, so
  the Cloudflare watchdog (still on `*/15`) stays green and pages only if this
  VPS job stops for ~40 min.
- Token scope: `CF_API_TOKEN` only needs **D1: Edit** on the plex.engineer account.
