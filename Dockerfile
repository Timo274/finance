FROM node:20-bookworm-slim

# better-sqlite3 — нативный модуль, нужны инструменты сборки на этапе install.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/app.db
EXPOSE 8080

CMD ["node", "server.js"]
