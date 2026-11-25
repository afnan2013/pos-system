FROM node:26.13.1-alpine AS dev
RUN mkdir -p /app/api /app/web && chown -R node:node /app
USER node
WORKDIR /app/api
COPY --chown=node:node api/package.json api/package-lock.json ./
RUN npm ci
WORKDIR /app/web
COPY --chown=node:node web/package.json web/package-lock.json ./
RUN npm ci

FROM node:26.13.1-alpine AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:26.13.1-alpine AS api-build
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci
COPY api/ ./
RUN npm run build && npm prune --omit=dev

FROM node:26.13.1-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/api
COPY --from=api-build /app/api/package.json ./
COPY --from=api-build /app/api/node_modules ./node_modules
COPY --from=api-build /app/api/dist ./dist
COPY api/migrations ./migrations
COPY --from=web-build /app/web/dist ./public
COPY deploy /app/deploy
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.HTTP_PORT || 3000}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
