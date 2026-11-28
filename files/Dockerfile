# Built from the repository root: docker build -f files/Dockerfile .
# Node runs the TypeScript directly; there is no build step and no dependency to install.
FROM node:22-slim
ENV NODE_ENV=production FILES_STORE=gcs PORT=8080
WORKDIR /app
COPY intent/blocks/ intent/blocks/
COPY files/package.json files/LICENSE files/
COPY files/src/ files/src/
RUN find intent/blocks -name '*.test.ts' -delete && chown -R node:node /app
USER node
EXPOSE 8080
CMD ["node", "files/src/main.ts"]
