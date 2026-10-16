FROM oven/bun:1.2.18 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json playwright.config.ts .prettierrc.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY fixtures ./fixtures
COPY evals ./evals
RUN bun run check && bun run build

FROM oven/bun:1.2.18 AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 AGENT_MODE=live SESSION_DB_PATH=/app/.data/sessions.sqlite
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && mkdir -p /app/.data /app/artifacts && chown bun:bun /app/.data /app/artifacts && chmod 700 /app/.data /app/artifacts
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/fixtures ./fixtures
COPY --from=build /app/evals ./evals
COPY --from=build /app/dist ./dist
USER bun
VOLUME ["/app/.data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 CMD bun -e 'const r=await fetch("http://127.0.0.1:3000/health");process.exit(r.ok?0:1)'
CMD ["bun", "src/server.ts"]
