# syntax=docker/dockerfile:1

FROM node:18

WORKDIR /app

COPY ["package.json", "package-lock.json*", "./"]
RUN ls -a
# Install dependencies for puppeteer
RUN apt update -y
RUN apt-get install libnss3 -y
RUN apt-get install -y gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget libgbm1


RUN npm install
COPY . .
# RUN npm test
RUN npm run build
CMD [ "node", "dist/server.js" ]
# To Start the Specific Consumer
# CMD ["node", "dist/consumers/index.js","--consumer=notification"] 