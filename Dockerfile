FROM node:20-alpine
WORKDIR /app
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
