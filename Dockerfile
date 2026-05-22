FROM node:20-alpine

RUN apk add --no-cache ghostscript

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p uploads outputs

EXPOSE 666

CMD ["node", "server.js"]
