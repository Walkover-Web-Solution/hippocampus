# Use a Node.js base image (Debian-based to easily install Python)
FROM node:20-bullseye

# 1. Install System Dependencies (Python & build tools)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app
# Install dependencies for puppeteer
RUN apt update -y
RUN apt-get install libnss3 -y
RUN apt-get install -y gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget libgbm1

# 2. Install Node.js Dependencies
COPY package*.json ./
RUN npm ci

# 3. Setup Python Environment
# We create the venv exactly where your PM2 config expects it: ./fastembed/venv
WORKDIR /app/fastembed
COPY fastembed/requirements.txt ./
RUN python3 -m venv venv && \
    ./venv/bin/pip install --no-cache-dir -r requirements.txt

# Return to root for building the app
WORKDIR /app

# 4. Copy Source Code & Build
COPY . .
# Run the build script to generate the ./dist folder
RUN npm run build

# 5. Install PM2 globally
RUN npm install pm2 -g

# 6. Expose the API Port (Change 3000 to your actual port)
EXPOSE 3000

# 7. Start the app using pm2-runtime (specifically meant for Docker)
# We use the ecosystem file you provided
CMD ["pm2-runtime", "start", "ecosystem.config.js"]