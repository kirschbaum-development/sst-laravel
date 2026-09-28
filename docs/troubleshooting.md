# Troubleshooting

## The app isn't healthy after a deploy

1. Run `npx sst-laravel status --stage <stage> --url <url>` to see the running tasks and the `/up` health check in one view.
1. Run `npx sst-laravel logs web --stage <stage>` to see recent errors.

The usual causes are a missing `APP_KEY`, wrong environment variable names, a database the containers can't reach, a wrong health check path, or AWS keys in the environment file (see [below](#cd-aws-credentials-are-not-configured)).

## Assets load over HTTP instead of HTTPS

SST Laravel puts the container behind a load balancer, so you must configure your Laravel application to trust the load balancer's IP addresses. You can do this by configuring the trusted proxies in `bootstrap/app.php`. If you deployed your app and it's trying to load assets using HTTP instead of HTTPS, this is likely the issue.

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->trustProxies(at: '*');
})
```

## Failed to build sst.config.ts

In case you get the following error when running SST commands, run `npx sst-laravel install`. If this fails, temporarily rename the `sst.config.ts` file, and run `npx sst install`.

```bash
✕  Failed to build sst.config.ts
   - node_modules/@kirschbaum-development/sst-laravel/laravel-sst.ts:6:26 Could not resolve "../../../.sst/platform/src/components/component.js"
```

## CD: AWS credentials are not configured

If you are getting the following error when deploying (usually via CI/CD), the issue is usually that you have a `.env` or `.env.{stage}` that contains the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` keys. They should be removed from the environment file and you should be relying on the IAM role to give your app permissions to access AWS resources (which is more secure anyway).

```
✕  AWS credentials are not configured. Try configuring your profile in `~/.aws/config` and setting the `AWS_PROFILE` environment variable or specifying `providers.aws.profile` in your sst.config.ts
   aws: failed to refresh cached credentials, no EC2 IMDS role found, operation error ec2imds: GetMetadata, failed to get API token, operation error ec2imds: getToken, http response error StatusCode: 400, request to EC2 IMDS failed
```
