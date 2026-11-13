FROM node:20-alpine AS runner

WORKDIR /app

# Install openssh-client, sshpass, and tar/gzip utilities for real router communications
RUN apk add --no-cache openssh-client sshpass tar gzip tzdata

# Set production environment
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV BACKUP_DIR=/backups
ENV PORT=8080

# Create required directories
RUN mkdir -p /data /backups /app

# Copy dependency specifications
COPY package*.json ./
RUN npm install --omit=dev || true

# Copy application backend and frontend assets
COPY server/ ./server/
COPY public/ ./public/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 8080) + '/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1))"

CMD ["node", "server/index.js"]
