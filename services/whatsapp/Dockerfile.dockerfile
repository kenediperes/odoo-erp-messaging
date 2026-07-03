FROM node:18-alpine
RUN apk add --no-cache git
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN mkdir -p sessions
CMD ["node", "index.js"]
