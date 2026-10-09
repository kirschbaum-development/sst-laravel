import { DescribeTaskDefinitionCommand, ECSClient } from '@aws-sdk/client-ecs';
import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';

/** Private ECR references, including China and GovCloud. Other registries are not queried. */
export function parseEcrImage(image: string) {
  const match = image.match(/^(\d{12})\.dkr\.ecr(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/(.+)$/);
  if (!match) return undefined;
  const [, registryId, region, reference] = match;
  const [tagged, digest] = reference.split('@');
  const colon = tagged.lastIndexOf(':');
  const repositoryName = colon < 0 ? tagged : tagged.slice(0, colon);
  const imageId = digest ? { imageDigest: digest } : { imageTag: colon < 0 ? 'latest' : tagged.slice(colon + 1) };
  return { registryId, region, repositoryName, imageId };
}

export type EcrClients = (region: string) => ECRClient;

/** Read every container in the exact task definitions, never environment variables or IAM roles. */
export async function checkTaskImages(ecs: ECSClient, taskDefinitions: string[], ecr: EcrClients): Promise<string[]> {
  const missing: string[] = [];
  const checked = new Set<string>();

  for (const arn of new Set(taskDefinitions)) {
    const response = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: arn }));
    const definition = response.taskDefinition;
    if (!definition || definition.status !== 'ACTIVE' || !definition.containerDefinitions?.length) {
      missing.push(`${arn}: task definition is missing, inactive, or has no containers`);
      continue;
    }
    for (const container of definition.containerDefinitions) {
      if (!container.image) {
        missing.push(`${arn}: ${container.name ?? 'container'} has no image`);
        continue;
      }
      const image = container.image;
      if (checked.has(image)) continue;
      checked.add(image);
      const parsed = parseEcrImage(image);
      if (!parsed) continue;
      const { region, imageId, ...repository } = parsed;
      try {
        const result = await ecr(region).send(new DescribeImagesCommand({ ...repository, imageIds: [imageId] }));
        if (!result.imageDetails?.some((detail) => imageId.imageDigest
          ? detail.imageDigest === imageId.imageDigest
          : detail.imageTags?.includes(imageId.imageTag!))) {
          missing.push(`${arn}: ECR image unavailable: ${image}`);
        }
      } catch (error) {
        if (['ImageNotFoundException', 'RepositoryNotFoundException'].includes((error as Error).name)) {
          missing.push(`${arn}: ECR image unavailable: ${image}`);
        } else {
          throw new Error(`Cannot verify ECR image ${image}: ${(error as Error).message}. The check needs ecr:DescribeImages on its repository.`);
        }
      }
    }
  }
  return missing;
}
