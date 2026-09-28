# Load Balancer

The `web` and `reverb` services each get their own load balancer. SST Laravel hardens it by default, and the `loadBalancer` block lets you go further.

## Secure by default

You get this without any configuration:

| What | Default |
| --- | --- |
| TLS | The HTTPS listener only accepts TLS 1.2 and 1.3. |
| Open ports | The load balancer accepts traffic from everywhere, but only on the ports it listens on: port 80, plus port 443 when a `domain` is set. |
| HTTP headers | Headers with an invalid name are dropped before they reach your application. |
| HTTP | When a `domain` is set, HTTP is redirected to HTTPS. See [`web.httpsRedirect`](web.md#http-to-https-redirect). |

## Options

The `loadBalancer` block takes three options. They work the same on `web` and `reverb`:

| Option | Default | What it does |
| --- | --- | --- |
| [`sslPolicy`](#tls-policy) | `ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09` | Sets the TLS versions and ciphers the HTTPS listener accepts. |
| [`ingressCidrs`](#ip-allowlist) | `['0.0.0.0/0']` | Only accepts traffic from the IP ranges you list, such as your CDN or WAF. |
| [`accessLogs`](#access-logs-in-s3) | `false` | Ships the load balancer access logs to an S3 bucket. |

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: 'app.example.com',
    loadBalancer: {
      ingressCidrs: ['173.245.48.0/20', '103.21.244.0/22', '2400:cb00::/32'],
      accessLogs: true,
    },
  },
});
```

A key the block doesn't know fails the deploy before anything is created, so a typo can't leave an option off without you noticing. Check the details of each option in the [API reference](api.md#webloadbalancer).

## TLS policy

The HTTPS listener uses `ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09`, the policy AWS recommends. It accepts TLS 1.2 and 1.3 and turns away older clients.

To use another one of the [AWS security policies](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/describe-ssl-policies.html), for example to support a client that needs older ciphers, set `sslPolicy`:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: 'app.example.com',
    loadBalancer: {
      sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-Ext2-2021-06',
    },
  },
});
```

SST Laravel sets the policy on the HTTPS listener only. An HTTP listener rejects an SSL policy, so the one on port 80 is left as it is.

## IP allowlist

When a CDN or WAF such as Cloudflare sits in front of your application, anyone who knows the load balancer address can still go around it. `ingressCidrs` closes that door: the load balancer only accepts traffic from the ranges you list.

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: 'app.example.com',
    loadBalancer: {
      ingressCidrs: [
        '173.245.48.0/20',
        '103.21.244.0/22',
        '2400:cb00::/32',
      ],
    },
  },
});
```

IPv4 and IPv6 ranges can go in the same list. If you prefer to keep them apart, pass an object:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: 'app.example.com',
    loadBalancer: {
      ingressCidrs: {
        v4: ['173.245.48.0/20', '103.21.244.0/22'],
        v6: ['2400:cb00::/32'],
      },
    },
  },
});
```

A few things to keep in mind:

- Requests from any other address time out, including your own when you call the load balancer address directly.
- Providers change their ranges from time to time. Keep the list up to date, for example from [Cloudflare's IP ranges](https://www.cloudflare.com/ips/).
- The health check is not affected. It goes from the load balancer to the containers inside the VPC.

## Access logs in S3

The load balancer can write a log line for every request it receives to S3, including the requests that never reach your containers. This is off by default, because it creates a bucket and adds storage cost to every stage. Set `accessLogs: true` and SST Laravel creates the bucket for you:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    loadBalancer: {
      accessLogs: true,
    },
  },
});
```

The bucket is private and only accepts HTTPS requests. Its policy lets Elastic Load Balancing deliver logs, and only for the load balancers of your account and region. It uses the S3 default encryption (SSE-S3). A load balancer can't deliver logs to a bucket encrypted with a KMS key.

This is not the same as [`web.accessLogs`](web.md#access-logs), which is about the nginx logs the web container sends to CloudWatch.

Pass an object to change the defaults:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    loadBalancer: {
      accessLogs: {
        prefix: 'alb',
        retentionDays: 365,
      },
    },
  },
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `bucket` | A new bucket | An existing bucket to use: an `sst.aws.Bucket` or a bucket name. |
| `prefix` | None | The S3 key prefix the logs go under. It can't contain `AWSLogs`. |
| `enabled` | `true` | Set to `false` to stop shipping logs while keeping the bucket and its logs. |
| `retentionDays` | `90` | Days to keep the logs. Set to `false` to keep them forever. Only for the bucket SST Laravel creates. |

The bucket is removed with the stage, logs included, like the buckets SST creates. With `removal: "retain"` in `sst.config.ts`, which `init` sets for `production`, the bucket stays.

### Using your own bucket

Pass `bucket` to deliver the logs to a bucket you already have, for example one bucket for the logs of `web` and `reverb`:

```js
const accountId = aws.getCallerIdentityOutput().accountId;

