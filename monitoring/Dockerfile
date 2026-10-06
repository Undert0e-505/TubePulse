FROM node:22.20.0-alpine3.22@sha256:dbcedd8aeab47fbc0f4dd4bffa55b7c3c729a707875968d467aaaea42d6225af

WORKDIR /app
COPY src ./src
USER node
EXPOSE 9464
CMD ["node", "src/collector.mjs"]
