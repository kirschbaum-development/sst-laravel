#!/bin/bash

# Type-checks laravel-sst.ts and runs the mock deploys in tests/component
# against an installed SST platform.
#
# The component imports the platform from `../../../.sst/platform`, the way it
# sits in an app's node_modules, so the package is copied into a scratch
# folder laid out the same way.
#
# Uses the platform in SST_PLATFORM_DIR when set (any app that ran
# `sst install` has one in `.sst/platform`). Otherwise it installs one in
# tests/component/fixture.
#
# Extra arguments go to vitest, e.g. `npm run test:component -- -u` to update
# the resource snapshots.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="$ROOT/tests/component/fixture"
PLATFORM="${SST_PLATFORM_DIR:-$FIXTURE/.sst/platform}"

if [ ! -d "$PLATFORM/node_modules/@pulumi/pulumi" ] || [ ! -f "$PLATFORM/config.d.ts" ]; then
  echo "Installing the SST platform in $FIXTURE..."
  (cd "$FIXTURE" && "$ROOT/node_modules/.bin/sst" install)
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/sst-laravel-component.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

PACKAGE="$SCRATCH/pkg/@kirschbaum-development/sst-laravel"
mkdir -p "$PACKAGE" "$SCRATCH/.sst" "$SCRATCH/node_modules"
cp -r "$ROOT/laravel-sst.ts" "$ROOT/sst-env.d.ts" "$ROOT/src" "$ROOT/conf" \
  "$ROOT/Dockerfile.web" "$ROOT/Dockerfile.worker" "$PACKAGE/"
cp "$ROOT/tests/component/tsconfig.json" "$PACKAGE/"
cp "$ROOT/tests/component/"*.ts "$ROOT/tests/component/vitest.config.mjs" "$SCRATCH/"

# Never link the whole .sst folder: the component writes its build files
# next to the platform.
ln -s "$PLATFORM" "$SCRATCH/.sst/platform"
ln -s "$PLATFORM/node_modules/@pulumi" "$SCRATCH/node_modules/@pulumi"
ln -s "$ROOT/node_modules/@aws-sdk" "$SCRATCH/node_modules/@aws-sdk"
ln -s "$ROOT/node_modules/@types" "$SCRATCH/node_modules/@types"
ln -s "$ROOT/node_modules/vitest" "$SCRATCH/node_modules/vitest"
# The provider RPC regression uses the same protobuf/gRPC dependencies as Pulumi.
ln -s "$PLATFORM/node_modules/@grpc" "$SCRATCH/node_modules/@grpc"
ln -s "$PLATFORM/node_modules/google-protobuf" "$SCRATCH/node_modules/google-protobuf"

echo "Type-checking laravel-sst.ts..."
(cd "$PACKAGE" && "$ROOT/node_modules/.bin/tsc" -p tsconfig.json)

echo "Running the mock deploys..."
cd "$SCRATCH"
SST_LARAVEL_SNAPSHOTS="$ROOT/tests/component/__snapshots__" \
  "$ROOT/node_modules/.bin/vitest" run --root "$SCRATCH" "$@"
