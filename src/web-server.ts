import { Input, output } from '@pulumi/pulumi';
import type { LaravelLoadBalancerAccessLogsArgs } from '../laravel-sst';

export interface WebServerEnvironmentOptions {
  /**
   * Whether the nginx access logs should keep streaming to CloudWatch.
   *
   * Defaults to false when load balancer access logs are enabled, true otherwise.
   */
  accessLogs?: boolean;
  loadBalancerAccessLogs?: boolean | LaravelLoadBalancerAccessLogsArgs;
}

/**
 * Builds the web-server-specific container environment overrides derived from
 * the web service options.
 *
 * Enabled load balancer access logs silence nginx access logs by default.
 * An explicit `accessLogs` takes precedence. Silencing points the serversideup
 * `NGINX_ACCESS_LOG` variable at `/dev/null`, leaving error logs untouched.
 */
export function buildWebServerEnvironment({
  accessLogs,
  loadBalancerAccessLogs,
}: WebServerEnvironmentOptions): Input<Record<string, string>> {
  if (accessLogs !== undefined || !loadBalancerAccessLogs) {
    return accessLogs === false ? { NGINX_ACCESS_LOG: '/dev/null' } : {};
  }

  const enabled = loadBalancerAccessLogs === true ? true : loadBalancerAccessLogs.enabled ?? true;
  return output(enabled).apply((enabled): Record<string, string> =>
    enabled ? { NGINX_ACCESS_LOG: '/dev/null' } : {},
  );
}
