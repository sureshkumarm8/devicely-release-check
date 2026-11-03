# devicely-release-check

Release verification for the [devicely](https://www.npmjs.com/package/devicely) npm package.

`run-linux.sh` installs the release tarball in `tarball/` on Linux with each supported Node.js version and runs `scripts/tarball-smoke.js` (install, CLI, backend health, agent API, MCP, UI WebSocket, clean shutdown). Run it on any Linux machine, for example Google Cloud Shell:

```
git clone https://github.com/sureshkumarm8/devicely-release-check && cd devicely-release-check && ./run-linux.sh
```
