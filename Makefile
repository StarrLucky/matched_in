# matched_in — the quality gates.
#
#   make          lint, unit tests, end-to-end tests
#   make help     everything you can run
#
# No dependencies to install: the linter and both test suites are plain Node.

NODE ?= node
UNIT := test/unit/*.test.mjs
E2E  := test/e2e/*.test.mjs

.DEFAULT_GOAL := check
.PHONY: check lint unit e2e test run demo clean help node-version

## check: the full gate — run this before you commit
check: lint unit e2e
	@echo ""
	@echo "  ✓ lint, unit and end-to-end all pass"

## lint: every file parses, including the snippets injected into the page
lint: node-version
	@$(NODE) scripts/lint.mjs

## unit: the store and the LinkedIn driver, with the page faked out
unit: node-version
	@$(NODE) --test $(UNIT)

## e2e: the server over real HTTP, and the UI in headless Chrome
e2e: node-version
	@$(NODE) --test $(E2E)

## test: both test suites, without the linter
test: unit e2e

## run: start the app against LinkedIn
run: node-version
	@$(NODE) server/server.mjs

## demo: start the app on fixture profiles — no Chrome, nothing sent
demo: node-version
	@DEMO=1 $(NODE) server/server.mjs

## clean: remove the throwaway profiles and state the tests leave behind
clean:
	@rm -rf "$${TMPDIR:-/tmp}"/matched-in-e2e-* "$${TMPDIR:-/tmp}"/matched-in-ui-* "$${TMPDIR:-/tmp}"/matched-in-store-*
	@echo "  cleaned up test leftovers"

# The e2e tests drive Chrome through CDP and the server uses fetch and WebSocket
# from the platform, so an old Node fails in confusing ways rather than clearly.
node-version:
	@$(NODE) -e 'const major = Number(process.versions.node.split(".")[0]); \
	  if (major < 22) { console.error(`  Node 22+ required — this is ${process.versions.node}`); process.exit(1); }'

help:
	@echo ""
	@echo "  matched_in"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  make /' | sed 's/:/ —/'
	@echo ""
