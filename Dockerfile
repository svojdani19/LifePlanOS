# LifePlanOS production image.
#
# Debian slim rather than Alpine, unlike the ai-ready-kids image this mirrors.
# That project stores everything in `node:sqlite` and compiles nothing; this one
# depends on @napi-rs/canvas, tesseract.js and pdfjs-dist for the OCR path.
# @napi-rs/canvas ships glibc prebuilds, and on Alpine's musl it either fails to
# resolve a binary or loads one that segfaults at first use — a failure that
# would not appear until a scanned PDF was actually uploaded.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# The Prisma client is generated into src/generated/prisma, which is NOT
# committed — so it must be produced here or the build fails on the first
# `@/lib/db` import. `prisma generate` needs no database connection.
RUN npx prisma generate
RUN npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# `output: "standalone"` leaves a self-contained server here.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Prisma's query engine and the generated client are traced into standalone,
# but the schema is read at runtime for migrations and is not traced with it.
COPY --from=build /app/prisma ./prisma

# No ENV PORT here, deliberately — the same mistake the ai-ready-kids image
# documents. Railway injects its own PORT and a baked-in value is silently
# overridden, so the server would bind one port while the generated domain
# pointed at another and every request returned 502. Next's standalone server
# reads process.env.PORT and defaults to 3000; the platform owns that choice.
CMD ["node", "server.js"]
