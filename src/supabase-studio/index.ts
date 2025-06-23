import * as path from 'path';
import * as amplify from '@aws-cdk/aws-amplify-alpha';
import * as cdk from 'aws-cdk-lib';
import { BuildSpec } from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface SupabaseStudioProps {
  sourceBranch?: string;
  appRoot?: string;
  supabaseUrl: string;
  dbSecret: ISecret;
  anonKey: StringParameter;
  serviceRoleKey: StringParameter;
}

export class SupabaseStudio extends Construct {
  /** App in Amplify Hosting. It is a collection of branches. */
  readonly app: amplify.App;
  /** Production branch */
  readonly prodBranch: amplify.Branch;
  /** URL of production branch */
  readonly prodBranchUrl: string;

  /** Next.js app on Amplify Hosting */
  constructor(scope: Construct, id: string, props: SupabaseStudioProps) {
    super(scope, id);

    const buildImage = 'public.ecr.aws/sam/build-nodejs22.x:latest';
    const sourceBranch = props.sourceBranch ?? 'stable';
    const appRoot = props.appRoot ?? 'apps/studio';
    const { supabaseUrl, dbSecret, anonKey, serviceRoleKey } = props;

    /** IAM Role for SSR app logging */
    const role = new iam.Role(this, 'Role', {
      description: 'The service role that will be used by AWS Amplify for SSR app logging.',
      path: '/service-role/',
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
    });

    // Allow the role to access Secret and Parameter
    dbSecret.grantRead(role);
    anonKey.grantRead(role);
    serviceRoleKey.grantRead(role);

    /** BuildSpec for Amplify Hosting */
    const buildSpec = BuildSpec.fromObjectToYaml({
      version: 1,
      applications: [{
        frontend: {
          phases: {
            preBuild: {
              commands: [
                // appRoot=${CODEBUILD_SRC_DIR}/supabase
                'APP_ROOT=${CODEBUILD_SRC_DIR}/supabase',
                'POSTGRES_PASSWORD=$(aws secretsmanager get-secret-value --secret-id $DB_SECRET_ARN --query SecretString | jq -r . | jq -r .password)',
                'SUPABASE_ANON_KEY=$(aws ssm get-parameter --region $SUPABASE_REGION --name $ANON_KEY_NAME --query Parameter.Value)',
                'SUPABASE_SERVICE_KEY=$(aws ssm get-parameter --region $SUPABASE_REGION --name $SERVICE_KEY_NAME --query Parameter.Value)',
                'env >> .env.production',
                'npm install -g pnpm@9.15.5',
                // create APP_ROOT/out
                'pnpm dlx turbo@2.3.3 prune studio',
              ],
            },
            build: {
              commands: [
                'cp -r .env.production ${APP_ROOT}/out/apps/studio/',
                'cd ${APP_ROOT}/out',
                // create out/node_modules
                'pnpm install --frozen-lockfile',
                // build
                'pnpm --filter studio exec next build',
              ],
            },
            postBuild: {
              commands: [
                'cd ${APP_ROOT}',
                'DEPLOY_ROOT=${APP_ROOT}/.amplify-hosting',
                // setup .amplify-hosting deployment
                'mkdir -pv ${DEPLOY_ROOT}/{compute/default,.next}',
                'rsync -avq --ignore-existing ${APP_ROOT}/out/apps/studio/.next/standalone/* ${DEPLOY_ROOT}/compute/default',
                'rsync -avq --ignore-existing ${APP_ROOT}/out/apps/studio/public             ${DEPLOY_ROOT}/compute/default',
                'rsync -avq --ignore-existing  ${APP_ROOT}/out/apps/studio/.next/static      ${DEPLOY_ROOT}/',
                'cp .env.production ${DEPLOY_ROOT}/',
                // ensure server.js is in ${DEPLOY_ROOT}
                'cd ${DEPLOY_ROOT}',
                'ln -sf apps/studio/server.js .',
                // setup deploy-manifest.json
                'jq -n --arg version 1 --arg computeResources null --arg routes null "$ARGS.named" > .deploy.tmp',
                'jq ".computeResources=$(jq -n --arg name default --arg runtime nodejs22.x --arg entrypoint server.js \'$ARGS.named\')" .deploy.tmp > deploy-manifest.json',
                // required-server-files.json
                // 'cp apps/studio/required-server-files.json .',
              ],
            },
          },
          artifacts: {
            baseDirectory: '.amplify-hosting',
            files: ['**/*'],
          },
        },
        appRoot,
      }],
    });

    this.app = new amplify.App(this, 'App', {
      appName: this.node.path.replace(/\//g, ''),
      role,
      sourceCodeProvider: new amplify.GitHubSourceCodeProvider({
        owner: 'knowtions',
        repository: 'supabase',
        oauthToken: cdk.SecretValue.secretsManager("Supabase-Studio-Github-Access-Token", {jsonField: "supabase-github-access-token"})
      }),
    
      buildSpec,
      environmentVariables: {
        // for Amplify Hosting Build
        NODE_OPTIONS: '--max-old-space-size=4096',
        AMPLIFY_MONOREPO_APP_ROOT: appRoot,
        AMPLIFY_DIFF_DEPLOY: 'false',
        _CUSTOM_IMAGE: buildImage,
        // for Supabase
        STUDIO_PG_META_URL: `${supabaseUrl}/pg`,
        SUPABASE_URL: `${supabaseUrl}`,
        SUPABASE_PUBLIC_URL: `${supabaseUrl}`,
        SUPABASE_REGION: serviceRoleKey.env.region,
        DB_SECRET_ARN: dbSecret.secretArn,
        ANON_KEY_NAME: anonKey.parameterName,
        SERVICE_KEY_NAME: serviceRoleKey.parameterName,
      },
      customRules: [
        { source: '/<*>', target: '/index.html', status: amplify.RedirectStatus.NOT_FOUND_REWRITE },
      ],
    });

    /** SSR v2 */
    (this.app.node.defaultChild as cdk.CfnResource).addPropertyOverride('Platform', 'WEB_DYNAMIC');

    this.prodBranch = this.app.addBranch('ProdBranch', {
      branchName: 'stable',
      stage: 'PRODUCTION',
      autoBuild: true,
      environmentVariables: {
        NEXT_PUBLIC_SITE_URL: `https://stable.${this.app.appId}.amplifyapp.com`,
      },
    });
    (this.prodBranch.node.defaultChild as cdk.CfnResource).addPropertyOverride('Framework', 'Next.js - SSR');

    /** IAM Policy for SSR app logging */
    const amplifySSRLoggingPolicy = new iam.Policy(this, 'AmplifySSRLoggingPolicy', {
      policyName: `AmplifySSRLoggingPolicy-${this.app.appId}`,
      statements: [
        new iam.PolicyStatement({
          sid: 'PushLogs',
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/amplify/${this.app.appId}:log-stream:*`],
        }),
        new iam.PolicyStatement({
          sid: 'CreateLogGroup',
          actions: ['logs:CreateLogGroup'],
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/amplify/*`],
        }),
        new iam.PolicyStatement({
          sid: 'DescribeLogGroups',
          actions: ['logs:DescribeLogGroups'],
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:*`],
        }),
      ],
    });
    amplifySSRLoggingPolicy.attachToRole(role);

    this.prodBranchUrl = `https://${this.prodBranch.branchName}.${this.app.defaultDomain}`;
  }

}
