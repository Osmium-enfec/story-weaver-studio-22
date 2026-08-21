# syntax=docker/dockerfile:1

FROM registry.digitalocean.com/prod-enfec/divstudio-base:latest AS deps

WORKDIR /app

COPY package.json ./
COPY package-lock.json* bun.lock* ./

RUN if [ -f package-lock.json ]; then \
      npm ci; \
    else \
      npm install; \
    fi

FROM registry.digitalocean.com/prod-enfec/divstudio-base:latest AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright

RUN npm run build

FROM registry.digitalocean.com/prod-enfec/divstudio-base:latest AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV ENFEC_SELF_HOSTED=1
ENV ENFEC_DATA_ROOT=/var/lib/divstudio/data
ENV ENFEC_SCRATCH_ROOT=/var/lib/divstudio/scratch

COPY --from=build /app/.output ./.output
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/scripts ./scripts

RUN mkdir -p /var/lib/divstudio/data /var/lib/divstudio/scratch \
    && chown -R node:node /var/lib/divstudio /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
