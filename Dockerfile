FROM golang:1.25-alpine AS go-build
WORKDIR /src/go-backend
COPY go-backend/go.mod go-backend/go.sum ./
RUN go mod download
COPY go-backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/escrow-backend .

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AI_URL=http://127.0.0.1:8001/evaluate
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY ai-service/requirements.txt ./ai-service/requirements.txt
RUN pip install --no-cache-dir -r ./ai-service/requirements.txt
COPY ai-service/main.py ai-service/evaluator.py ./ai-service/
COPY --from=go-build /out/escrow-backend ./escrow-backend
COPY deploy/start-services.sh ./start-services.sh
COPY go-backend/schema.sql ./schema.sql
EXPOSE 8080
CMD ["sh", "./start-services.sh"]
