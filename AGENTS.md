# Agent Guidelines for SST Laravel

This project is an NPM package, and it is an extension of SST to add some functionality on top of it, to help deploy Laravel applications to AWS Fargate using Docker containers.

## Build/Test Commands
- **Release**: ALWAYS use `npm run release` when publishing a new release. Do not publish directly with `npm publish` or `npm run publish`.
- **Unit tests**: `npm test` (vitest) covers `src/` and `bin/`.
- **Build**: `npm run build` compiles the CLI (`bin/`) to `dist/`. The component (`laravel-sst.ts`, `src/`) ships as TypeScript, which SST compiles.
- **Component tests**: `npm run test:component` type-checks `laravel-sst.ts` (strict) and runs mock deploys of it against an installed SST platform. Point `SST_PLATFORM_DIR` at an app's `.sst/platform`, or it installs one in `tests/component/fixture`. Run it for any change to `laravel-sst.ts` or what it deploys. The deployed resources are compared to the snapshots in `tests/component/__snapshots__`: when a change to them is intended, update them with `npm run test:component -- -u` and review the diff.
- **Container tests**: `npm run test:containers` builds the images with the real Dockerfiles and the files the component generates (a stand-in app in `tests/container/app`), starts them, and checks HTTP, that the background processes run as `www-data`, and what happens when they exit. Run it for any change to the Dockerfiles, `conf/`, or the generated s6 services. Needs Docker, or Podman with `CONTAINER_RUNTIME=podman`; `PHP_VERSION` picks the image (default 8.5). The images build `gd` and `intl`, so the first run takes a few minutes and needs a few GB of memory.
- No linting is configured.

## Code Style & Conventions
- **Formatting**: 2-space indentation, LF line endings, UTF-8 charset (see `.editorconfig`)
- **Language**: TypeScript with SST/Pulumi types
- **Imports**: Use relative paths for local modules (e.g., `./src/laravel-env.js`), absolute for SST platform (e.g., `../../../.sst/platform/...`)
- **Types**: Use Input<T> for component props, Output<T> for Pulumi async values, explicit interfaces for public APIs
- **Naming**: PascalCase for classes/interfaces/types/enums, camelCase for variables/functions, kebab-case for files

## Architecture Patterns
- Component extends SST's `Component` base class
- Use `all()` and `.apply()` for Pulumi Output transformations
- File system operations use Node.js `fs` and `path` modules synchronously
- Configuration defaults: PHP 8.4, opcache enabled, auto-inject env vars
- s6 services: generated per service by `writeS6TaskFiles` in `src/background-tasks.ts`, registered in `/etc/s6-overlay/user-bundles.d/user/contents.d`. Never create `/etc/s6-overlay/s6-rc.d/user`: s6-overlay 3.2.3.2 (ServerSideUp v5) then ignores `user-bundles.d`, so nginx and php-fpm don't start, and writes to `/etc` at boot, which fails as `www-data`. The worker image installs its own s6-overlay (`conf/usr/local/bin/s6-install.sh`); keep its version in step with the ServerSideUp images.
- Build artifacts go to `.sst/laravel/<component name>` (the `buildPath` in `laravel-sst.ts`). The Dockerfiles copy them through build args (`DEPLOY_PATH`, `CONF_PATH`, `CUSTOM_CONF_PATH`), which `src/image.ts` sets; `tests/dockerfiles.test.ts` checks every build arg is declared.

## Error Handling & Security
- Validate paths with `path.resolve()` before file operations
- Use `fs.existsSync()` checks before reading files
- Never log or expose secrets/passwords
- Set proper file permissions (0o755 for scripts, 0o777 for s6 executables)

## Documentation

- The docs live in this repository. The website (https://docs.kirschbaumdevelopment.com, repo `kirschbaum-development/docs`) imports `docs/overview.md`, the other `.md` files in `docs/`, and `CHANGELOG.md` from here. Don't edit the imported copies in that repo.
- `README.md` is a short package introduction linking to the documentation website. Keep detailed instructions in `docs/overview.md` and the guides, not in the root README. The website splits `docs/overview.md` into pages and also features its "Onboard your agent" section on the landing page.
- Guides go in `docs/<topic>.md`, one topic per file, starting with a `# Title` heading. When adding or removing a page, update the tables in `docs/README.md` and `docs/overview.md`.
- Use relative links between files (`docs/web.md`, `api.md#web`), not `github.com/.../blob/main/...` URLs. The importer rewrites relative links into website links.
- `docs/` ships in the npm package and agents read it from `node_modules`. `docs/llms.txt` (printed by `sst-laravel guide --reference`) and `docs/agent-setup.md` (fetched by the onboarding prompt in `docs/overview.md` from the latest npm release, through jsDelivr, so changes reach agents when they are released) are for agents; keep them in sync with option and command changes.

## Documenting API

- When asked to document the API, you should document the `LaravelService` class in the `laravel-sst.ts` file.
- When the option has comments, make sure what's there is captured in the documentation.
- When documenting the API, ALWAYS skip the following ones:
  * web.image
  * workers[].link
  * Any option that's not yet implemented
- The generated file should be called `api.md` and should be placed in the `docs` directory.
