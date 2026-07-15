/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'sst-laravel-cloudflare-demo',
      home: 'cloudflare',
      providers: {
        cloudflare: '6.13.0',
      },
      removal: input.stage === 'production' ? 'retain' : 'remove',
      protect: input.stage === 'production',
    };
  },
  async run() {
    const packageName = '@kirschbaum-development/sst-laravel';
    const { LaravelService } = await import(packageName);
    const accountId = process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID;

    if (!accountId) {
      throw new Error('Set CLOUDFLARE_DEFAULT_ACCOUNT_ID before running SST.');
    }

    const database = new sst.cloudflare.D1('Database');
    const bucket = new sst.cloudflare.Bucket('Storage');
    const laravel = new LaravelService('Laravel', {
      provider: 'cloudflare',
      path: '.',
      link: [database, bucket],
      cloudflare: {
        accountId,
        sleepAfter: '10m',
      },
      web: {
        cpu: '0.25 vCPU',
        memory: '1 GB',
        storage: '4 GB',
        scaling: {
          min: 0,
          max: 1,
        },
        healthCheck: {
          path: '/up',
        },
      },
      config: {
        php: 8.4,
        opcache: true,
        environment: {
          file: '.env.cloudflare',
          vars: {
            APP_NAME: 'SST Laravel Cloudflare Demo',
            APP_ENV: 'production',
            APP_DEBUG: 'false',
            LOG_LEVEL: 'info',
            SESSION_DRIVER: 'cookie',
            QUEUE_CONNECTION: 'sync',
          },
        },
      },
    });

    return {
      url: laravel.url,
      databaseId: database.databaseId,
      bucketName: bucket.name,
    };
  },
});
