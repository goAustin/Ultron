#!/usr/bin/env bash
cat >/dev/null
# Emit ~10MB of 'x' to stdout to exercise the 1MB cap.
printf 'x%.0s' {1..10485760}
exit 0
