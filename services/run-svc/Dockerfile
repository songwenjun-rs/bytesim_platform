# syntax=docker/dockerfile:1.7
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Build the main binary + a tiny healthcheck CLI in the same stage so both
# can be copied into the distroless final image.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/run-svc ./cmd/run-svc \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/healthcheck ./cmd/healthcheck

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/run-svc /run-svc
COPY --from=build /out/healthcheck /healthcheck
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 CMD ["/healthcheck"]
ENTRYPOINT ["/run-svc"]
