# syntax=docker/dockerfile:1
#
# Custom Grafana image: bakes in the datasource + dashboard provisioning
# files, with the Prometheus datasource URL substituted at build time (same
# reasoning as infra/prometheus/Dockerfile — no native env-var expansion in
# this config format). Admin credentials are NOT baked in here — those stay
# as a runtime env var (GF_SECURITY_ADMIN_PASSWORD) set on the Container App
# itself, not embedded in an image layer anyone with ACR pull access could read.
#
# Build from the monorepo root:
#   docker build -f infra/grafana/Dockerfile -t lexguard-grafana \
#     --build-arg PROMETHEUS_TARGET=http://prometheus:9090 .

FROM grafana/grafana:10.4.0
ARG PROMETHEUS_TARGET=http://prometheus:9090
USER root
COPY infra/grafana/datasources /etc/grafana/provisioning/datasources
COPY infra/grafana/dashboards /etc/grafana/provisioning/dashboards
RUN sed -i "s#http://prometheus:9090#${PROMETHEUS_TARGET}#" /etc/grafana/provisioning/datasources/prometheus.yml \
    && chown -R 472:472 /etc/grafana/provisioning
USER 472
