# 单进程同时提供 API 与静态页（web/index.html）。
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

ENV INVEST_HOST=0.0.0.0
ENV INVEST_PORT=8787
ENV INVEST_DB_PATH=/app/data/invest.sqlite

ARG NPM_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=$NPM_REGISTRY

COPY server ./server
COPY web ./web

RUN mkdir -p /app/data

EXPOSE 8787
CMD ["node", "server/index.js"]
