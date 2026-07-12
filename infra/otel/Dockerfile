# syntax=docker/dockerfile:1
#
# Custom OTel Collector image: bakes in collector-config.yml since Azure
# Container Apps has no equivalent to docker-compose's config-file volume
# mount. JAEGER_ENDPOINT (the one environment-specific value in the config)
# is resolved at container startup via the collector's own ${env:VAR}
# substitution — no build-time templating needed here.
#
# Build from the monorepo root:
#   docker build -f infra/otel/Dockerfile -t lexguard-otel-collector .

FROM otel/opentelemetry-collector-contrib:0.101.0
COPY infra/otel/collector-config.yml /etc/otel/config.yaml
CMD ["--config=/etc/otel/config.yaml"]
