/// <reference path="./.sst/platform/config.d.ts" />

// Only used to install the SST platform the component tests run against:
// `npx sst install` in this folder. Keep the aws version in step with SST.
export default $config({
  app() {
    return { name: "fixture", home: "local", providers: { aws: "7.20.0" } };
  },
  async run() {},
});
