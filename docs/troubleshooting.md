# Troubleshooting

## The app isn't healthy after a deploy

1. Run `npx sst-laravel status --stage <stage> --wait` to see the running tasks and the `/up` health check in one view. It checks the URL the last `sst-laravel deploy` of the stage saved; pass `--url <url>` to check another address. The deploy returns before the new tasks pass the health check, so a 502 or 503 in the first minutes only means they are still starting.
1. Run `npx sst-laravel logs web --stage <stage> --no-follow` to see recent errors.

The usual causes are a missing `APP_KEY`, wrong environment variable names, a database the containers can't reach, a wrong health check path, or AWS keys in the environment file (see [below](#cd-aws-credentials-are-not-configured)).

## https:// times out on the load balancer address

Without a domain, the load balancer only listens on port 80, so `https://<load-balancer>` times out. Use `http://`, or add a domain (`web.domain`) to get HTTPS.

## "failed to configure registry cache importer" during the build

```
ERROR: failed to configure registry cache importer: ...: not found
```

This shows on the first deploy of a stage. SST points Docker at a build cache in your registry, and the cache doesn't exist until a build has run. The build continues without it, and the message goes away on the next deploy.

## The deploy says "not logged in" or uses the wrong account

The commands use the AWS CLI's credentials. With several named profiles, export `AWS_PROFILE=<name>` so `sst-laravel doctor`, `deploy`, `status`, and `sst` itself all use the same one, and log in with `aws sso login --profile <name>`. `npx sst-laravel doctor` shows the account and profile in use. To set up a login for the first time, see [AWS access](getting-started.md#aws-access).

## Assets load over HTTP instead of HTTPS

SST Laravel puts the container behind a load balancer, so you must configure your Laravel application to trust the load balancer's IP addresses. You can do this by configuring the trusted proxies in `bootstrap/app.php`. If you deployed your app and it's trying to load assets using HTTP instead of HTTPS, this is likely the issue.

```php
->withMiddleware(function (Middleware $middleware) {
    $middleware->trustProxies(at: '*');
})
```

## loadBalancer does not take "rules"

```
[sst-laravel] web.loadBalancer does not take "rules". It takes sslPolicy, ingressCidrs, accessLogs. The SST load balancer config goes in web.advanced.loadBalancer.
```

Since version 0.6, `loadBalancer` holds the [load balancer options](load-balancer.md). The SST load balancer config (`rules`, `ports`, `domain`, `health`) moved to `advanced.loadBalancer`:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    advanced: {
      loadBalancer: {
        rules: [{ listen: '80/http', forward: '8080/http' }],
      },
    },
  },
});
```

You get the same error for a misspelled option, such as `ingressCidr`.

## Requests to the app time out

If this started after you set `loadBalancer.ingressCidrs`, the load balancer only accepts traffic from the ranges in that list. Check that the list has the current ranges of your CDN or WAF, and that your domain points to the CDN or WAF and not to the load balancer. Calling the load balancer address directly times out from any other address. See [IP allowlist](load-balancer.md#ip-allowlist).

## An old client can't connect over HTTPS

The load balancer only accepts TLS 1.2 and 1.3. To support a client that needs an older version, set another policy with `loadBalancer.sslPolicy`. See [TLS policy](load-balancer.md#tls-policy).

## Failed to build sst.config.ts

In case you get the following error when running SST commands, run `npx sst-laravel install`. If this fails, temporarily rename the `sst.config.ts` file, and run `npx sst install`.

```bash
✕  Failed to build sst.config.ts
   - node_modules/@kirschbaum-development/sst-laravel/src/sst-platform.ts:11:26 Could not resolve "../../../../.sst/platform/src/components/component.js"
```

The package loads SST's components from the app's `.sst/platform`, which `sst install` creates. It expects to be installed in the app's own `node_modules`.

## CD: AWS credentials are not configured

If you are getting the following error when deploying (usually via CI/CD), the issue is usually that you have a `.env` or `.env.{stage}` that contains the `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` keys. They should be removed from the environment file and you should be relying on the IAM role to give your app permissions to access AWS resources (which is more secure anyway).

```
✕  AWS credentials are not configured. Try configuring your profile in `~/.aws/config` and setting the `AWS_PROFILE` environment variable or specifying `providers.aws.profile` in your sst.config.ts
   aws: failed to refresh cached credentials, no EC2 IMDS role found, operation error ec2imds: GetMetadata, failed to get API token, operation error ec2imds: getToken, http response error StatusCode: 400, request to EC2 IMDS failed
```
