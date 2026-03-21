# pgStudio / HelixDB — common targets
# Run: make help

.PHONY: help dev start build build-mac build\:mac push-mac push\:mac lint data-plane compose-up icons

# Default: show help
help:
	@echo "pgStudio targets:"
	@echo "  make dev        — Run Tauri dev (Next.js + app window)"
	@echo "  make start     — Run Next.js production server (pnpm start)"
	@echo "  make build     — Build Next.js static export (pnpm build)"
	@echo "  make build:mac — Build macOS app (current arch, no TestFlight)"
	@echo "  make push:mac  — Build universal macOS app, sign, upload to TestFlight (--no-bump)"
	@echo "  make lint      — Run ESLint"
	@echo "  make data-plane — Run HTTP API locally (cargo)"
	@echo "  make compose-up — docker compose up (API + Redis)"
	@echo "  make icons      — Regenerate Tauri/macOS/Android/iOS icons from public/logo.png"

# Tauri dev: runs pnpm dev and opens the app window
dev:
	pnpm tauri dev

# Next.js production server (after make build)
start:
	pnpm start

# Next.js static export only
build:
	pnpm build

push:
	./apple/build-and-upload-testflight.sh

# macOS app build (single arch, for local/testing). Uses package.json build:mac.
build-mac:
	pnpm run build:mac

# Same as build-mac (make build:mac)
build\:mac: build-mac

# Full TestFlight pipeline: universal build → sign → .pkg → upload (no version bump).
# Requires apple/.env with signing identities and App Store Connect API key.
push-mac:
	./apple/build-and-upload-testflight.sh --no-bump

# Same as push-mac (make push:mac)
push\:mac: push-mac

lint:
	pnpm run lint

# Rust data plane (phase-1 REST). Set DATA_PLANE_BIND, REDIS_URL, DATA_PLANE_API_KEY as needed.
data-plane:
	cd data-plane && cargo run --release

compose-up:
	docker compose up --build

# Source: public/logo.png (square 1024 master + all bundle sizes). Requires magick (ImageMagick).
icons:
	magick public/logo.png -resize '900x900>' -background '#0c1524' -gravity center -extent 1024x1024 src-tauri/icons/app-icon-source.png
	cd src-tauri && cargo tauri icon icons/app-icon-source.png --ios-color '#0c1524'
	cp src-tauri/icons/ios/*.png src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/
