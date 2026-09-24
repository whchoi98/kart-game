/**
 * Live acceptance checks for the deployed stack.
 *   npx tsx tools/verify-live.ts [--no-e2e] [--out docs/quality/live-verify.json]
 *
 * Verifies the required topology (CloudFront → prefix-list SG → ALB → private
 * ARM64 Fargate using the VPC's existing NAT gateways), the edge security
 * headers and caching, the API, and a real verified leaderboard submission
 * (whose rows are deleted again afterwards).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DeleteItemCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { runBotTimeTrial } from './sim-report.js';
import { BEST_SORT_KEY, GHOST_SORT_KEY, LOG_CLAIM_SORT_KEY, bestKey, boardKey, ghostKey, logClaimKey, rankKey } from '../src/server/repository.js';
import { logDigest } from '../src/server/validation.js';
import { CLOUDFRONT_PREFIX_LIST_ID, EXISTING_VPC_ID, PRIVATE_SUBNET_IDS, PUBLIC_SUBNET_IDS, STACK_NAME, TARGET_REGION } from '../infra/lib/settings.js';

const REGION = TARGET_REGION;
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1]! : 'docs/quality/live-verify.json';
const E2E = !args.includes('--no-e2e');
/** --custom: run the HTTP/E2E checks through the custom domain (once its public DNS exists). */
const VIA_CUSTOM = args.includes('--custom');

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function aws<T = any>(...a: string[]): T {
  const out = execFileSync('aws', [...a, '--region', REGION, '--output', 'json'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out || 'null') as T;
}

function outputs(): Record<string, string> {
  const st = aws<{ Stacks: Array<{ Outputs: Array<{ OutputKey: string; OutputValue: string }>; StackStatus: string }> }>(
    'cloudformation', 'describe-stacks', '--stack-name', STACK_NAME);
  const s = st.Stacks[0]!;
  check('CloudFormation stack is complete', /_COMPLETE$/.test(s.StackStatus) && !/ROLLBACK/.test(s.StackStatus), s.StackStatus);
  return Object.fromEntries(s.Outputs.map(o => [o.OutputKey, o.OutputValue]));
}

async function fetchT(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  return fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(ms) });
}

