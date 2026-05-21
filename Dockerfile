FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/

RUN npm run build

# Prune dev dependencies in the builder so we can copy node_modules directly
# into the runner without a second npm ci (avoids OOM in constrained containers)
RUN npm prune --omit=dev

# ---

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Chromium + deps for the nightly Playwright SOS scraper.
# The scraper runs at 2am UTC via cron — not on every request.
# PLAYWRIGHT_BROWSERS_PATH tells playwright to use the system Chromium.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      curl

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules

COPY --from=builder /app/dist ./dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fs http://localhost:3000/health || exit 1

CMD ["node", "dist/src/index.js"]
