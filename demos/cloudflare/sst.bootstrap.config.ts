export default $config({
  app(input) {
    return {
      name: 'sst-laravel-cloudflare-demo',
      home: 'local',
      providers: {
        cloudflare: '6.13.0',
      },
      removal: input.stage === 'production' ? 'retain' : 'remove',
      protect: input.stage === 'production',
    };
  },
  async run() {
    return {};
  },
});
