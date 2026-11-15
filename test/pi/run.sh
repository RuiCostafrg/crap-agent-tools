#!/bin/sh
# Run the extension in a real, throwaway Pi session driven by the scripted model.
# Usage: test/pi/run.sh <repo-dir> '<tool arguments JSON>'
# No discovered extensions, context files or session file; nothing is installed.
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
repo=$1; args=${2:-'{}'}
cd "$repo"
CRAP_AGENT_PI_ARGS=$args exec "${PI:-pi}" --no-extensions --no-context-files --no-session --offline \
  -e "$here/pi-extension/index.ts" -e "$here/test/pi/scripted-model.ts" \
  --provider scripted --model scripted --tools changed_risk --mode json "Which changed functions are riskiest?" < /dev/null
