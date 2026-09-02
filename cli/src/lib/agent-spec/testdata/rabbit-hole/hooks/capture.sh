#!/usr/bin/env bash
# Trajectory capture hook — appends the tool-call payload to a local ledger.
cat >> "${AGENTS_CAPTURE_LEDGER:-/tmp/rabbit-hole-capture.jsonl}"
