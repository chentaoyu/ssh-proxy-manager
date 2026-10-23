# 国内网络可换镜像源：
#   --build-arg BASE=docker.m.daocloud.io/library/node:22-bookworm-slim
#   --build-arg APT_MIRROR=mirrors.ustc.edu.cn
ARG BASE=node:22-bookworm-slim
FROM ${BASE}
ARG APT_MIRROR=

RUN if [ -n "$APT_MIRROR" ]; then sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client iproute2 lsof iputils-ping procps curl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json *.js ./
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=17900 \
    DATA_DIR=/data \
    DEFAULT_BIND=0.0.0.0

VOLUME /data
EXPOSE 17900

# tini 负责回收 ssh 子进程
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
