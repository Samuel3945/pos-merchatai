# ── Etapa 1: build del estático ─────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# Instalar deps (cache-friendly)
COPY package*.json ./
RUN npm ci

# La URL del backend MerchantAI se HORNEA en el build (Vite).
# El cajero NO se conecta a Postgres: habla por HTTP con /api/pos/*.
ARG VITE_API_URL=https://app.mymerchantai.com
ENV VITE_API_URL=$VITE_API_URL

COPY . .
RUN npm run build

# ── Etapa 2: servir con nginx ───────────────────────────────
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
