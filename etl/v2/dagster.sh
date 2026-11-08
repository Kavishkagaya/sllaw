#!/bin/bash
# bash etl/v2/dagster.sh -- start Dagster for the v2 pipeline (etl/v2/pipeline.py) on this host, in tmux:
#   dgweb     the UI on 127.0.0.1:3070 (from your machine: ssh -L 3070:localhost:3070 ampere, then http://localhost:3070)
#   dgdaemon  runs the schedule and the run queue (one pipeline run at a time)
# Dagster's own records (runs, logs) live in DAGSTER_HOME on this host's local disk (SQLite); the pipeline's state is
# in the state database (V2_DATABASE_URL), so losing DAGSTER_HOME loses only run history. Rerun after a reboot.
set -eu
V=/var/tmp/e19309/dagster_venv/bin
export DAGSTER_HOME=/var/tmp/e19309/dagster_home
mkdir -p "$DAGSTER_HOME"
cat > "$DAGSTER_HOME/dagster.yaml" <<'EOF'
telemetry:
  enabled: false
run_coordinator:
  module: dagster.core.run_coordinator
  class: QueuedRunCoordinator
  config:
    max_concurrent_runs: 1
EOF
cd ~/sllaw
for s in dgweb dgdaemon; do tmux kill-session -t $s 2>/dev/null || true; done
tmux new-session -d -s dgweb "DAGSTER_HOME=$DAGSTER_HOME $V/dagster-webserver -h 127.0.0.1 -p 3070 -f etl/v2/pipeline.py -d ~/sllaw > ~/sllaw/logs/dagster_web.log 2>&1"
tmux new-session -d -s dgdaemon "DAGSTER_HOME=$DAGSTER_HOME $V/dagster-daemon run -f etl/v2/pipeline.py -d ~/sllaw > ~/sllaw/logs/dagster_daemon.log 2>&1"
echo "dagster: UI 127.0.0.1:3070 (tmux dgweb), daemon (tmux dgdaemon); logs ~/sllaw/logs/dagster_*.log"
