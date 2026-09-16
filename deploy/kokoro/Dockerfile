FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./

ENV PORT=3333
ENV HF_HOME=/var/lib/kokoro/hf
ENV KOKORO_DTYPE=q8

EXPOSE 3333

CMD ["node", "server.mjs"]
