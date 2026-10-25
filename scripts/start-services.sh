#!/bin/sh
set -eu

cd /app/ai-service
python -m uvicorn main:app --host 127.0.0.1 --port 8001 &

cd /app
exec ./escrow-backend
