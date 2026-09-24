import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Data } from './data.js';
import { Edge } from './edge.js';
import { AccessLogs } from './logs.js';
import { Network } from './network.js';
import { Service } from './service.js';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { CLOUDFRONT_PREFIX_LIST_ID, CUSTOM_DOMAIN, EXISTING_VPC_ID, PROJECT_TAG, TARGET_ACCOUNT, TARGET_REGION } from './settings.js';

export interface TurboPalsStackProps extends cdk.StackProps {
  readonly vpcId: string;
  readonly cloudfrontPrefixListId: string;
  /** Bump to rotate the CloudFront → ALB origin secret without downtime (default 1). */
  readonly originSecretGeneration?: number;
  /** Docker build context override (tests use a fixture; default is the project root). */
  readonly imageDirectory?: string;
  /** Custom viewer hostname (must be CUSTOM_DOMAIN) — requires certificateArn. */
  readonly domainName?: string;
  /** us-east-1 ACM certificate covering domainName. */
  readonly certificateArn?: string;
}

/**
 * CloudFront → ALB (CloudFront prefix list only, X-Origin-Verify) → ARM64 Fargate
 * tasks in the existing VPC's private subnets (egress through its NAT gateways)
 * → DynamoDB. Creates no VPC, subnet, route, gateway or endpoint.
 */
export class TurboPalsStack extends cdk.Stack {
  readonly network: Network;
  readonly data: Data;
  readonly accessLogs: AccessLogs;
  readonly service: Service;
  readonly edge: Edge;

  constructor(scope: Construct, id: string, props: TurboPalsStackProps) {
    super(scope, id, {
      ...props,
      description: 'TURBO PALS GRAND PRIX - CloudFront, CloudFront-only ALB, private ARM64 Fargate (existing VPC/NAT), DynamoDB',
    });
    // Safety guards: this stack may only ever target the verified environment.
    if (this.account !== TARGET_ACCOUNT) throw new Error(`TurboPalsStack must deploy to AWS account ${TARGET_ACCOUNT} (got ${this.account}).`);
    if (this.region !== TARGET_REGION) throw new Error(`TurboPalsStack must deploy to region ${TARGET_REGION} (got ${this.region}).`);
    if (props.vpcId !== EXISTING_VPC_ID) throw new Error(`TurboPalsStack may only use the existing VPC ${EXISTING_VPC_ID} (got ${props.vpcId}).`);
    if (props.cloudfrontPrefixListId !== CLOUDFRONT_PREFIX_LIST_ID) {
      throw new Error(`The ALB must admit only the CloudFront origin-facing prefix list ${CLOUDFRONT_PREFIX_LIST_ID} (got ${props.cloudfrontPrefixListId}).`);
    }
    if (!!props.domainName !== !!props.certificateArn) throw new Error('domainName and certificateArn must be configured together.');
    if (props.domainName && props.domainName !== CUSTOM_DOMAIN) throw new Error(`Only the custom domain ${CUSTOM_DOMAIN} is authorised (got ${props.domainName}).`);
    if (props.certificateArn && !props.certificateArn.startsWith(`arn:aws:acm:us-east-1:${TARGET_ACCOUNT}:certificate/`)) {
      throw new Error('CloudFront needs an existing us-east-1 ACM certificate in the target account.');
    }
    cdk.Tags.of(this).add('Project', PROJECT_TAG);

    this.network = new Network(this, 'Network', props.vpcId);
    this.data = new Data(this, 'Data', { originSecretGeneration: props.originSecretGeneration });
    this.accessLogs = new AccessLogs(this, 'AccessLogs');
    this.service = new Service(this, 'Compute', {
      vpc: this.network.vpc,
      publicSubnets: this.network.publicSubnets,
      privateSubnets: this.network.privateSubnets,
      cloudfrontPrefixListId: props.cloudfrontPrefixListId,
      table: this.data.table,
      originSecret: this.data.originSecret,
      previousOriginSecret: this.data.previousOriginSecret,
      accessLogs: this.accessLogs.bucket,
      imageDirectory: props.imageDirectory,
    });
    this.edge = new Edge(this, 'Edge', {
      loadBalancer: this.service.loadBalancer,
      originVerifyValue: this.service.originVerifyValue,
      accessLogs: this.accessLogs.bucket,
      domainName: props.domainName,
      certificate: props.certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'ViewerCertificate', props.certificateArn)
        : undefined,
    });

    // During a secret rotation the ALB must accept the new value before any edge sends it.
    this.edge.distribution.node.addDependency(this.service.originRule);

    // The distribution depends on the ALB, never on the task definition, so
    // handing its hostname to the container creates no dependency cycle.
    const nativeOrigin = `https://${this.edge.distribution.distributionDomainName}`;
    const siteOrigin = props.domainName ? `https://${props.domainName}` : nativeOrigin;
    this.service.container.addEnvironment('PUBLIC_ORIGIN', siteOrigin);
    // both hostnames serve the same build; the API's Origin allow-list must accept either
    if (props.domainName) this.service.container.addEnvironment('ALLOWED_ORIGINS', nativeOrigin);

    const outputs: Record<string, { value: string; description: string }> = {
      SiteUrl: { value: `${siteOrigin}/`, description: 'Game URL' },
      NativeSiteUrl: { value: `${nativeOrigin}/`, description: 'Game URL on the default CloudFront hostname' },
      DistributionId: { value: this.edge.distribution.distributionId, description: 'CloudFront distribution id (cache invalidation)' },
      AlbDnsName: { value: this.service.loadBalancer.loadBalancerDnsName, description: 'ALB DNS name (answers 403 to anything but CloudFront)' },
      ClusterName: { value: this.service.cluster.clusterName, description: 'ECS cluster' },
      ServiceName: { value: this.service.service.serviceName, description: 'ECS service' },
      TableName: { value: this.data.table.tableName, description: 'DynamoDB rankings table (retained on destroy)' },
    };
    for (const [name, output] of Object.entries(outputs)) new cdk.CfnOutput(this, name, output);
  }
}
