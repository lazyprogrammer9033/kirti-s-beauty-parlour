#!/bin/bash
# Double-click this file on the salon Mac to start Salon Manager.
# Keep this window open while the salon is using the app (you can minimise it).
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Please install the LTS version from https://nodejs.org and try again."
  read -r -p "Press Enter to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing (this takes a minute)..."
  npm install --omit=dev || { read -r -p "Install failed. Press Enter to close."; exit 1; }
fi

# caffeinate keeps the Mac from sleeping while the app is running, so the iPad can always connect.
exec caffeinate -i npm start
