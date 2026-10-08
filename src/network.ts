import { all, Input, Output } from '@pulumi/pulumi';
import type { LaravelArgs } from '../laravel-sst';
import { composeTransform } from './service-args';

export interface ClusterNetwork {
  vpc: LaravelArgs['vpc'];
  /** Whether the containers need a public IP. Unset when SST decides. */
  assignPublicIp?: Output<boolean>;
}

/**
 * Picks the subnets the containers run in when `vpc` is an `sst.aws.Vpc`.
 *
 * With NAT, containers stay in the private subnets and reach the internet
 * through it. Without NAT, private subnets have no route out, so containers
 * could not even pull their image from ECR. They run in the public subnets
 * with a public IP instead, which is what SST does by default. The VPC
 * security group still only accepts inbound traffic from inside the VPC
 * (the load balancer).
 */
export function resolveClusterNetwork(vpc: LaravelArgs['vpc']): ClusterNetwork {
  if (!vpc || typeof vpc !== 'object' || !('publicSubnets' in vpc) || !('nodes' in vpc)) {
    return { vpc };
  }

  const cloudmapNamespace = vpc.nodes?.cloudmapNamespace;

  if (!cloudmapNamespace) {
    return { vpc };
  }

  const hasNat = all([vpc.nodes.natGateways, vpc.nodes.natInstances]).apply(
    ([natGateways, natInstances]) => natGateways.length > 0 || natInstances.length > 0,
  );

  return {
    vpc: {
      id: vpc.id,
      securityGroups: vpc.securityGroups,
      containerSubnets: hasNat.apply((nat) => (nat ? vpc.privateSubnets : vpc.publicSubnets)),
      loadBalancerSubnets: vpc.publicSubnets,
      cloudmapNamespaceId: cloudmapNamespace.id,
      cloudmapNamespaceName: cloudmapNamespace.name,
    },
    assignPublicIp: hasNat.apply((nat) => !nat),
  };
}

/**
 * SST only gives containers a public IP when the cluster gets the
 * `sst.aws.Vpc` itself. The component passes a plain object to choose the
 * subnets, so this sets the public IP on the ECS service to match. The
 * user's `advanced.transform.service` still runs after it.
 */
export function withContainerNetwork(network: ClusterNetwork, userTransform: unknown): unknown {
  const assignPublicIp = network.assignPublicIp;

  if (!assignPublicIp) {
    return userTransform;
  }

  return composeTransform<{ networkConfiguration?: Input<object> }>((serviceArgs) => {
    serviceArgs.networkConfiguration = all([serviceArgs.networkConfiguration, assignPublicIp]).apply(
      ([networkConfiguration, publicIp]) => ({
        ...networkConfiguration,
        assignPublicIp: publicIp,
      }),
    );
  }, userTransform);
}