async function network(o: Record<string, string>): Promise<void> {
  // ── ALB ──
  const lbs = aws<{ LoadBalancers: any[] }>('elbv2', 'describe-load-balancers').LoadBalancers;
  const lb = lbs.find(l => l.DNSName === o.AlbDnsName);
  check('ALB exists in the existing VPC', !!lb && lb.VpcId === EXISTING_VPC_ID, lb?.LoadBalancerArn ?? 'missing');
  if (!lb) return;
  check('ALB is internet-facing in the public subnets', lb.Scheme === 'internet-facing'
    && lb.AvailabilityZones.every((z: any) => (PUBLIC_SUBNET_IDS as readonly string[]).includes(z.SubnetId)),
    lb.AvailabilityZones.map((z: any) => `${z.ZoneName}:${z.SubnetId}`).join(', '));
  const sgs = aws<{ SecurityGroups: any[] }>('ec2', 'describe-security-groups', '--group-ids', ...lb.SecurityGroups).SecurityGroups;
  const albSg = sgs[0]!;
  const ing = albSg.IpPermissions as any[];
  const onlyPrefix = ing.length === 1 && ing[0].FromPort === 80 && ing[0].ToPort === 80 && ing[0].IpProtocol === 'tcp'
    && ing[0].PrefixListIds.length === 1 && ing[0].PrefixListIds[0].PrefixListId === CLOUDFRONT_PREFIX_LIST_ID
    && ing[0].IpRanges.length === 0 && ing[0].Ipv6Ranges.length === 0 && ing[0].UserIdGroupPairs.length === 0;
  check(`ALB SG admits only the CloudFront prefix list ${CLOUDFRONT_PREFIX_LIST_ID} on TCP 80`, onlyPrefix, `${albSg.GroupId} ingress=${JSON.stringify(ing.map(p => ({ p: p.FromPort, pl: p.PrefixListIds.map((x: any) => x.PrefixListId), cidr: p.IpRanges.map((r: any) => r.CidrIp) })))}`);
  const listeners = aws<{ Listeners: any[] }>('elbv2', 'describe-listeners', '--load-balancer-arn', lb.LoadBalancerArn).Listeners;
  const l80 = listeners.find(l => l.Port === 80);
  check('Listener :80 default action is a fixed 403', !!l80 && l80.DefaultActions[0]?.Type === 'fixed-response' && l80.DefaultActions[0]?.FixedResponseConfig?.StatusCode === '403', `${listeners.length} listener(s)`);
  if (l80) {
    const rules = aws<{ Rules: any[] }>('elbv2', 'describe-rules', '--listener-arn', l80.ListenerArn).Rules.filter(r => !r.IsDefault);
    const headerRule = rules.every(r => r.Conditions.some((c: any) => c.Field === 'http-header' && c.HttpHeaderConfig?.HttpHeaderName === 'X-Origin-Verify'));
    check('Every forwarding rule requires the X-Origin-Verify header', rules.length > 0 && headerRule, `${rules.length} rule(s)`);
  }

  // ── ECS ──
  const svc = aws<{ services: any[] }>('ecs', 'describe-services', '--cluster', o.ClusterName!, '--services', o.ServiceName!).services[0];
  check('ECS service is running the desired task count (>= 2)', !!svc && svc.runningCount >= 2 && svc.runningCount === svc.desiredCount && svc.launchType === 'FARGATE', `${svc?.runningCount}/${svc?.desiredCount} ${svc?.launchType}`);
  const net = svc?.networkConfiguration?.awsvpcConfiguration;
  check('Service subnets are the private subnets, public IP disabled', !!net && net.assignPublicIp === 'DISABLED'
    && net.subnets.length === 2 && net.subnets.every((s: string) => (PRIVATE_SUBNET_IDS as readonly string[]).includes(s)), JSON.stringify(net?.subnets));
  const td = aws<{ taskDefinition: any }>('ecs', 'describe-task-definition', '--task-definition', svc.taskDefinition).taskDefinition;
  const c0 = td.containerDefinitions[0];
  check('Task definition: ARM64 Fargate, read-only root, non-root user', td.runtimePlatform?.cpuArchitecture === 'ARM64'
    && c0.readonlyRootFilesystem === true && c0.user === '1000:1000', `${td.cpu} CPU / ${td.memory} MiB, ${td.runtimePlatform?.cpuArchitecture}`);
  const taskArns = aws<{ taskArns: string[] }>('ecs', 'list-tasks', '--cluster', o.ClusterName!, '--service-name', o.ServiceName!).taskArns;
  const tasks = taskArns.length ? aws<{ tasks: any[] }>('ecs', 'describe-tasks', '--cluster', o.ClusterName!, '--tasks', ...taskArns).tasks : [];
  const eniIds: string[] = [];
  const taskSubnets = new Set<string>();
  for (const t of tasks) for (const a of t.attachments ?? []) for (const d of a.details ?? []) {
    if (d.name === 'networkInterfaceId') eniIds.push(d.value);
    if (d.name === 'subnetId') taskSubnets.add(d.value);
  }
  if (eniIds.length) {
    const enis = aws<{ NetworkInterfaces: any[] }>('ec2', 'describe-network-interfaces', '--network-interface-ids', ...eniIds).NetworkInterfaces;
    check('Task ENIs have no public IP association', enis.every(e => !e.Association?.PublicIp), `${enis.length} ENI(s), private IPs ${enis.map(e => e.PrivateIpAddress).join(', ')}`);
    const taskSg = enis[0].Groups.map((g: any) => g.GroupId);
    const tsg = aws<{ SecurityGroups: any[] }>('ec2', 'describe-security-groups', '--group-ids', ...taskSg).SecurityGroups[0];
    const tIng = tsg.IpPermissions as any[];
    check('Task SG admits only the ALB SG on 8080', tIng.length === 1 && tIng[0].FromPort === 8080
      && tIng[0].UserIdGroupPairs.length === 1 && tIng[0].UserIdGroupPairs[0].GroupId === albSg.GroupId
      && tIng[0].IpRanges.length === 0 && tIng[0].PrefixListIds.length === 0, tsg.GroupId);
  }
  check('Tasks spread over both AZs', taskSubnets.size === 2, [...taskSubnets].join(', '));

  // ── egress through the VPC's existing NAT gateways ──
  const nats = aws<{ NatGateways: any[] }>('ec2', 'describe-nat-gateways', '--filter', `Name=vpc-id,Values=${EXISTING_VPC_ID}`, 'Name=state,Values=available').NatGateways;
  const natIds = new Set(nats.map(n => n.NatGatewayId));
  const rts = aws<{ RouteTables: any[] }>('ec2', 'describe-route-tables', '--filters', `Name=association.subnet-id,Values=${[...taskSubnets].join(',')}`).RouteTables;
  const viaNat = [...taskSubnets].every(sub => {
    const rt = rts.find(r => r.Associations.some((a: any) => a.SubnetId === sub));
    const def = rt?.Routes.find((r: any) => r.DestinationCidrBlock === '0.0.0.0/0');
    return !!def?.NatGatewayId && natIds.has(def.NatGatewayId);
  });
  check('Task subnets default-route through the VPC\'s existing NAT gateways', viaNat,
    rts.map(r => `${r.RouteTableId}→${r.Routes.find((x: any) => x.DestinationCidrBlock === '0.0.0.0/0')?.NatGatewayId}`).join(', '));
  const stackNat = aws<{ StackResources: any[] }>('cloudformation', 'describe-stack-resources', '--stack-name', STACK_NAME).StackResources
    .filter(r => /EC2::(NatGateway|VPC|Subnet|InternetGateway|RouteTable|Route|VPCEndpoint)$/.test(r.ResourceType));
  check('Stack owns no VPC / subnet / NAT / route / IGW / endpoint', stackNat.length === 0, `${nats.length} NAT gateway(s) in VPC: ${[...natIds].join(', ')}`);

  // ── target health ──
  const tgs = aws<{ TargetGroups: any[] }>('elbv2', 'describe-target-groups', '--load-balancer-arn', lb.LoadBalancerArn).TargetGroups;
  const health = tgs.length ? aws<{ TargetHealthDescriptions: any[] }>('elbv2', 'describe-target-health', '--target-group-arn', tgs[0].TargetGroupArn).TargetHealthDescriptions : [];
  check('All ALB targets healthy', health.length >= 2 && health.every(h => h.TargetHealth.State === 'healthy'), health.map(h => `${h.Target.Id}:${h.TargetHealth.State}`).join(', '));
}

