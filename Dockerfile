# The Student Advocate demonstration, its admin, the published docs and the factory console, in one service.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages packages
COPY apps apps
COPY control control
RUN npm ci --no-audit --no-fund && npm cache clean --force
# Built by the factory in this same run: docs and console pages, screenshots and video.
COPY site-out site-out
ENV NODE_ENV=production ADVOCATE_DEMO=1 ADVOCATE_BASE=/advocate ADVOCATE_TODAY=2026-11-02 PORT=8080
EXPOSE 8080
USER node
CMD ["node", "--import", "tsx", "apps/advocate/src/server/main.ts"]
