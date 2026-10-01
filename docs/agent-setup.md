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

It copies the `sst-laravel` skill from the installed package, so it matches the commands and options of that version, and puts it where this project manages skills:

- **Laravel Boost 2.0+ set up for at least one agent** (`boost.json` lists `agents`): into `.ai/skills/sst-laravel/`, then it runs `php artisan boost:update`, so Boost installs it for those agents.
- **Otherwise:** into `.agents/skills/sst-laravel/` and into the `skills` folder of every agent set up in the project (`.claude`, `.cursor`, `.gemini`, `.windsurf`, `.codex`).

Run the same command to update the skill after upgrading the package. Commit the skill files so teammates get the same skill (with Boost, `.ai/skills/sst-laravel/`; Boost regenerates the agent folders). If Boost is installed but not set up, don't run `boost:install` yourself; it asks the user which agents to configure.

Then load the `sst-laravel` skill. If your agent doesn't see it without a restart, read the installed `SKILL.md` directly (the command prints its folders) and follow it now. `npx sst-laravel guide` prints the same instructions.

## 4. Follow the skill

The skill covers the full flow: `doctor`, the plan, `init`, the first deploy, and checking it with `status`. On top of the skill:

- Show the plan before you write any config. Start with a few short bullets on why SST Laravel, from [Why SST Laravel](why-sst-laravel.md): infrastructure as code in their own AWS account, auto-scaling, linking AWS resources, and no long-lived AWS keys. Then cover what you found in the app, the questions only the user can answer (a database, background work), what will be created with the monthly cost, how the deploy works, and how to remove it. Wait for their yes.
- Suggest a small first deploy: stage `dev`, no domain, health check at `/up`, env file `.env.dev`. When the app uses a database, ask whether to add one. Don't leave it out silently.
- With several AWS profiles on the machine, ask the user which one to use and export `AWS_PROFILE=<name>` for every command.
- Never print secret values. Don't put AWS keys in `.env` files. Don't deploy to `production` unless the user says so.

## 5. Report back

You're done when `npx sst-laravel status --stage dev --url <app-url> --wait` passes, or when a blocker needs the user. Tell the user:

- the app URL, stage, and region;
- the health check result;
- the files you created or changed, including the skill files and the `.dockerignore` the first deploy writes;
- how to deploy again and how to remove the stage (`npx sst remove --stage dev`);
- if you got stuck: the exact error and what you checked (running tasks, health endpoint, recent logs).
