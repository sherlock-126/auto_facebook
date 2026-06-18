# nextclaw cloud (cloud-only): dashboard + signup + agent API + classifier + telegram.
# NO Chrome/Playwright browser — scraping happens on customer agents, not here.
FROM node:20-slim

# bash + tar for scripts/build-agent.sh; postgresql-client for the migration entrypoint.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash tar gzip postgresql-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Never download Playwright's bundled browsers — the cloud never launches one.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Compile Tailwind + build the agent tarball served at /agent/latest.tgz.
RUN npm run build:css && bash scripts/build-agent.sh

EXPOSE 4200
ENTRYPOINT ["bash", "docker-entrypoint.sh"]
CMD ["npx", "tsx", "src/server.ts"]
