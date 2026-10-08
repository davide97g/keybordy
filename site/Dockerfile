# keybordy MP landing page. Built from the repo root (see compose.yml), because the page reuses the
# teaser's model code (video/app/src/model), the layout (layout/macropad.json) and the simulator's fonts.
FROM oven/bun:1.3-alpine AS build
WORKDIR /repo
COPY layout/macropad.json layout/
COPY video/app/src/model video/app/src/model
COPY video/app/src/engine/util.ts video/app/src/engine/
COPY sim/velxio/frontend/public/fonts sim/velxio/frontend/public/fonts
COPY site/package.json site/bun.lock site/
RUN cd site && bun install --frozen-lockfile
COPY site site
RUN cd site && bun x vite build

FROM nginx:1.29-alpine
COPY site/nginx.conf /etc/nginx/conf.d/default.conf
COPY site/headers.inc /etc/nginx/snippets/headers.inc
COPY --from=build /repo/site/dist /usr/share/nginx/html
