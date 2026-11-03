#!/usr/bin/env bash
# scripts/load-test-target.sh — decide what the load test targets (TASK-143, ADR-056)
#
# load-test.yml's input is free text from whoever dispatches the workflow. It reaches this script
# as an argument (never as workflow text), and only two shapes are accepted, each matched against
# the WHOLE value:
#
#   http://localhost[:port] or http://127.0.0.1[:port]   build and start the app on the runner
#   https://<host>[:port]                                test that address directly
#
# Anything else is refused, and so is any value holding a newline or a carriage return: grep -E
# matches line by line, so "http://localhost\nlocal=false" once passed the check on its first line
# and the second line reached $GITHUB_OUTPUT as an output of its own. Bash's [[ =~ ]] matches the
# whole string, and the explicit check makes the refusal independent of the regex engine.
#
#   bash scripts/load-test-target.sh "$INPUT_URL"     # prints local=…, port=… (local), url=…
#
# Exit 0 with the outputs on stdout, one key=value per line; exit 1 with the reason on stderr.
set -euo pipefail

url="${1:-http://localhost:3000}"
case "$url" in
  *$'\n'* | *$'\r'*)
    echo "target_url must be one line (it holds a newline or a carriage return)" >&2
    exit 1
    ;;
esac
url="${url%/}"

if [[ "$url" =~ ^http://(localhost|127\.0\.0\.1)(:([0-9]{1,5}))?$ ]]; then
  port="${BASH_REMATCH[3]:-80}"
  if ((10#$port < 1 || 10#$port > 65535)); then
    echo "target_url has a port outside 1-65535: $port" >&2
    exit 1
  fi
  echo "local=true"
  echo "port=$((10#$port))"
elif [[ "$url" =~ ^https://[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:[0-9]{1,5})?$ ]]; then
  echo "local=false"
else
  echo "target_url must be http://localhost[:port] or an https:// origin, got: $url" >&2
  exit 1
fi
echo "url=$url"
