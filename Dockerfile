FROM node:20-alpine

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV DISPATCH_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
COPY package*.json ./
RUN npm install --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
COPY start.sh ./start.sh
RUN chmod +x ./start.sh
COPY .env.example ./.env.example
COPY README.md ./README.md
EXPOSE 3000
CMD ["./start.sh"]
