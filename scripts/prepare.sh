#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="/tmp/mlb-positive-ev-v2.tar.gz"
cat "$ROOT"/.bundle/part-* | tr -d '\n' | base64 -d > "$TMP"
echo "f2a9ffeee0c95ed81661aa306e3d9bb47bd372c37d78aeca0885acb9d6c2b1f2  $TMP" | sha256sum -c -
tar -xzf "$TMP" -C "$ROOT"