/** Custom domain checks that do not depend on public DNS: pin the name to a CloudFront edge IP. */
function customDomain(o: Record<string, string>): void {
  const custom = new URL(o.SiteUrl!).hostname;
  const native = new URL(o.NativeSiteUrl ?? o.SiteUrl!).hostname;
  if (custom === native) return;
  let edgeIp = '';
  try { edgeIp = execFileSync('dig', ['+short', native], { encoding: 'utf8' }).split('\n').find(l => /^\d+\.\d+\.\d+\.\d+$/.test(l.trim()))?.trim() ?? ''; } catch { /* no dig */ }
  let status = '', subject = '';
  try {
    const out = execFileSync('curl', ['-sv', '--max-time', '20', '--resolve', `${custom}:443:${edgeIp}`, '-o', '/dev/null', '-w', '%{http_code}', `https://${custom}/`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    status = out.trim();
  } catch (e) { status = `error ${(e as Error).message.slice(0, 80)}`; }
  try {
    const verbose = execFileSync('bash', ['-c', `curl -sv --max-time 20 --resolve ${custom}:443:${edgeIp} -o /dev/null https://${custom}/ 2>&1 | grep -E "subject:|SSL certificate verify" || true`], { encoding: 'utf8' });
    subject = verbose.replace(/\s+/g, ' ').trim();
  } catch { /* ignore */ }
  check(`Custom domain ${custom} is served by CloudFront with a valid certificate (DNS-independent)`, status === '200' && /verify ok|subject: CN=\*\.whchoi\.net/.test(subject), `edge ${edgeIp} → ${status}; ${subject.slice(0, 120)}`);
  let resolved = '';
  try { resolved = execFileSync('dig', ['+short', '@8.8.8.8', custom], { encoding: 'utf8' }).trim().replace(/\s+/g, ' '); } catch { /* ignore */ }
  const dnsOk = resolved.includes(native) || resolved.split(' ').some(ip => ip === edgeIp);
  console.log(`${dnsOk ? '✔' : '⚠'} Public DNS for ${custom} ${dnsOk ? 'points at the distribution' : 'is not published yet'} — ${resolved || 'no answer'} (advisory: managed outside this account)`);
}

async function edge(o: Record<string, string>): Promise<void> {
  const site = (VIA_CUSTOM ? o.SiteUrl! : (o.NativeSiteUrl ?? o.SiteUrl!)).replace(/\/$/, '');
  const home = await fetchT(`${site}/`);
  const html = await home.text();
  const h = (n: string) => home.headers.get(n) ?? '';
  check('GET / via CloudFront → 200 HTML', home.status === 200 && h('content-type').includes('text/html') && html.includes('TURBO PALS'), `${home.status} ${h('content-type')}`);
  check('CSP present and script-src is self-only (no unsafe-inline/eval)', /script-src 'self'/.test(h('content-security-policy')) && !/script-src[^;]*unsafe/.test(h('content-security-policy')), h('content-security-policy').slice(0, 90));
  check('HSTS, nosniff, frame DENY, referrer policy', /max-age=\d+/.test(h('strict-transport-security')) && h('x-content-type-options') === 'nosniff'
    && h('x-frame-options').toUpperCase() === 'DENY' && !!h('referrer-policy'), `${h('strict-transport-security')} | ${h('referrer-policy')}`);
  check('index.html is not cached long', /no-cache|no-store|max-age=0/.test(h('cache-control')), h('cache-control'));
  const asset = html.match(/\/assets\/[^"']+\.js/)?.[0];
  if (asset) {
    const a1 = await fetchT(`${site}${asset}`, { headers: { 'accept-encoding': 'br, gzip' } });
    await a1.arrayBuffer();
    const a2 = await fetchT(`${site}${asset}`, { headers: { 'accept-encoding': 'br, gzip' } });
    await a2.arrayBuffer();
    check('Hashed asset is immutable and served from the CloudFront cache', a2.status === 200 && /immutable/.test(a2.headers.get('cache-control') ?? '')
      && /Hit/i.test(a2.headers.get('x-cache') ?? ''), `${asset} ${a2.headers.get('cache-control')} ${a2.headers.get('x-cache')} ${a2.headers.get('content-encoding') ?? ''}`);
  } else check('Hashed asset referenced by index.html', false, 'no /assets/*.js found');
  const hz = await fetchT(`${site}/healthz`);
  const hzBody = await hz.json().catch(() => ({})) as { ok?: boolean; version?: string };
  check('GET /healthz → 200 {ok:true}', hz.status === 200 && hzBody.ok === true, JSON.stringify(hzBody));
  const insecure = await fetchT(site.replace('https://', 'http://') + '/');
  check('HTTP redirects to HTTPS', insecure.status >= 300 && insecure.status < 400 && (insecure.headers.get('location') ?? '').startsWith('https://'), `${insecure.status} → ${insecure.headers.get('location')}`);
  const lbq = await fetchT(`${site}/api/leaderboard?track=sunny-meadow&cc=150`);
  const lbBody = await lbq.json().catch(() => null) as { entries?: unknown[] } | null;
  check('GET /api/leaderboard → 200 JSON', lbq.status === 200 && Array.isArray(lbBody?.entries), `${lbq.status}, ${lbBody?.entries?.length ?? '?'} entries, ${lbq.headers.get('cache-control')}`);
  const bad = await fetchT(`${site}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json', origin: site }, body: JSON.stringify({ trackId: 'nope' }) });
  check('POST /api/runs with an invalid body → 400', bad.status === 400, String(bad.status));

  // ── PWA ──
  const sw = await fetchT(`${site}/sw.js`);
  const swText = await sw.text();
  check('Service worker served fresh (no long cache)', sw.status === 200 && /javascript/.test(sw.headers.get('content-type') ?? '')
    && /no-cache|no-store|max-age=0/.test(sw.headers.get('cache-control') ?? ''), `${sw.status} ${sw.headers.get('cache-control')} ${swText.length} B`);
  const man = await fetchT(`${site}/manifest.webmanifest`);
  const manifest = await man.json().catch(() => null) as { icons?: Array<{ src: string; sizes: string; purpose?: string }>; display?: string; start_url?: string } | null;
  const icons = manifest?.icons ?? [];
  const need = ['192x192', '512x512'];
  let iconsOk = need.every(sz => icons.some(ic => ic.sizes === sz && (ic.purpose ?? 'any').includes('any')))
    && icons.some(ic => ic.sizes === '512x512' && ic.purpose?.includes('maskable'));
  for (const ic of icons) {
    const r = await fetchT(`${site}${ic.src}`);
    await r.arrayBuffer();
    if (r.status !== 200) iconsOk = false;
  }
  check('Manifest installable: 192/512 + maskable icons reachable', man.status === 200 && !!manifest?.start_url && iconsOk, `${icons.length} icons, display ${manifest?.display}`);
  const bj = await (await fetchT(`${site}/build.json`)).json().catch(() => ({})) as { id?: string };
  const metaId = html.match(/<meta name="turbo-pals-build" content="([a-f0-9]+)"/)?.[1];
  check('Shell build id matches build.json and the service worker', !!metaId && metaId === bj.id && swText.includes(metaId), `meta ${metaId} build.json ${bj.id}`);
  const touch = await fetchT(`${site}/icons/apple-touch-icon.png`);
  await touch.arrayBuffer();
  check('iOS home-screen icon (PNG 180) is served', touch.status === 200 && (touch.headers.get('content-type') ?? '').includes('png'), String(touch.status));

  // ── direct ALB access must not work ──
  let direct = 'unreachable';
  try {
    const r = await fetchT(`http://${o.AlbDnsName}/`, {}, 6000);
    direct = String(r.status);
  } catch (e) { direct = `unreachable (${(e as Error).name})`; }
  check('Direct ALB access from outside CloudFront is blocked', direct.startsWith('unreachable') || direct === '403', direct);
}

async function e2e(o: Record<string, string>): Promise<void> {
  const site = (VIA_CUSTOM ? o.SiteUrl! : (o.NativeSiteUrl ?? o.SiteUrl!)).replace(/\/$/, '');
  const trackId = 'sunny-meadow', cc = 150 as const;
  const run = runBotTimeTrial(trackId, cc);
  if (!run.kart.finished) { check('Bot time trial finished locally', false); return; }
  const playerId = crypto.randomUUID();
  const version = (await (await fetchT(`${site}/healthz`)).json() as { version: string }).version.split('+')[0]!;
  const base = { trackId, cc, charId: run.kart.charId, name: 'QA봇', playerId, version };
  // tampered claim → 422
  const tampered = await fetchT(`${site}/api/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: site },
    body: JSON.stringify({ ...base, ticks: run.kart.finishTick - 60, lapTicks: run.kart.lapTicks, log: run.log }),
  });
  check('Tampered time is rejected by server re-simulation (422)', tampered.status === 422, `${tampered.status} ${JSON.stringify(await tampered.json().catch(() => ({}))).slice(0, 120)}`);
  const t0 = performance.now();
  const ok = await fetchT(`${site}/api/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: site },
    body: JSON.stringify({ ...base, ticks: run.kart.finishTick, lapTicks: run.kart.lapTicks, log: run.log }),
  });
  const res = await ok.json().catch(() => ({})) as { accepted?: boolean; id?: string; rank?: number | null };
  check('Honest run is verified and accepted', ok.status === 200 && res.accepted === true && typeof res.id === 'string', `${ok.status} rank=${res.rank} in ${(performance.now() - t0).toFixed(0)} ms`);
  if (!res.id) return;
  try {
    const board = await (await fetchT(`${site}/api/leaderboard?track=${trackId}&cc=${cc}`)).json() as { entries: Array<{ id: string; ticks: number }> };
    check('Accepted run appears on the leaderboard', board.entries.some(e => e.id === res.id && e.ticks === run.kart.finishTick), `${board.entries.length} entries`);
    const ghost = await fetchT(`${site}/api/ghost/${res.id}`);
    const g = await ghost.json().catch(() => ({})) as { log?: string };
    check('Ghost download returns the verified log', ghost.status === 200 && g.log === run.log, String(ghost.status));
  } finally {
    // remove the QA rows so the public board stays clean
    const db = new DynamoDBClient({ region: REGION });
    const keys: Array<[string, string]> = [
      [boardKey(trackId, cc), rankKey(run.kart.finishTick, res.id)],
      [bestKey(trackId, cc, playerId), BEST_SORT_KEY],
      [ghostKey(res.id), GHOST_SORT_KEY],
      [logClaimKey(logDigest(run.log)), LOG_CLAIM_SORT_KEY],
    ];
    for (const [pk, sk] of keys) {
      await db.send(new DeleteItemCommand({ TableName: o.TableName!, Key: { pk: { S: pk }, sk: { S: sk } } }));
    }
    const after = await (await fetchT(`${site}/api/leaderboard?track=${trackId}&cc=${cc}`)).json() as { entries: Array<{ id: string }> };
    check('QA rows cleaned up afterwards', !after.entries.some(e => e.id === res.id), `${keys.length} items deleted`);
  }
}

async function main(): Promise<void> {
  const o = outputs();
  console.log(`SiteUrl ${o.SiteUrl}${VIA_CUSTOM ? ' (checks run through the custom domain)' : ''}`);
  await network(o);
  await edge(o);
  customDomain(o);
  if (E2E) await e2e(o);
  const failed = checks.filter(c => !c.ok);
  mkdirSync(path.dirname(OUT), { recursive: true });
  const build = (() => { try { return JSON.parse(readFileSync('dist/build.json', 'utf8')); } catch { return null; } })();
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), siteUrl: o.SiteUrl, build, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2) + '\n');
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed → ${OUT}`);
  if (failed.length) process.exitCode = 1;
}

void main();
