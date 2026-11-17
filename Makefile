# matched_in — the quality gates.
#
#   make          lint, security, unit tests, end-to-end tests
#   make help     everything you can run
#
# No dependencies to install: the linter, the security gate and both test suites
# are plain Node. The optional scanners (gitleaks, semgrep, sonar-scanner) are
# used when they are on your machine and skipped with a note when they are not.

NODE ?= node
UNIT := test/unit/*.test.mjs
E2E  := test/e2e/*.test.mjs

.DEFAULT_GOAL := check
.PHONY: check lint security unit e2e test coverage sonar run demo clean help node-version

## check: the full gate — run this before you commit
check: lint security unit e2e
	@echo ""
	@echo "  ✓ lint, security, unit and end-to-end all pass"

## lint: every file parses, including the snippets injected into the page
lint: node-version
	@$(NODE) scripts/lint.mjs

## security: secrets, this app's own invariants, and any scanner you have installed
security: node-version
	@$(NODE) scripts/security.mjs

## unit: the store and the LinkedIn driver, with the page faked out
unit: node-version
	@$(NODE) --test $(UNIT)

## e2e: the server over real HTTP, and the UI in headless Chrome
e2e: node-version
	@$(NODE) --test $(E2E)

## test: both test suites, without the linter
test: unit e2e

## coverage: coverage/lcov.info from the unit suite, for Sonar
coverage: node-version
	@mkdir -p coverage
	@$(NODE) --test --experimental-test-coverage \
	  --test-reporter=lcov --test-reporter-destination=coverage/lcov.info \
	  --test-reporter=dot --test-reporter-destination=stdout $(UNIT)
	@echo "  coverage/lcov.info"

## sonar: SonarQube analysis — needs SONAR_HOST_URL and SONAR_TOKEN
sonar: coverage
	@if [ -z "$$SONAR_TOKEN" ]; then \
	  echo "  SONAR_TOKEN is not set."; \
	  echo "  SonarCloud: make a token at https://sonarcloud.io/account/security, then"; \
	  echo "    SONAR_HOST_URL=https://sonarcloud.io SONAR_TOKEN=… make sonar"; \
	  echo "  A server of your own: docker run -d -p 9000:9000 sonarqube:lts-community"; \
	  exit 1; \
	fi; \
	org=""; \
	if [ -n "$$SONAR_ORGANIZATION" ]; then org="-Dsonar.organization=$$SONAR_ORGANIZATION"; fi; \
	if command -v sonar-scanner >/dev/null 2>&1; then \
	  sonar-scanner -Dsonar.host.url="$${SONAR_HOST_URL:-https://sonarcloud.io}" -Dsonar.token="$$SONAR_TOKEN" $$org; \
	elif command -v docker >/dev/null 2>&1; then \
	  echo "  sonar-scanner not installed — running it in Docker."; \
	  docker run --rm \
	    -e SONAR_HOST_URL="$${SONAR_HOST_URL:-https://sonarcloud.io}" \
	    -e SONAR_TOKEN="$$SONAR_TOKEN" \
	    -v "$(CURDIR):/usr/src" sonarsource/sonar-scanner-cli $$org; \
	else \
	  echo "  Neither sonar-scanner nor docker is installed."; \
	  echo "  brew install sonar-scanner"; \
	  exit 1; \
	fi

## run: start the app against LinkedIn
run: node-version
	@$(NODE) server/server.mjs

## demo: start the app on fixture profiles — no Chrome, nothing sent
demo: node-version
	@DEMO=1 $(NODE) server/server.mjs

## clean: remove the coverage report and the throwaway profiles the tests leave
clean:
	@rm -rf coverage
	@rm -rf "$${TMPDIR:-/tmp}"/matched-in-e2e-* "$${TMPDIR:-/tmp}"/matched-in-ui-* "$${TMPDIR:-/tmp}"/matched-in-store-* "$${TMPDIR:-/tmp}"/matched-in-shots-*
	@echo "  cleaned up test leftovers"

# The e2e tests drive Chrome through CDP and the server uses fetch and WebSocket
# from the platform, so an old Node fails in confusing ways rather than clearly.
# One line on purpose: a backslash continuation inside the quotes survives into
# the JavaScript on GNU make 4, and Node then chokes on the stray backslash.
node-version:
	@$(NODE) -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("  Node 22+ required, this is " + process.versions.node); process.exit(1); }'

help:
	@echo ""
	@echo "  matched_in"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/^## /  make /' | sed 's/:/ —/'
	@echo ""
