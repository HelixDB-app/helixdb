# pgStudio / HelixDB — common targets
# Run: make help

.PHONY: help dev start build build-mac build\:mac push-mac push\:mac lint

# Default: show help
help:
	@echo "pgStudio targets:"
	@echo "  make dev        — Run Tauri dev (Next.js + app window)"
	@echo "  make start     — Run Next.js production server (pnpm start)"
	@echo "  make build     — Build Next.js static export (pnpm build)"
	@echo "  make build:mac — Build macOS app (current arch, no TestFlight)"
	@echo "  make push:mac  — Build universal macOS app, sign, upload to TestFlight (--no-bump)"
	@echo "  make lint      — Run ESLint"

# Tauri dev: runs pnpm dev and opens the app window
dev:
	pnpm tauri dev

# Next.js production server (after make build)
start:
	pnpm start

# Next.js static export only
build:
	pnpm build

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
