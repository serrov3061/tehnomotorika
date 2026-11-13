# Бот записи ТехноМоторики для bothost (код бота — в папке bot/).
FROM node:22-alpine
WORKDIR /usr/src/app
COPY bot/ ./
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000
RUN mkdir -p /app/data && chmod 777 /app/data
EXPOSE 3000
CMD ["node", "--no-warnings", "server.mjs"]
