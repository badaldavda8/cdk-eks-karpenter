const { awscdk } = require('projen');
const { DependabotScheduleInterval } = require('projen/lib/github');

const PROJECT_NAME = 'cdk-eks-karpenter';

const project = new awscdk.AwsCdkConstructLibrary({
  author: 'Andreas Lindh',
  authorAddress: 'elindh@amazon.com',
  description: 'CDK construct library that allows you install Karpenter in an AWS EKS cluster',
  keywords: ['eks', 'karpenter'],
  cdkVersion: '2.61.1',
  devDeps: ['@aws-cdk/lambda-layer-kubectl-v24'],
  defaultReleaseBranch: 'main',
  name: PROJECT_NAME,
  repositoryUrl: 'https://github.com/aws-samples/cdk-eks-karpenter.git',

  pullRequestTemplateContents: [
    '---',
    '*By submitting this pull request, I confirm that my contribution is made under the terms of the Apache-2.0 license*',
  ],

  publishToPypi: {
    distName: PROJECT_NAME,
    module: 'cdk_eks_karpenter',
  },

  dependabot: true,
  dependabotOptions: {
    scheduleInterval: DependabotScheduleInterval.MONTHLY,
  },
});

const common_excludes = [
  'cdk.out/',
  'cdk.context.json',
  '.env',
];
project.gitignore.exclude(...common_excludes);
project.npmignore.exclude(...common_excludes);

project.addTask('test:deploy', {
  exec: 'npx cdk deploy -a "npx ts-node -P tsconfig.dev.json --prefer-ts-exts test/integ.karpenter.ts"',
});
project.addTask('test:destroy', {
  exec: 'npx cdk destroy -a "npx ts-node -P tsconfig.dev.json --prefer-ts-exts test/integ.karpenter.ts"',
});
project.addTask('test:synth', {
  exec: 'npx cdk synth -a "npx ts-node -P tsconfig.dev.json --prefer-ts-exts test/integ.karpenter.ts"',
});

project.synth();