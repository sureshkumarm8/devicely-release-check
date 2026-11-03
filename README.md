# devicely-release-check

Release verification for the [devicely](https://www.npmjs.com/package/devicely) npm package.

GitHub Actions installs the release tarball in `tarball/` on Linux with each supported Node.js version and runs `scripts/tarball-smoke.js` (install, CLI, backend health, agent API, MCP, UI WebSocket, clean shutdown). The reports are combined with the macOS results before the same tarball is published to npm.
