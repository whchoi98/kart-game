import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { AVAILABILITY_ZONES, EXISTING_VPC_ID, PRIVATE_SUBNET_IDS, PUBLIC_SUBNET_IDS } from './settings.js';

/**
 * Imports the existing VPC; creates nothing. Subnets, routes, the internet
 * gateway and the NAT gateways all stay owned by the network team. Lookup
 * results come from the checked-in cdk.context.json.
 */
export class Network extends Construct {
  readonly vpc: ec2.IVpc;
  /** Internet-facing ALB: the two public subnets. */
  readonly publicSubnets: ec2.SubnetSelection;
  /** Fargate tasks: the two private subnets whose default route is an existing NAT gateway. */
  readonly privateSubnets: ec2.SubnetSelection;

  constructor(scope: Construct, id: string, vpcId: string) {
    super(scope, id);
    this.vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId });
    const availabilityZones = [...AVAILABILITY_ZONES];
    this.publicSubnets = { subnetType: ec2.SubnetType.PUBLIC, availabilityZones, onePerAz: true };
    this.privateSubnets = { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, availabilityZones, onePerAz: true };

    // The first synth of a fresh checkout returns a dummy VPC until the lookup
    // is cached; only the real VPC is checked against the verified subnet ids.
    if (this.vpc.vpcId === EXISTING_VPC_ID) {
      const selected = (selection: ec2.SubnetSelection) =>
        this.vpc.selectSubnets(selection).subnetIds.slice().sort();
      const expectPlacement = (label: string, actual: string[], expected: readonly string[]) => {
        if (actual.join(',') !== [...expected].sort().join(',')) {
          throw new Error(`${label} subnets resolved to [${actual.join(', ')}], expected [${expected.join(', ')}]. ` +
            'Refresh cdk.context.json (cdk context --clear) only after verifying the VPC routes.');
        }
      };
      expectPlacement('Public (ALB)', selected(this.publicSubnets), PUBLIC_SUBNET_IDS);
      expectPlacement('Private (tasks)', selected(this.privateSubnets), PRIVATE_SUBNET_IDS);
    }
  }
}
