# syntax=docker/dockerfile:1
# Self-host build — no private registry dependency (fresh-droplet friendly).

FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package.json ./
COPY package-lock.json* bun.lock* ./

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN if [ -f package-lock.json ]; then \
      npm ci; \
    else \
      npm install; \
    fi

FROM deps AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production

RUN npm run build

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV ENFEC_SELF_HOSTED=1
ENV ENFEC_DATA_ROOT=/var/lib/divstudio/data
ENV ENFEC_SCRATCH_ROOT=/var/lib/divstudio/scratch
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
ENV FFMPEG_PATH=/usr/bin/ffmpeg

# ffmpeg for audio/video materialization; Playwright Chromium for server-side export jobs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm i -g playwright@1.61.1 --silent \
    && npx playwright install --with-deps chromium

COPY --from=build /app/.output ./.output
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts

RUN mkdir -p /var/lib/divstudio/data /var/lib/divstudio/scratch /opt/playwright \
    && chown -R node:node /var/lib/divstudio /app /opt/playwright

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
