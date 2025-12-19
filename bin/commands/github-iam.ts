import { Command } from 'commander';
import {
  IAMClient,
  CreateRoleCommand,
  AttachRolePolicyCommand,
  GetRoleCommand
} from '@aws-sdk/client-iam';
import { findSstConfig, extractSstProjectName } from '../utils/sst-config.js';
import { detectGitHubRepo } from '../utils/git.js';
import { ensureGithubOidcProvider, buildTrustPolicy } from '../utils/iam.js';

interface GithubIamOptions {
  repo?: string;
  branch: string;
  region: string;
  roleName?: string;
}

export const githubIamCommand = new Command('github-iam')
  .description('Create an IAM Role on AWS for GitHub Actions OIDC authentication for deployments')
  .option('-r, --repo <repo>', 'GitHub repository in format owner/repo (auto-detected from git remote)')
  .option('-b, --branch <branch>', 'Branch to allow deployments from (use * for all branches)', '*')
  .option('--region <region>', 'AWS region', process.env.AWS_REGION || 'us-east-1')
  .option('--role-name <name>', 'Name for the IAM role (defaults to github-actions-{project}-sst-deploy)')
  .action(async (options: GithubIamOptions) => {
    try {
      const { branch, region } = options;
      let repo = options.repo;
      let roleName = options.roleName;

      if (!repo) {
        const detectedRepo = detectGitHubRepo();
        if (detectedRepo) {
          repo = detectedRepo;
          console.log(`Auto-detected repository: ${repo}`);
        } else {
          console.error('Error: Could not auto-detect GitHub repository.');
          console.error('Please use --repo flag to specify the repository in format owner/repo');
          process.exit(1);
        }
      }

      if (!repo.includes('/')) {
        console.error('Error: Repository must be in format owner/repo');
        process.exit(1);
      }

      if (!roleName) {
        const configPath = findSstConfig();
        const projectName = configPath ? extractSstProjectName(configPath) : null;
        roleName = projectName
          ? `github-actions-${projectName}-sst-deploy`
          : 'github-actions-sst-deploy';
        console.log(`Using role name: ${roleName}`);
      }

      const [owner, repoName] = repo.split('/');
      const iamClient = new IAMClient({ region });

      const githubOidcUrl = 'https://token.actions.githubusercontent.com';

      console.log(`\nSetting up GitHub Actions OIDC for ${owner}/${repoName}...\n`);

      const oidcProviderArn = await ensureGithubOidcProvider(iamClient, githubOidcUrl);
      console.log(`GitHub OIDC Provider: ${oidcProviderArn}`);

      const trustPolicy = buildTrustPolicy(oidcProviderArn, owner, repoName, branch);

      try {
        const existingRole = await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
        console.log(`Role "${roleName}" already exists with ARN: ${existingRole.Role?.Arn}`);
        console.log('   If you need to update the trust policy, delete the role first and re-run this command.');
      } catch (error: any) {
        if (error.name === 'NoSuchEntityException') {
          const createRoleResponse = await iamClient.send(new CreateRoleCommand({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
            Description: `GitHub Actions deployment role for ${owner}/${repoName}`
          }));

          console.log(`Created IAM Role: ${createRoleResponse.Role?.Arn}`);

          await iamClient.send(new AttachRolePolicyCommand({
            RoleName: roleName,
            PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess'
          }));

          console.log('Attached AdministratorAccess policy');
        } else {
          throw error;
        }
      }

      console.log('\nAdd the following to your GitHub Actions workflow:\n');
      console.log('```yaml');
      console.log('permissions:');
      console.log('  id-token: write');
      console.log('  contents: read');
      console.log('');
      console.log('jobs:');
      console.log('  deploy:');
      console.log('    runs-on: ubuntu-latest');
      console.log('    steps:');
      console.log('      - uses: actions/checkout@v4');
      console.log('');
      console.log('      - name: Configure AWS Credentials');
      console.log('        uses: aws-actions/configure-aws-credentials@v4');
      console.log('        with:');
      console.log(`          role-to-assume: arn:aws:iam::ACCOUNT_ID:role/${roleName}`);
      console.log(`          aws-region: ${region}`);
      console.log('');
      console.log('      - name: Deploy with SST');
      console.log('        run: npx sst deploy --stage production');
      console.log('```\n');

      console.log('Replace ACCOUNT_ID with your AWS account ID in the workflow file.');
      console.log(`The role allows deployments from: ${branch === '*' ? 'all branches' : `branch "${branch}"`}`);

    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });
