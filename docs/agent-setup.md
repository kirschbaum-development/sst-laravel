# SST Laravel agent setup

Instructions for AI agents. Set up SST Laravel in the user's Laravel app, deploy it to AWS, and keep going until the `/up` health endpoint is healthy.

Run every command yourself. Only ask the user for what you can't do: approvals, an AWS login in the browser, or business decisions.

## 1. Find the Laravel app

Work from the Laravel root: the folder with `artisan` and a `composer.json` that requires `laravel/framework`. If you can't find one, stop and ask the user where the app is.

## 2. Install the package

If `package.json` doesn't list `@kirschbaum-development/sst-laravel`, install it:

```bash
npm install @kirschbaum-development/sst-laravel --save
```

Install it before any `npx sst-laravel` command. Until it's installed, `npx` looks for a different, unscoped package with that name.

If the package is already installed, keep its version. Upgrading can change deployed infrastructure, so only upgrade when the user asks.

## 3. Install or update the skill

```bash
npx sst-laravel skill:install
```

It puts the `sst-laravel` skill where this project manages skills:

- **Laravel Boost 2.0+ set up for at least one agent** (`boost.json` lists `agents`): it copies the skill from the installed package into `.ai/skills/sst-laravel/` and runs `php artisan boost:update`, so Boost installs it for those agents.
- **Otherwise:** it installs the latest skill from GitHub with the [skills CLI](https://github.com/vercel-labs/skills), for every agent it detects (`.agents/skills/`, agent folders such as `.claude/skills/`, and `skills-lock.json`).

Run the same command to update the skill later. Commit the skill files so teammates get the same skill (with Boost, `.ai/skills/sst-laravel/`; Boost regenerates the agent folders). If Boost is installed but not set up, don't run `boost:install` yourself; it asks the user which agents to configure.

Then load the `sst-laravel` skill. If your agent doesn't see it without a restart, read the installed `SKILL.md` directly (the command prints its folder) and follow it now.

If the command fails, for example without network access to GitHub, run `npx sst-laravel guide` instead. It prints the same instructions from the installed package.

Without Boost, the skill comes from the latest code on GitHub. If the installed package is older, trust `npx sst-laravel --help` and the package docs in `node_modules/@kirschbaum-development/sst-laravel/docs/` over the skill for option and command names.

## 4. Follow the skill

The skill covers the full flow: `doctor`, the plan, `init`, the first deploy, and checking it with `status`. On top of the skill:

- Show the plan before you write any config: what you found in the app, the questions only the user can answer (a database, background work), what will be created with the monthly cost, how the deploy works, and how to remove it. Wait for their yes.
- Suggest a small first deploy: stage `dev`, no domain, health check at `/up`, env file `.env.dev`. When the app uses a database, ask whether to add one. Don't leave it out silently.
- Never print secret values. Don't put AWS keys in `.env` files. Don't deploy to `production` unless the user says so.

## 5. Report back

You're done when `npx sst-laravel status --stage dev --url <app-url>` passes, or when a blocker needs the user. Tell the user:

- the app URL, stage, and region;
- the health check result;
- the files you created or changed, including the skill files;
- if you got stuck: the exact error and what you checked (running tasks, health endpoint, recent logs).
