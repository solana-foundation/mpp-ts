set shell := ["bash", "-uc"]

default:
    @just --list

# Audit production dependencies for vulnerabilities
audit:
    pnpm audit --production

# Format and lint
fmt:
    pnpm lint:fix
    pnpm format

# Build
build:
    pnpm build

# Typecheck
typecheck:
    pnpm typecheck

# Unit tests
test:
    pnpm test

# Integration tests (requires Surfpool)
test-integration:
    pnpm test:integration

# All tests
test-all: test test-integration

# Pre-commit: audit + fmt + typecheck + unit tests
pre-commit: audit fmt typecheck test
