FROM node:20-slim

WORKDIR /app
COPY package.json .
RUN npm install --production
COPY src/ src/

EXPOSE 3099
CMD ["node", "src/index.js"]
