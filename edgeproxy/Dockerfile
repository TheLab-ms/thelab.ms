# Built for RouterOS (linux/arm64) by .github/workflows/edgeproxy-image.yml.
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /conwayedge .

# FFmpeg reads RTSPS cameras (X-series and P2S printers).
FROM alpine:3.23
RUN apk add --no-cache ca-certificates ffmpeg
COPY --from=build /conwayedge /usr/local/bin/conwayedge
VOLUME /data
EXPOSE 8080 8081
ENTRYPOINT ["/usr/local/bin/conwayedge"]
CMD ["-lan", ":8080", "-tunnel", ":8081", "-data", "/data"]
