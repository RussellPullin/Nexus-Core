#!/bin/bash
# Start Ollama in the background for Nexus Core AI (NDIS extraction, intake, CSV mapping).
# Usage: ./start-ollama.sh   or   bash start-ollama.sh

OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
OLLAMA_MODEL="${OLLAMA_MODEL:-qwen2.5:14b}"

# Check if Ollama is already running
if curl -s -f --connect-timeout 2 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
  echo "Ollama is already running at $OLLAMA_URL"
  echo "Model in use: $OLLAMA_MODEL (ensure it's pulled: ollama pull $OLLAMA_MODEL)"
  exit 0
fi

# Check if ollama CLI is available
if ! command -v ollama &>/dev/null; then
  echo "Ollama is not installed. Install it from https://ollama.com"
  echo "On macOS: brew install ollama   or download from https://ollama.com/download"
  exit 1
fi

echo "Starting Ollama server in the background..."
nohup ollama serve >> /tmp/ollama-serve.log 2>&1 &
OLLAMA_PID=$!
echo "Ollama PID: $OLLAMA_PID (log: /tmp/ollama-serve.log)"

# Wait for server to be ready (up to 10 seconds)
for i in {1..10}; do
  if curl -s -f --connect-timeout 1 "$OLLAMA_URL/api/tags" >/dev/null 2>&1; then
    echo "Ollama is up at $OLLAMA_URL"
    echo "Ensure model is available: ollama pull $OLLAMA_MODEL"
    exit 0
  fi
  sleep 1
done

echo "Ollama may still be starting. Check: tail -f /tmp/ollama-serve.log"
echo "Then run: ollama pull $OLLAMA_MODEL"
exit 0
