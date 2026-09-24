/**
 * Deployment constants for the only authorised target. The stack refuses to
 * synthesise for anything else (see stack.ts), so a mistyped context value can
 * never place the game in another account, region or network.
 */
export const TARGET_ACCOUNT = '061525506239';
export const TARGET_REGION = 'ap-northeast-2';
export const EXISTING_VPC_ID = 'vpc-0dfa5610180dfa628';
/** AWS-managed prefix list com.amazonaws.global.cloudfront.origin-facing (ap-northeast-2). */
export const CLOUDFRONT_PREFIX_LIST_ID = 'pl-22a6434b';

export const AVAILABILITY_ZONES = ['ap-northeast-2a', 'ap-northeast-2b'] as const;
/** ALB placement (route 0.0.0.0/0 → IGW). */
export const PUBLIC_SUBNET_IDS = ['subnet-08486a1e618b1991e', 'subnet-0c161777c4031c320'] as const;
/** Task placement (route 0.0.0.0/0 → the VPC's existing NAT gateways). */
export const PRIVATE_SUBNET_IDS = ['subnet-07b1e65682847dce9', 'subnet-095297380cd45e1eb'] as const;

export const STACK_NAME = 'TurboPalsStack';
export const PROJECT_TAG = 'turbo-pals';
export const APP_PORT = 8080;
export const ORIGIN_VERIFY_HEADER = 'X-Origin-Verify';

export const TASK_CPU = 1024;
export const TASK_MEMORY_MIB = 2048;
export const MIN_TASKS = 2;
export const MAX_TASKS = 6;
export const CPU_TARGET_PERCENT = 60;
/** ALBRequestCountPerTarget (requests per target per minute) that triggers scale-out. */
export const REQUESTS_PER_TARGET = 600;

/** Custom viewer domain (DNS is managed outside this account: CNAME → the distribution). */
export const CUSTOM_DOMAIN = 'my-kart.whchoi.net';
/** Existing *.whchoi.net ACM certificate in us-east-1 (required region for CloudFront). */
export const VIEWER_CERTIFICATE_ARN = 'arn:aws:acm:us-east-1:061525506239:certificate/7d53182a-2a2a-4225-a319-4f94030561b7';
