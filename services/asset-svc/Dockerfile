# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/asset-svc ./cmd/asset-svc \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/healthcheck ./cmd/healthcheck

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/asset-svc /asset-svc
COPY --from=build /out/healthcheck /healthcheck
EXPOSE 8082
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 CMD ["/healthcheck"]
ENTRYPOINT ["/asset-svc"]
