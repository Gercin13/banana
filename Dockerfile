# Nano Studio — production image. Runs anywhere Docker runs (local, VPS, PaaS).
FROM node:20-alpine

WORKDIR /app

# Install only production deps first (better layer caching).
COPY package*.json ./
RUN npm install --omit=dev

# App source.
COPY . .

ENV NODE_ENV=production
# Where generated images + history are stored (mount a volume here to persist).
ENV DATA_DIR=/app/data

EXPOSE 3000

# Persistence: mount a volume / host dir at /app/data.
#  - Local:   docker-compose maps ./data:/app/data
#  - Railway: add a Volume with mount path /app/data
# (The Docker VOLUME instruction is intentionally omitted — Railway rejects it.)
CMD ["node", "server.js"]
