#!/usr/bin/env bash

set -euo pipefail

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'Missing required environment variable: %s\n' "$name" >&2
    exit 1
  fi
}

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-'
}

print_file() {
  local label="$1"
  local file_path="$2"
  if [[ -f "$file_path" ]]; then
    printf -- '--- %s (%s) ---\n' "$label" "$file_path"
    sed -n '1,240p' "$file_path"
  fi
}

dump_debug() {
  local run_log="${1:-}"
  local export_log="${2:-}"
  print_file "openbridge.log" "$OPENBRIDGE_LOG"
  if [[ -n "$run_log" ]]; then
    print_file "opencode-run.log" "$run_log"
  fi
  if [[ -n "$export_log" ]]; then
    print_file "opencode-export.log" "$export_log"
  fi
}

wait_for_bridge() {
  local attempt
  for attempt in $(seq 1 60); do
    if curl --silent --show-error --fail "$BRIDGE_BASE_URL/health" >/dev/null; then
      return 0
    fi
    if [[ -n "${server_pid:-}" ]] && ! kill -0 "$server_pid" 2>/dev/null; then
      printf 'OpenBridge exited before becoming healthy.\n' >&2
      dump_debug
      exit 1
    fi
    sleep 1
  done

  printf 'Timed out waiting for OpenBridge health at %s/health\n' "$BRIDGE_BASE_URL" >&2
  dump_debug
  exit 1
}

extract_session_id() {
  local run_log="$1"
  node -e '
    const fs = require("node:fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").split(/\n+/).filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.sessionID === "string" && parsed.sessionID.trim()) {
          process.stdout.write(parsed.sessionID.trim());
          process.exit(0);
        }
      } catch {}
    }
    process.exit(1);
  ' "$run_log"
}

extract_assistant_text() {
  local export_log="$1"
  node -e '
    const fs = require("node:fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    const jsonStart = raw.indexOf("{");
    if (jsonStart < 0) {
      process.exit(1);
    }
    const exported = JSON.parse(raw.slice(jsonStart));
    const assistantTexts = [];
    for (const message of exported.messages ?? []) {
      if (message?.info?.role !== "assistant") {
        continue;
      }
      const text = (message.parts ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text.trim())
        .filter(Boolean)
        .join("\n")
        .trim();
      if (text) {
        assistantTexts.push(text);
      }
    }
    if (assistantTexts.length === 0) {
      process.exit(1);
    }
    process.stdout.write(assistantTexts[assistantTexts.length - 1]);
  ' "$export_log"
}

run_opencode_prompt() {
  local prompt="$1"
  local prompt_slug
  local run_log
  local export_log
  local answer_text
  local session_id

  prompt_slug="$(slugify "$prompt")"
  run_log="$WORK_ROOT/${prompt_slug}.run.jsonl"
  export_log="$WORK_ROOT/${prompt_slug}.export.log"

  printf 'Running prompt against %s/%s: %s\n' "$BRIDGE_PROVIDER_ID" "$BRIDGE_MODEL_ID" "$prompt"

  if ! timeout 240s opencode run \
    --format json \
    --model "${BRIDGE_PROVIDER_ID}/${BRIDGE_MODEL_ID}" \
    "$prompt" >"$run_log" 2>&1; then
    printf 'opencode run failed for prompt: %s\n' "$prompt" >&2
    dump_debug "$run_log"
    exit 1
  fi

  if ! session_id="$(extract_session_id "$run_log")"; then
    printf 'Could not extract an OpenCode session id for prompt: %s\n' "$prompt" >&2
    dump_debug "$run_log"
    exit 1
  fi

  if ! timeout 120s opencode export "$session_id" >"$export_log" 2>&1; then
    printf 'opencode export failed for prompt: %s\n' "$prompt" >&2
    dump_debug "$run_log" "$export_log"
    exit 1
  fi

  if ! answer_text="$(extract_assistant_text "$export_log")"; then
    printf 'No non-empty assistant answer was captured for prompt: %s\n' "$prompt" >&2
    dump_debug "$run_log" "$export_log"
    exit 1
  fi

  printf 'Assistant answer: %s\n' "$answer_text"
}

require_env "BRIDGE_PROVIDER_ID"
require_env "BRIDGE_MODEL_ID"
require_env "BRIDGE_SESSION_JSON"

REPO_ROOT="${GITHUB_WORKSPACE:-$PWD}"
BRIDGE_HOST="${BRIDGE_HOST:-127.0.0.1}"
BRIDGE_PORT="${BRIDGE_PORT:-4318}"
BRIDGE_BASE_URL="${BRIDGE_BASE_URL:-http://${BRIDGE_HOST}:${BRIDGE_PORT}}"
WORK_ROOT="${RUNNER_TEMP:-$(mktemp -d)}/prepublish-llm-smoke-$(slugify "${BRIDGE_PROVIDER_ID}-${BRIDGE_MODEL_ID}")"
BRIDGE_STATE_ROOT="$WORK_ROOT/bridge-state"
OPENBRIDGE_LOG="$WORK_ROOT/openbridge.log"
SESSION_FILE="$WORK_ROOT/session-package.json"
OPENCODE_WORKDIR="$WORK_ROOT/opencode-workdir"
OPENCODE_XDG_ROOT="$WORK_ROOT/opencode-xdg"
SESSION_SECRET_NAME="${SESSION_SECRET_NAME:-unknown}"
BRIDGE_SESSION_VAULT_KEY="${BRIDGE_SESSION_VAULT_KEY:-$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")}"

