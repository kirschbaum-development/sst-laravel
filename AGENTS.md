# Agent Guidelines for SST Laravel

This project is an NPM package, and it is an extension of SST to add some functionality on top of it, to help deploy Laravel applications to AWS Fargate using Docker containers.

## Build/Test Commands
- **Publish**: `npm run publish` (publishes package to npm with public access)
- No test suite or linting configured in this project
- No build step required (TypeScript consumed directly by SST)

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
- Build artifacts go to `.sst/laravel` directory (managed via `pluginBuildPath`)

## Error Handling & Security
- Validate paths with `path.resolve()` before file operations
- Use `fs.existsSync()` checks before reading files
- Never log or expose secrets/passwords
- Set proper file permissions (0o755 for scripts, 0o777 for s6 executables)
