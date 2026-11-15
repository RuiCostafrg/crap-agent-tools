#!/bin/sh
# Like run.sh, but the tool is reached through Pi's built-in MCP client and
# this repository's MCP server, registered for the session only.
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
repo=$1; args=${2:-'{}'}
cd "$repo"
CRAP_AGENT_PI_TOOL=mcp__crap__changed_risk CRAP_AGENT_PI_ARGS=$args exec "${PI:-pi}" --no-extensions --no-context-files --no-session --offline \
  -e builtin:mcp -e "$here/test/pi/mcp-server.ts" -e "$here/test/pi/scripted-model.ts" \
  --provider scripted --model scripted --tools 'mcp__crap__*' --mode json "Which changed functions are riskiest?" < /dev/null
