FROM node:20-slim

RUN addgroup --system app && adduser --system --ingroup app app

WORKDIR /app
COPY package.json .
RUN npm install --production
COPY src/ src/

RUN mkdir -p /home/node/exports && chown -R app:app /home/node/exports /app

USER app
EXPOSE 3099

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3099/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "src/index.js"]
