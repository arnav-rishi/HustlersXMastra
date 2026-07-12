# syntax=docker/dockerfile:1
#
# Custom Prometheus image: bakes in prometheus.yml with its one
# environment-specific value (the otel-collector scrape target) substituted
# at build time. Prometheus's config format has no native env-var expansion
# (unlike the OTel Collector's ${env:VAR}), so this uses a build-time `sed`
# instead — the base image's busybox shell has `sed` built in, no extra
# packages needed.
#
# Build from the monorepo root:
#   docker build -f infra/prometheus/Dockerfile -t lexguard-prometheus \
#     --build-arg OTEL_COLLECTOR_TARGET=otel-collector:8888 .

FROM prom/prometheus:v2.52.0
ARG OTEL_COLLECTOR_TARGET=otel-collector:8888
COPY infra/prometheus/prometheus.yml /etc/prometheus/prometheus.yml
USER root
RUN sed -i "s#otel-collector:8888#${OTEL_COLLECTOR_TARGET}#" /etc/prometheus/prometheus.yml
USER nobody
