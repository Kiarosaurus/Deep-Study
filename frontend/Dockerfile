# Build stage — produce the static bundle.
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# VITE_FLAG_SENTENCE is left unset by default. Override at build time with
# `--build-arg VITE_FLAG_SENTENCE=1` if you want diagnostic logs baked in.
ARG VITE_FLAG_SENTENCE
ENV VITE_FLAG_SENTENCE=${VITE_FLAG_SENTENCE}

RUN npm run build


# Serve stage — nginx hosts the static bundle and proxies /api to backend.
FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 5173

CMD ["nginx", "-g", "daemon off;"]
