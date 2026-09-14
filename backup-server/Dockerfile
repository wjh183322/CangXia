FROM node:24-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY backup-server ./backup-server
COPY shared ./shared
ENV DATA_DIR=/data PORT=8443
VOLUME ["/data"]
EXPOSE 8443
CMD ["node", "backup-server/index.mjs"]
