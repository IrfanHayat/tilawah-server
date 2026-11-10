FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=200
ENV MODEL_CACHE_DIR=/app/models
EXPOSE 8787
CMD ["node", "dist/index.js"]
