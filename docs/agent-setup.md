# SST Laravel agent setup

Instructions for AI agents. Set up SST Laravel in the user's Laravel app, deploy it to AWS, and keep going until the `/up` health endpoint is healthy.

Run every command yourself. Only ask the user for what you can't do: approvals, an AWS login in the browser, or business decisions.

These rules hold from the first step to the last:

- Show the user a plan and get their yes before you write any configuration or deploy.
- Never print secret values, and never put AWS keys in `.env` files.
- Don't deploy to `production` unless the user says so.

## 1. Find the Laravel app

Work from the Laravel root: the folder with `artisan` and a `composer.json` that requires `laravel/framework`. If you can't find one, stop and ask the user where the app is.

## 2. Install the package

If `package.json` doesn't list `@kirschbaum-development/sst-laravel`, install it:

```bash
npm install @kirschbaum-development/sst-laravel --save
```

Install it before any `npx sst-laravel` command. Until it's installed, `npx` looks for a different, unscoped package with that name.

Keep `deployment: app.deployment` in the `run()` outputs so deploy/status can verify the expected task definitions and their ECR images. For an upgrade from 0.7.1, follow [the upgrade sequence](deploying.md#upgrading-from-071): persist image retention before a separate provider/resource replacement.

If the package is already installed, keep its version. Upgrading can change deployed infrastructure, so only upgrade when the user asks.

## 3. Install the skill for later sessions

```bash
npx sst-laravel skill:install
```

It copies the `sst-laravel` skill from the installed package and puts it where this project manages skills:

- **Laravel Boost 2.0+ set up for at least one agent** (`boost.json` lists `agents`): into `.ai/skills/sst-laravel/`, then it runs `php artisan boost:update`, so Boost installs it for those agents.
- **Otherwise:** into `.agents/skills/sst-laravel/` and into the `skills` folder of every agent set up in the project (`.claude`, `.cursor`, `.gemini`, `.windsurf`, `.codex`).

Later sessions use the skill to deploy again, check the app, or fix a failed deploy. Commit the skill files so teammates get the same skill (with Boost, `.ai/skills/sst-laravel/`; Boost regenerates the agent folders). If Boost is installed but not set up, don't run `boost:install` yourself; it asks the user which agents to configure.

## 4. Follow the guide

```bash
npx sst-laravel guide
```

It prints the skill's instructions for the installed version, so you don't need to load the skill or restart. Follow them from the top: the readiness check, the plan for the user, the configuration, the first deploy, the health check, and the report at the end.
