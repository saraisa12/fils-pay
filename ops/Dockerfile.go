# apps/settlement: multi-stage build, static binary, built from the repo root.
FROM golang:1.22-bookworm AS build
WORKDIR /src/apps/settlement
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement

FROM gcr.io/distroless/static-debian12:nonroot
# time/tzdata is compiled into the binary, so Asia/Bahrain needs nothing from the image.
COPY --from=build /out/settlement /settlement
EXPOSE 8091
ENTRYPOINT ["/settlement"]
CMD ["daemon"]
