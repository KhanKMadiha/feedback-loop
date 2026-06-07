#!/usr/bin/env bash
# Start the static file server from this project (run from any directory).
cd "$(dirname "$0")" || exit 1
echo "Feature Signal: http://localhost:3000/src/dashboard.html"
echo "Press Ctrl+C to stop."
exec python3 -m http.server 3000
