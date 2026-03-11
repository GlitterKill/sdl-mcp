#!/bin/bash
# utils.sh — secondary Shell fixture.
# Utility functions used by deploy.sh and other scripts.

retry_command() {
    local max_attempts="$1"
    local delay="$2"
    shift 2
    local attempt=1

    while [ "$attempt" -le "$max_attempts" ]; do
        if "$@"; then
            return 0
        fi
        echo "Attempt $attempt/$max_attempts failed. Retrying in ${delay}s..."
        sleep "$delay"
        attempt=$((attempt + 1))
    done
    return 1
}

wait_for_port() {
    local host="$1"
    local port="$2"
    local timeout="${3:-30}"
    local elapsed=0

    while [ "$elapsed" -lt "$timeout" ]; do
        if nc -z "$host" "$port" 2>/dev/null; then
            return 0
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    return 1
}

format_duration() {
    local seconds="$1"
    local minutes=$((seconds / 60))
    local remaining=$((seconds % 60))
    printf "%dm %ds" "$minutes" "$remaining"
}

get_memory_usage() {
    if [ -f /proc/meminfo ]; then
        local total
        local available
        total=$(grep MemTotal /proc/meminfo | awk '{print $2}')
        available=$(grep MemAvailable /proc/meminfo | awk '{print $2}')
        local used=$((total - available))
        echo "$((used / 1024))MB / $((total / 1024))MB"
    else
        echo "N/A"
    fi
}
