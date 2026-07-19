#!/bin/bash

# LiftOff bridge - Web Access (ngrok) Launcher
cd "$(dirname "$0")/.."

echo "==================================================="
echo "  LiftOff bridge - WEB ACCESS MODE"
echo "==================================================="
echo

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed. Please install Node.js 16+ to continue."
    exit 1
fi

# Check for .env
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "[INFO] Created .env from template."
    fi
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "[INFO] Installing dependencies..."
    npm install
fi

# Launch using Node.js launcher
echo "[INFO] Starting LiftOff bridge (Web Mode)..."
node launcher.js --mode web

echo ""
echo "[INFO] Server stopped."
read -p "Press Enter to exit..."
