#!/bin/bash
# The project's Postgres on the work host (decision 2026-10-10, user: Neon's free transfer quota was hit). ada until
# it died on 2026-10-18; ampere since 2026-10-19 (same paths: /var/tmp is per host, ~/sllaw is the shared NFS home).
#   bash ~/sllaw/etl/db_ada.sh        # init if missing, start if not running; safe to re-run (e.g. after a reboot)
# Binaries from the pgserver wheel (Postgres + pgvector) in etl_venv (else lighton_venv); data in /var/tmp/e19309/pgdata, which
# survives reboots (/tmp does not). localhost:5433 only, password auth; the URL is DB_LOCAL_URL in ~/sllaw/.env.
# From another machine: ssh -L 5433:localhost:5433 ada, then the same URL.
set -eu
T=/var/tmp/e19309; D=$T/pgdata; PORT=5433
PY=$T/etl_venv/bin/python; [ -x $PY ] || PY=$T/lighton_venv/bin/python
B=$($PY -c "import pgserver, os; print(os.path.join(os.path.dirname(pgserver.__file__), 'pginstall', 'bin'))")
export LD_LIBRARY_PATH=$B/../lib:${LD_LIBRARY_PATH:-}
if [ ! -f $D/PG_VERSION ]; then
    # the password in the shared .env if there is one, so DB_LOCAL_URL holds on any host
    PW=$(grep '^DB_LOCAL_URL=' ~/sllaw/.env 2>/dev/null | sed -E 's|.*://sllaw:([^@]*)@.*|\1|')
    [ -n "$PW" ] || PW=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
    echo "$PW" > $T/.pgpw && chmod 600 $T/.pgpw
    $B/initdb -D $D -U sllaw --pwfile=$T/.pgpw -A scram-sha-256 -E UTF8 >/dev/null
    cat >> $D/postgresql.conf <<EOF
listen_addresses = 'localhost'
port = $PORT
unix_socket_directories = '$D'
shared_buffers = 1GB
work_mem = 64MB
maintenance_work_mem = 1GB
max_connections = 60
EOF
    URL="postgresql://sllaw:$PW@localhost:$PORT/sllaw"
    grep -q '^DB_LOCAL_URL=' ~/sllaw/.env 2>/dev/null || echo "DB_LOCAL_URL=$URL" >> ~/sllaw/.env
fi
if ! $B/pg_ctl -D $D status >/dev/null 2>&1; then
    $B/pg_ctl -D $D -l $T/pgdata.log -w start >/dev/null
fi
PGPASSWORD=$(cat $T/.pgpw) $B/psql -h localhost -p $PORT -U sllaw -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='sllaw'" | grep -q 1 \
    || PGPASSWORD=$(cat $T/.pgpw) $B/createdb -h localhost -p $PORT -U sllaw sllaw
PGPASSWORD=$(cat $T/.pgpw) $B/psql -h localhost -p $PORT -U sllaw -d sllaw -tAc "CREATE EXTENSION IF NOT EXISTS vector; SELECT 'postgres up: ' || version()"
