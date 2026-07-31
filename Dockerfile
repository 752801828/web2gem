FROM node:26-alpine AS deps

WORKDIR /app
ARG PNPM_VERSION=11.10.0
RUN npm install -g pnpm@${PNPM_VERSION}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY tsconfig.json ./
COPY scripts ./scripts
COPY server ./server
COPY src ./src
COPY migrations ./migrations
RUN pnpm build

FROM node:26-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=52389

COPY --from=build /app/dist/app.js ./dist/app.js
COPY --from=build /app/server/docker-server.mjs ./server/docker-server.mjs
COPY --from=build /app/server/credential-crypto.mjs ./server/credential-crypto.mjs
COPY --from=build /app/server/secrets.mjs ./server/secrets.mjs
COPY --from=build /app/server/sqlite-binding.mjs ./server/sqlite-binding.mjs
COPY --from=build /app/server/io.mjs ./server/io.mjs
COPY --from=build /app/migrations ./migrations

EXPOSE 52389
CMD ["node", "server/docker-server.mjs"]
