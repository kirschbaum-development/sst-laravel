import * as fs from 'fs';
import * as path from 'path';

/**
 * Written to a project that has no `.dockerignore` yet. The Dockerfiles copy
 * the whole project into the image, so without this the image would carry
 * local-only files: the git history, every `.env*` file (the image gets its
 * own `.env` from `.sst/laravel`), a local SQLite database, uploads,
 * logs, and `node_modules`.
 */
export const DOCKER_IGNORE_DEFAULTS = `# Added by sst-laravel: keeps local-only files out of the container image.
# Edit as needed. Remove \`node_modules\` if the app needs it at runtime (for example Inertia SSR).
.git
node_modules
.env
.env.*
database/*.sqlite
database/*.sqlite-*
storage/app/private/*
storage/app/public/*
storage/logs/*
storage/framework/cache/data/*
storage/framework/sessions/*
storage/framework/views/*
tests
.phpunit.result.cache
.idea
.vscode
`;

const SST_LINES = ['', '# sst', '.sst', '', '# sst-laravel', '!.sst/laravel'];

const isSstLine = (line: string) =>
  line === '.sst' || line === '!.sst/laravel' || line === '# sst' || line === '# sst-laravel';

/**
 * Docker reads `<Dockerfile>.dockerignore` next to the context when it
 * exists, and `.dockerignore` otherwise.
 */
export function resolveDockerIgnorePath(context: string, dockerfile: string): string {
  const specific = path.join(context, `${dockerfile}.dockerignore`);
  return fs.existsSync(specific) ? specific : path.join(context, '.dockerignore');
}

/**
 * The content the ignore file should have. An existing file only gets the
 * `.sst` lines (re)appended, so user rules are kept as they are. A missing
 * file gets the safe defaults as well. Returns `null` when nothing changes.
 */
export function buildDockerIgnoreContent(existing: string | null): string | null {
  const lines = (existing ?? DOCKER_IGNORE_DEFAULTS).split('\n').filter((line) => !isSstLine(line));

  // Drop trailing blank lines so re-running does not grow the file.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }

  const content = [...lines, ...SST_LINES].join('\n') + '\n';

  return content === existing ? null : content;
}

/**
 * Makes sure the Docker build context ignores `.sst` (but keeps
 * `.sst/laravel`, where the build files live) and, for a new file, the
 * local-only files above. Returns a message for the deploy output when the
 * file was written.
 */
export function ensureDockerIgnore(context: string, dockerfile: string): string | null {
  const ignorePath = resolveDockerIgnorePath(context, dockerfile);
  const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath).toString() : null;
  const content = buildDockerIgnoreContent(existing);

  if (content === null) {
    return null;
  }

  fs.writeFileSync(ignorePath, content);

  return existing === null
    ? `Created ${ignorePath} so the image skips .git, node_modules, .env files, local databases, uploads, and logs. Review it and commit it.`
    : `Updated ${ignorePath} to exclude .sst but keep .sst/laravel for the Docker build.`;
}
