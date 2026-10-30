# The cloud host: Synapse, the Google Messages bridge, the bot and Litestream in one image (see docs/cloud.md).
# Not built or run yet; the first build is the spike in the plan, and the pins below are the first thing to check.
ARG PYTHON_VERSION=3.12
ARG NODE_VERSION=24
ARG SYNAPSE_VERSION=1.143.0
# upstream main when the self-unpair fix landed (c1b622f); use a release once one includes it
ARG BRIDGE_REF=186284e
ARG LITESTREAM_VERSION=0.5.17

# The bridge, from source with the pure-Go olm (no libolm to build), as on the Mac, with every patch in deploy/cloud/patches.
# stream-media.patch passes a file from the homeserver to Google through a file on disk, encrypted as it is sent (about
# 4 MB of memory for a 100 MB album zip, against about 4 times the file without it), and logs where its time goes.
# dedup-dm-txn.patch is upstream's fix (dbbd04de) for the DM dedup that held the bridge's database lock 5 s at a time.
# only-self-chat.patch keeps the bridge to the "message yourself" chat (GMESSAGES_ALL_CHATS=1 bridges every chat again):
# the other chats were most of the host's monthly traffic, through the homeserver's database backups.
# Their tests run here, so a new BRIDGE_REF that breaks either fails the build.
FROM golang:1-bookworm AS bridge
ARG BRIDGE_REF
COPY deploy/cloud/patches/ /patches/
RUN git clone https://github.com/mautrix/gmessages /src \
 && cd /src && git checkout "${BRIDGE_REF}" \
 && for p in /patches/*.patch; do git apply "$p" || exit 1; done \
 && go test -tags goolm ./pkg/libgm/crypto/ ./pkg/libgm/ ./pkg/connector/ \
 && go build -tags goolm -trimpath -ldflags "-s -w" -o /out/mautrix-gmessages ./cmd/mautrix-gmessages

FROM python:${PYTHON_VERSION}-slim-bookworm AS synapse
ARG SYNAPSE_VERSION
# prometheus-client 0.24 broke Synapse 1.143.0; requests is for register_new_matrix_user
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir "matrix-synapse==${SYNAPSE_VERSION}" "prometheus-client<0.24" requests

FROM node:${NODE_VERSION}-bookworm-slim AS node
FROM litestream/litestream:${LITESTREAM_VERSION} AS litestream

FROM python:${PYTHON_VERSION}-slim-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 app \
 && mkdir -p /data /run/mors /app \
 && chown app:app /data /run/mors /app
COPY --from=synapse /opt/venv /opt/venv
COPY --from=bridge /out/mautrix-gmessages /usr/local/bin/mautrix-gmessages
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY deploy/cloud/litestream.yml /etc/litestream.yml
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY deploy/cloud ./deploy/cloud
USER app
ENV PORT=8080 DATA_DIR=/data TZ=America/New_York NODE_ENV=production
EXPOSE 8080
ENTRYPOINT ["tini", "--"]
# The supervisor does little; its memory is kept small, for the bot and the homeserver.
CMD ["node", "--disable-warning=ExperimentalWarning", "--max-old-space-size=32", "--max-semi-space-size=1", "deploy/cloud/entrypoint.ts"]
