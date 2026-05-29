FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
COPY .env.example ./.env.example
COPY README.md ./README.md
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js & sleep 3 && node src/workers/jobWorker.js & wait"]
