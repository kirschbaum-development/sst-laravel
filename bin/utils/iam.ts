import {
  IAMClient,
  CreateOpenIDConnectProviderCommand,
  ListOpenIDConnectProvidersCommand,
  GetOpenIDConnectProviderCommand,
  AddClientIDToOpenIDConnectProviderCommand,
} from '@aws-sdk/client-iam';

export async function getAwsAccountId(iamClient: IAMClient): Promise<string> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const stsClient = new STSClient({ region: await iamClient.config.region() });
  const response = await stsClient.send(new GetCallerIdentityCommand({}));
  return response.Account!;
}

export async function ensureGithubOidcProvider(iamClient: IAMClient, githubOidcUrl: string): Promise<string> {
  const requiredAudience = 'sts.amazonaws.com';
  const listResponse = await iamClient.send(new ListOpenIDConnectProvidersCommand({}));

  const existingProvider = listResponse.OpenIDConnectProviderList?.find(
    provider => provider.Arn?.includes('token.actions.githubusercontent.com')
  );

  if (existingProvider) {
    const providerDetails = await iamClient.send(new GetOpenIDConnectProviderCommand({
      OpenIDConnectProviderArn: existingProvider.Arn
    }));

    const hasRequiredAudience = providerDetails.ClientIDList?.includes(requiredAudience);

    if (!hasRequiredAudience) {
      console.log(`OIDC provider exists but missing "${requiredAudience}" audience. Adding it...`);
      await iamClient.send(new AddClientIDToOpenIDConnectProviderCommand({
        OpenIDConnectProviderArn: existingProvider.Arn,
        ClientID: requiredAudience
      }));
      console.log(`Added "${requiredAudience}" audience to OIDC provider`);
    }

    return existingProvider.Arn!;
  }

  const thumbprint = '6938fd4d98bab03faadb97b34396831e3780aea1';

  const createResponse = await iamClient.send(new CreateOpenIDConnectProviderCommand({
    Url: githubOidcUrl,
    ClientIDList: [requiredAudience],
    ThumbprintList: [thumbprint]
  }));

  return createResponse.OpenIDConnectProviderArn!;
}

export function buildTrustPolicy(oidcProviderArn: string, owner: string, repo: string, branch: string): object {
  const condition = branch === '*'
    ? `repo:${owner}/${repo}:*`
    : `repo:${owner}/${repo}:ref:refs/heads/${branch}`;

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          Federated: oidcProviderArn
        },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com'
          },
          StringLike: {
            'token.actions.githubusercontent.com:sub': condition
          }
        }
      }
    ]
  };
}
