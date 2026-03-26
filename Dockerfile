# NanoClaw — Main Process
# Handles WhatsApp + Telegram channel polling and message routing.
# Builds TypeScript on container start so git pull + docker restart is all you need.

FROM node:22-slim

# Install system dependencies for Chromium (used by BrowserAgent)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Expose no ports — outbound only (WhatsApp/Telegram APIs)

# Start the main nanoclaw process
CMD ["node", "dist/index.js"]
