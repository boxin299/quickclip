#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$FRONTEND_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
BASE_BACKEND_PORT="${APP_BACKEND_PORT:-18000}"
SYSTEM_PYTHON="${PYTHON3:-python3}"
FRONTEND_PORT="${VITE_PORT:-3000}"

# 查找可用端口，使用 Python socket bind 替代 lsof（单次进程调用，速度更快）
find_available_port() {
    local port
    port=$("$SYSTEM_PYTHON" -c "
import socket
for offset in range(100):
    p = ${BASE_BACKEND_PORT} + offset
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(('127.0.0.1', p))
        s.close()
        print(p)
        break
    except OSError:
        continue
" 2>/dev/null)
    if [ -n "$port" ]; then
        echo "$port"
        return 0
    fi
    echo "" >&2
    return 1
}

BACKEND_PORT=$(find_available_port)
if [ -z "$BACKEND_PORT" ]; then
    echo "ERROR: 无法找到可用端口 (${BASE_BACKEND_PORT}-$((BASE_BACKEND_PORT + 99)))"
    exit 1
fi

if [ "$BACKEND_PORT" != "$BASE_BACKEND_PORT" ]; then
    echo "端口 ${BASE_BACKEND_PORT} 被占用，自动使用端口 ${BACKEND_PORT}"
fi

BACKEND_READY_URL="http://127.0.0.1:${BACKEND_PORT}/"
BACKEND_MODEL_CACHE="$BACKEND_DIR/data/modelscope"
BACKEND_LOG="${TMPDIR:-/tmp}/QuickClip-backend.log"

VENV_DIR="$BACKEND_DIR/.venv"
VENV_PYTHON="$VENV_DIR/bin/python"

# ---------- kill old backend processes ----------
kill_old_backends() {
    local old_pids
    old_pids=$(ps aux | grep -E "[P]ython.*(app/main\.py|/backend-runtime/.*/main\.py|[[:space:]]main\.py($|[[:space:]])|uvicorn[[:space:]]+main:app)" | awk '{print $2}' 2>/dev/null || true)
    if [ -n "$old_pids" ]; then
        echo "Cleaning up old backend processes: $old_pids"
        for pid in $old_pids; do
            kill "$pid" 2>/dev/null || true
        done
        sleep 1
        for pid in $old_pids; do
            if kill -0 "$pid" 2>/dev/null; then
                echo "Force killing stale backend: $pid"
                kill -9 "$pid" 2>/dev/null || true
            fi
        done
        sleep 1
    fi
}

kill_conflicting_frontend() {
    local pid
    pid=$(lsof -ti tcp:"$FRONTEND_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)
    if [ -z "$pid" ]; then
        return 0
    fi

    local cmd
    cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
    if echo "$cmd" | grep -Eq "(vite|npm run dev|QuickClip|$FRONTEND_DIR)"; then
        echo "Stopping stale frontend dev server on port $FRONTEND_PORT (PID $pid)"
        kill "$pid" 2>/dev/null || true
        sleep 1
    else
        echo "ERROR: 端口 $FRONTEND_PORT 已被其他程序占用：$cmd"
        echo "请先释放该端口，或设置环境变量 VITE_PORT 后重试。"
        exit 1
    fi
}

backend_ready() {
    curl --silent --fail --max-time 2 --connect-timeout 1 "$BACKEND_READY_URL" >/dev/null 2>&1
}

# ---------- ensure venv exists ----------
ensure_venv() {
    if [ -x "$VENV_PYTHON" ]; then
        echo "Virtual environment found at $VENV_DIR"
        return 0
    fi

    echo "Creating Python virtual environment at $VENV_DIR ..."
    if ! command -v "$SYSTEM_PYTHON" &>/dev/null; then
        echo "ERROR: Python 3 not found. Please install Python 3.9+ first."
        exit 1
    fi

    "$SYSTEM_PYTHON" -m venv "$VENV_DIR"
    echo "Virtual environment created."
}

# ---------- ensure deps installed ----------
ensure_deps() {
    local req_file="$BACKEND_DIR/requirements.txt"
    if [ ! -f "$req_file" ]; then
        echo "WARNING: requirements.txt not found at $req_file"
        return 0
    fi

    # Quick check: try importing a key package
    if "$VENV_PYTHON" -c "import funasr, imageio_ffmpeg" 2>/dev/null; then
        echo "Core dependencies OK"
        return 0
    fi

    echo "Installing Python dependencies from requirements.txt ..."
    "$VENV_PYTHON" -m pip install --upgrade pip -q
    "$VENV_PYTHON" -m pip install -r "$req_file"
    echo "Dependencies installed."
}

# ---------- start backend ----------
start_backend() {
    mkdir -p "$BACKEND_MODEL_CACHE"
    (
        cd "$BACKEND_DIR"
        exec env \
            HOME="$BACKEND_DIR" \
            MODELSCOPE_CACHE="$BACKEND_MODEL_CACHE" \
            APP_BACKEND_PORT="$BACKEND_PORT" \
            "$VENV_PYTHON" -m uvicorn main:app --app-dir app --host 127.0.0.1 --port "$BACKEND_PORT" >>"$BACKEND_LOG" 2>&1
    ) &
    echo "Backend started (PID $!)"
}

# ---------- wait for backend ----------
wait_for_backend() {
    local max_wait=60
    for i in $(seq 1 $max_wait); do
        if backend_ready; then
            echo "Backend ready on port $BACKEND_PORT"
            return 0
        fi
        sleep 1
    done
    echo "WARNING: Backend did not become ready after ${max_wait}s"
    echo "Check log: $BACKEND_LOG"
    return 1
}

# ========== main ==========

if backend_ready; then
    echo "Backend already running on port $BACKEND_PORT"
else
    kill_old_backends
    ensure_venv
    ensure_deps
    echo "Starting Python backend..."
    start_backend
    (
        if wait_for_backend; then
            echo "Backend warm-up finished"
        fi
    ) &
fi

cd "$FRONTEND_DIR"
kill_conflicting_frontend
exec env VITE_API_BASE_URL="http://127.0.0.1:${BACKEND_PORT}" npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT" --strictPort
