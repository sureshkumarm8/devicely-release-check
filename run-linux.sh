#!/bin/bash
# Runs the tarball smoke test on Linux with every supported Node.js version
# and bundles the reports into linux-reports.tgz. Usable anywhere with
# bash, npm and internet access (e.g. Google Cloud Shell).
set -uo pipefail
cd "$(dirname "$0")"
[ "$(uname -s)" = Linux ] || { echo "Run this on Linux"; exit 1; }
tarball="$(find tarball -maxdepth 1 -name '*.tgz' -type f)"
sha256sum "$tarball"
rm -rf reports; mkdir reports
failed=0
for node in 20.9.0 22 24 26; do
  echo "=== Node $node"
  if npx -y "node@$node" scripts/tarball-smoke.js --tarball "$tarball" --report "reports/smoke-linux-$node.json"; then :; else failed=1; fi
done
tar czf linux-reports.tgz reports
echo
[ "$failed" = 0 ] && echo "All Linux checks passed. Download linux-reports.tgz." || echo "Some Linux checks FAILED (see above)."
exit "$failed"
