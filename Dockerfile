FROM node:20-bookworm-slim AS builder

WORKDIR /app

ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_PREFER_LOCAL_LOGIN
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY
ENV VITE_PREFER_LOCAL_LOGIN=$VITE_PREFER_LOCAL_LOGIN

COPY . /app

RUN npm ci
RUN npm ci --prefix client
RUN npm run build

FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/server /app/server
COPY --from=builder /app/shared /app/shared
COPY --from=builder /app/client/dist /app/client/dist
COPY --from=builder /app/database /app/database
COPY --from=builder /app/package.json /app/package.json

RUN mkdir -p /data

EXPOSE 8080

CMD ["node", "server/src/index.js"]