if [[ -z "${BRIDGE_SESSION_JSON//[[:space:]]/}" ]]; then
  printf 'The %s secret is empty for provider %s.\n' "$SESSION_SECRET_NAME" "$BRIDGE_PROVIDER_ID" >&2
  exit 1
fi

if ! command -v opencode >/dev/null 2>&1; then
  printf 'opencode is not installed or not on PATH.\n' >&2
  exit 1
fi

export BRIDGE_SESSION_VAULT_KEY

mkdir -p "$WORK_ROOT" "$BRIDGE_STATE_ROOT" "$OPENCODE_WORKDIR"
mkdir -p \
  "$OPENCODE_XDG_ROOT/config" \
  "$OPENCODE_XDG_ROOT/cache" \
  "$OPENCODE_XDG_ROOT/data" \
  "$OPENCODE_XDG_ROOT/state"

printf '%s' "$BRIDGE_SESSION_JSON" >"$SESSION_FILE"

cleanup() {
  if [[ -n "${server_pid:-}" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT

cat >"$OPENCODE_WORKDIR/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "${BRIDGE_PROVIDER_ID}": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenBridge",
      "options": {
        "baseURL": "${BRIDGE_BASE_URL}/v1",
        "apiKey": "bridge-ci"
      },
      "models": {
        "${BRIDGE_MODEL_ID}": {
          "name": "${BRIDGE_MODEL_ID}"
        }
      }
    }
  },
  "model": "${BRIDGE_PROVIDER_ID}/${BRIDGE_MODEL_ID}",
  "small_model": "${BRIDGE_PROVIDER_ID}/${BRIDGE_MODEL_ID}",
  "tools": {
    "edit": false,
    "patch": false,
    "write": false
  },
  "permission": {
    "bash": "allow",
    "question": "deny"
  }
}
EOF

node ./bin/openbridge.js start \
  --foreground \
  --host "$BRIDGE_HOST" \
  --port "$BRIDGE_PORT" \
  --state-root "$BRIDGE_STATE_ROOT" \
  --runtime-root "$REPO_ROOT" >"$OPENBRIDGE_LOG" 2>&1 &
server_pid=$!

wait_for_bridge

node ./bin/openbridge.js providers import-session \
  "$BRIDGE_PROVIDER_ID" \
  --base-url "$BRIDGE_BASE_URL" \
  --file "$SESSION_FILE" >"$WORK_ROOT/import-session.json"

node ./bin/openbridge.js models add \
  --base-url "$BRIDGE_BASE_URL" \
  --provider "$BRIDGE_PROVIDER_ID" \
  --model "$BRIDGE_MODEL_ID" >"$WORK_ROOT/add-model.json"

pushd "$OPENCODE_WORKDIR" >/dev/null
export XDG_CONFIG_HOME="$OPENCODE_XDG_ROOT/config"
export XDG_CACHE_HOME="$OPENCODE_XDG_ROOT/cache"
export XDG_DATA_HOME="$OPENCODE_XDG_ROOT/data"
export XDG_STATE_HOME="$OPENCODE_XDG_ROOT/state"

run_opencode_prompt "Hello?"
run_opencode_prompt "Please ping localhost and show me the results"

popd >/dev/null
