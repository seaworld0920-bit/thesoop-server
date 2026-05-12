FROM node:18-slim

# ffmpeg 설치
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-nanum \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
