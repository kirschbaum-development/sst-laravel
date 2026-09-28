# Reverb

You can deploy a dedicated Laravel Reverb service for WebSocket traffic. Reverb runs as a worker-style container using `php artisan reverb:start`, but SST Laravel also attaches a load balancer so you can give it its own public domain.

```js
const app = new LaravelService('MyLaravelApp', {
  web: {
    domain: 'app.example.com',
  },

  reverb: {
    domain: {
      dns: sst.cloudflare.dns(),
      name: 'ws.example.com',
    },
  },
});

return {
  url: app.url,
  reverbUrl: app.reverbUrl,
};
```

To run Reverb with the default settings, set `reverb: true`. Check all the `reverb` options in the [API reference](api.md#reverb).

## Environment variables

When `reverb.domain` is configured, SST Laravel automatically injects the Reverb server variables:

```env
REVERB_SERVER_HOST=0.0.0.0
REVERB_SERVER_PORT=8080
REVERB_HOST=ws.example.com
REVERB_PORT=443
REVERB_SCHEME=https
```

## Scaling

If you enable horizontal scaling for Reverb, make sure your Laravel application is configured for Reverb scaling with Redis.
