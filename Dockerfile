# UNTESTED: no docker daemon on the dev box (Termux). Built to be boring on purpose.
# Needs a real device relay client somewhere it can reach this container.
FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV HERNAS_DATA=/data
VOLUME /data
EXPOSE 7420
CMD ["node", "src/server.ts"]
