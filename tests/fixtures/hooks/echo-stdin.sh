#!/usr/bin/env bash
# Echoes stdin verbatim to a file passed as $1 so tests can inspect what the
# runner wrote. Exit 0 / no stdout.
if [ -n "$1" ]; then
  cat > "$1"
else
  cat >/dev/null
fi
exit 0