const logs = new sst.aws.Bucket('LoadBalancerLogs', {
  policy: [
    {
      actions: ['s3:PutObject'],
      principals: [
        {
          type: 'service',
          identifiers: ['logdelivery.elasticloadbalancing.amazonaws.com'],
        },
      ],
      paths: [
        $interpolate`web/AWSLogs/${accountId}/*`,
        $interpolate`reverb/AWSLogs/${accountId}/*`,
      ],
    },
  ],
});

const app = new LaravelService('MyLaravelApp', {
  web: {
    loadBalancer: {
      accessLogs: { bucket: logs, prefix: 'web' },
    },
  },
  reverb: {
    loadBalancer: {
      accessLogs: { bucket: logs, prefix: 'reverb' },
    },
  },
});
```

With your own bucket, the bucket policy and the retention are yours to set, as in the example above. SST Laravel doesn't add a policy, because a bucket can only have one. See the AWS guide on [access logs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/enable-access-logging.html) for the policy. The bucket has to use SSE-S3 encryption, not a KMS key.

## Invalid headers

The load balancer drops HTTP headers whose name has anything other than letters, digits, and hyphens, such as `X_Custom_Header`. Headers like these are used to smuggle requests past a proxy, and nginx ignores them by default as well.

If a client of yours depends on such a header, turn this off with a transform:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    advanced: {
      transform: {
        loadBalancer: (args) => {
          args.dropInvalidHeaderFields = false;
        },
      },
    },
  },
});
```

## Combining with transforms

The options cover the common cases. For anything else, use `advanced.transform`. When both touch the same resource, the defaults and options are applied first and your transform runs after them, so it has the last word:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    loadBalancer: {
      accessLogs: true,
    },
    advanced: {
      transform: {
        loadBalancer: (args) => {
          args.idleTimeout = 120;
        },
      },
    },
  },
});
```

## Custom load balancers

`loadBalancer` tunes the load balancer SST Laravel sets up for you. To define the load balancer yourself (its listeners, domain, or health checks), use `advanced.loadBalancer`, which takes the [SST load balancer config](https://sst.dev/docs/component/aws/service/#loadbalancer). Both work together:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    loadBalancer: {
      ingressCidrs: ['173.245.48.0/20'],
    },
    advanced: {
      loadBalancer: {
        rules: [{ listen: '8443/https', forward: '8080/http' }],
      },
    },
  },
});
```

The defaults and options follow the listeners of your config: port 8443 is the one open here.

When the whole `advanced.loadBalancer` is a Pulumi `Output`, SST Laravel can't read its ports before the deploy. It then leaves the rule SST creates (every port open) in place, and `ingressCidrs` uses ports 80 and 443. Set the ports yourself in that case:

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    loadBalancer: {
      ingressCidrs: {
        v4: ['173.245.48.0/20'],
        ports: [8443],
      },
    },
  },
});
```

## Workers and shared load balancers

Workers don't have a load balancer, so the options are ignored there, with a warning during the deploy. A worker you give a load balancer with `advanced.loadBalancer` gets the same defaults and options as `web`.

When a service attaches to a shared `sst.aws.Alb` (`advanced.loadBalancer.instance`), the load balancer belongs to that component. SST Laravel can't change it, so the defaults above don't apply, and setting an option fails the deploy with an error. Configure the `sst.aws.Alb` itself in that case.
