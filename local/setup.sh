#!/bin/sh
# Localhost setup: install npm deps WITHOUT the host-local @hatch/space-sdk
# tarball (it only exists on the artifact host), then link the local stub in
# its place. The repo's package.json / bun.lock are restored byte-identical.
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"

if [ -L node_modules/@hatch/space-sdk ] && [ -d node_modules/react ]; then
  echo "local setup already done (deps installed, stub linked)"
  exit 0
fi

cp package.json /tmp/earlyproof-pkg.json
cp bun.lock /tmp/earlyproof-lock.json
trap 'cp /tmp/earlyproof-pkg.json package.json; cp /tmp/earlyproof-lock.json bun.lock' EXIT
python3 -c 'import json; p=json.load(open("package.json")); del p["dependencies"]["@hatch/space-sdk"]; json.dump(p, open("package.json","w"), indent=2); open("package.json","a").write("\n")'
bun install
trap - EXIT
cp /tmp/earlyproof-pkg.json package.json
cp /tmp/earlyproof-lock.json bun.lock

mkdir -p node_modules/@hatch
ln -sfn ../../local/stubs/space-sdk node_modules/@hatch/space-sdk
echo "local setup done: deps installed, @hatch/space-sdk linked to local stub"
