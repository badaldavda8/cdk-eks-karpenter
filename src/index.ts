import { Aws } from 'aws-cdk-lib';
import { Cluster, HelmChart } from 'aws-cdk-lib/aws-eks';
import { CfnInstanceProfile, ManagedPolicy, Policy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import semver from 'semver';


export interface KarpenterProps {
  /**
   * The EKS Cluster to attach to
   */
  readonly cluster: Cluster;

  /**
   * The Kubernetes namespace to install to
   *
   * @default karpenter
   */
  readonly namespace?: string;

  /**
   * The helm chart version to install
   *
   * @default - latest
   */
  readonly version?: string;

  /**
   * Helm repository where to find the chart
   *
   * @default - oci://public.ecr.aws/karpenter
   */
  readonly helmRepository?: string;
}

export class Karpenter extends Construct {
  public readonly cluster: Cluster;
  public readonly namespace: string;
  public readonly version?: string;
  public readonly helmRepository?: string;
  public readonly nodeRole: Role;
  private readonly chart: HelmChart;

  constructor(scope: Construct, id: string, props: KarpenterProps) {
    super(scope, id);

    this.cluster = props.cluster;
    this.namespace = props.namespace ?? 'karpenter';
    this.version = props.version;

    // set helmRepository
    if (props.helmRepository !== undefined) {
      this.helmRepository = props.helmRepository;
    } else {
      // If the Karpenter release is <v0.17.0, use the old chart repo
      if (
        this.version !== undefined && semver.lt(this.version, '0.17.0')
      ) {
        this.helmRepository = 'https://charts.karpenter.sh';
      } else {
        this.helmRepository = 'oci://public.ecr.aws/karpenter';
      }
    }


    /*
     * We create a node role for Karpenter managed nodes, alongside an instance profile for the EC2
     * instances that will be managed by karpenter.
     *
     * We will also create a role mapping in the `aws-auth` ConfigMap so that the nodes can authenticate
     * with the Kubernetes API using IAM.
     */
    this.nodeRole = new Role(this, 'NodeRole', {
      assumedBy: new ServicePrincipal(`ec2.${Aws.URL_SUFFIX}`),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    const instanceProfile = new CfnInstanceProfile(this, 'InstanceProfile', {
      roles: [this.nodeRole.roleName],
      instanceProfileName: `${this.cluster.clusterName}-${id}`, // Must be specified to avoid CFN error
    });

    this.cluster.awsAuth.addRoleMapping(this.nodeRole, {
      username: 'system:node:{{EC2PrivateDNSName}}',
      groups: [
        'system:bootstrappers',
        'system:nodes',
      ],
    });

    /**
     * For the Karpenter controller to be able to talk to the AWS APIs, we need to set up a few
     * resources which will allow the Karpenter controller to use IAM Roles for Service Accounts
     */
    const namespace = this.cluster.addManifest('namespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: this.namespace,
      },
    });

    const serviceAccount = this.cluster.addServiceAccount('karpenter', {
      namespace: this.namespace,
    });
    serviceAccount.node.addDependency(namespace);

    new Policy(this, 'ControllerPolicy', {
      roles: [serviceAccount.role],
      statements: [
        new PolicyStatement({
          actions: [
            'ec2:CreateFleet',
            'ec2:CreateLaunchTemplate',
            'ec2:CreateTags',
            'ec2:DeleteLaunchTemplate',
            'ec2:RunInstances',
            'ec2:TerminateInstances',
            'ec2:DescribeAvailabilityZones',
            'ec2:DescribeImages',
            'ec2:DescribeInstances',
            'ec2:DescribeInstanceTypeOfferings',
            'ec2:DescribeInstanceTypes',
            'ec2:DescribeLaunchTemplates',
            'ec2:DescribeSecurityGroups',
            'ec2:DescribeSpotPriceHistory',
            'ec2:DescribeSubnets',
            'pricing:GetProducts',
            'ssm:GetParameter',
          ],
          resources: ['*'],
        }),
        new PolicyStatement({
          actions: [
            'iam:PassRole',
          ],
          resources: [this.nodeRole.roleArn],
        }),
      ],
    });

    /**
     * Finally, we can go ahead and install the Helm chart provided for Karpenter with the inputs
     * we desire.
     */
    this.chart = this.cluster.addHelmChart('karpenter', {
      // This one is important, if we don't ask helm to wait for resources to become available, the
      // subsequent creation of karpenter resources will fail.
      wait: true,
      chart: 'karpenter',
      release: 'karpenter',
      repository: this.helmRepository,
      namespace: this.namespace,
      version: this.version ?? undefined,
      createNamespace: false,
      values: {
        serviceAccount: {
          create: false,
          name: serviceAccount.serviceAccountName,
          annotations: {
            'eks.amazonaws.com/role-arn': serviceAccount.role.roleArn,
          },
        },
        clusterName: this.cluster.clusterName,
        clusterEndpoint: this.cluster.clusterEndpoint,
        aws: {
          defaultInstanceProfile: instanceProfile.ref,
        },
      },
    });
    this.chart.node.addDependency(namespace);
  }

  /**
   * addProvisioner adds a provisioner manifest to the cluster. Currently the provisioner spec
   * parameter is relatively free form.
   *
   * @param id - must consist of lower case alphanumeric characters, \'-\' or \'.\', and must start and end with an alphanumeric character
   * @param provisionerSpec - spec of Karpenters Provisioner object.
   */
  public addProvisioner(id: string, provisionerSpec: Record<string, any>): void {
    let m = {
      apiVersion: 'karpenter.sh/v1alpha5',
      kind: 'Provisioner',
      metadata: {
        name: id,
        namespace: this.namespace,
      },
      spec: {},
    };
    m.spec = provisionerSpec;
    let provisioner = this.cluster.addManifest(id, m);
    provisioner.node.addDependency(this.chart);
  }
}