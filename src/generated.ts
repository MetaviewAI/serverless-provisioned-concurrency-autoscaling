import { AwsFunctionConfig } from './@types'

// Generated configuration: one spec per service, resolved for the deployment target being packaged
// and applied to the functions it names, so functions carry no concurrency configuration.
//
//   custom:
//     provisionedConcurrencyAutoscaling:
//       spec: ${file(./provisionedConcurrency.yml)}
//       target:                    # the deployment target being packaged
//         deploymentTarget: us-prod
//         stage: prod
//         deploymentGroup: us
//       primaryDeploymentGroup: uk # optional, default uk
//
// Spec, one entry per function key:
//
//   graphql:
//     targetUtilization: 0.8   # shared by every target, as are scaleInCooldown and statistic
//     prod: { min: 3, max: 500 }
//     alpha: { min: 1, max: 2 }
//     us-prod: { min: 10 }     # optional override for one deployment target, applied last
//
// Resolution:
//   - every target of a stage shares that stage's block;
//   - the prod target in the primary deployment group keeps `prod.min`; every other prod target
//     gets max(alpha.min, 1) capped at `prod.min`;
//   - a block keyed by the target's deploymentTarget overrides the result for that target.
//
// A resolved entry with `max` becomes the function's provisionedConcurrency (min) and
// concurrencyAutoscaling, plus reservedConcurrency when it sets `reserved`. An entry with
// `maxVCpuCount` instead sizes a Lambda Managed Instances function: `min` becomes its
// FunctionScalingConfig.MinExecutionEnvironments and `maxVCpuCount` the MaxVCpuCount of the
// capacity provider its CapacityProviderConfig references (both in `resources`).

export interface DeploymentTarget {
  deploymentTarget: string
  stage: string
  deploymentGroup: string
}

export interface GeneratedConfig {
  spec: Record<string, SpecEntry>
  target: DeploymentTarget
  primaryDeploymentGroup?: string
}

export type SpecEntry = Record<string, unknown>

export interface ResolvedEntry {
  min: number
  max?: number
  maxVCpuCount?: number
  reserved?: number
  targetUtilization?: number
  scaleInCooldown?: number
  statistic?: string
  [key: string]: unknown
}

const STAGE_KEYS = ['prod', 'alpha']
const DEFAULT_PRIMARY_DEPLOYMENT_GROUP = 'uk'

const isBlock = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function resolveEntry(
  name: string,
  entry: SpecEntry,
  target: DeploymentTarget,
  primaryDeploymentGroup = DEFAULT_PRIMARY_DEPLOYMENT_GROUP,
): ResolvedEntry {
  const shared = Object.fromEntries(
    Object.entries(entry).filter(([, value]) => !isBlock(value)),
  )
  const stageBlock = entry[target.stage]
  if (!isBlock(stageBlock)) {
    throw new Error(
      `provisioned concurrency entry "${name}" has no "${target.stage}" block`,
    )
  }
  const resolved: Record<string, unknown> = { ...shared, ...stageBlock }

  if (
    target.stage === 'prod' &&
    target.deploymentGroup !== primaryDeploymentGroup
  ) {
    const alpha = entry.alpha
    const alphaMin =
      isBlock(alpha) && typeof alpha.min === 'number' ? alpha.min : 0
    resolved.min = Math.min(stageBlock.min as number, Math.max(alphaMin, 1))
  }

  const override = entry[target.deploymentTarget]
  if (isBlock(override)) {
    Object.assign(resolved, override)
  }

  const { min, max, maxVCpuCount } = resolved
  const validMin = Number.isInteger(min) && (min as number) >= 0
  const validMax =
    max === undefined
      ? Number.isInteger(maxVCpuCount)
      : Number.isInteger(max) && (max as number) >= (min as number)
  if (!validMin || !validMax) {
    throw new Error(
      `provisioned concurrency entry "${name}" resolves to min ${min} / max ${max ?? maxVCpuCount} ` +
        `for ${target.deploymentTarget}; expected integers with 0 <= min <= max`,
    )
  }
  return resolved as ResolvedEntry
}

export function resolveSpec(
  config: GeneratedConfig,
): Record<string, ResolvedEntry> {
  const { spec, target, primaryDeploymentGroup } = config
  for (const key of ['deploymentTarget', 'stage', 'deploymentGroup']) {
    if (typeof target?.[key] !== 'string') {
      throw new Error(
        `provisionedConcurrencyAutoscaling.target needs a "${key}"`,
      )
    }
  }
  if (!STAGE_KEYS.includes(target.stage)) {
    throw new Error(
      `unsupported stage "${target.stage}"; expected one of ${STAGE_KEYS.join(', ')}`,
    )
  }
  return Object.fromEntries(
    Object.entries(spec ?? {}).map(([name, entry]) => [
      name,
      resolveEntry(name, entry, target, primaryDeploymentGroup),
    ]),
  )
}

export function scalingFor(entry: ResolvedEntry): AwsFunctionConfig {
  const { min, max, targetUtilization, scaleInCooldown, statistic } = entry
  return {
    enabled: true,
    minimum: min,
    maximum: max,
    ...(targetUtilization !== undefined && { usage: targetUtilization }),
    ...(scaleInCooldown !== undefined && { scaleInCooldown }),
    customMetric: { statistic: statistic ?? 'average' },
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Service = any

function capacityProviderLogicalId(arn: unknown): string | undefined {
  const getAtt = isBlock(arn) ? arn['Fn::GetAtt'] : undefined
  if (Array.isArray(getAtt)) return getAtt[0]
  if (typeof getAtt === 'string') return getAtt.split('.')[0]
  return undefined
}

function applyManagedInstances(
  service: Service,
  name: string,
  logicalId: string,
  entry: ResolvedEntry,
): void {
  const resources = service.resources ?? {}
  const functionResource = resources.extensions?.[logicalId]
  const providerConfig =
    functionResource?.Properties?.CapacityProviderConfig
      ?.LambdaManagedInstancesCapacityProviderConfig
  const providerId = capacityProviderLogicalId(
    providerConfig?.CapacityProviderArn,
  )
  const provider = providerId ? resources.Resources?.[providerId] : undefined
  if (provider?.Type !== 'AWS::Lambda::CapacityProvider') {
    throw new Error(
      `provisioned concurrency entry "${name}" sets maxVCpuCount, but resources.extensions.${logicalId} ` +
        'does not reference an AWS::Lambda::CapacityProvider in resources.Resources',
    )
  }
  functionResource.Properties.FunctionScalingConfig = {
    ...functionResource.Properties.FunctionScalingConfig,
    MinExecutionEnvironments: entry.min,
  }
  provider.Properties.CapacityProviderScalingConfig = {
    ...provider.Properties.CapacityProviderScalingConfig,
    MaxVCpuCount: entry.maxVCpuCount,
  }
}

export function applySpec(
  service: Service,
  resolved: Record<string, ResolvedEntry>,
  lambdaLogicalId: (functionName: string) => string,
): void {
  for (const [name, entry] of Object.entries(resolved)) {
    const fn = service.functions?.[name]
    if (!fn) {
      throw new Error(
        `provisioned concurrency entry "${name}" matches no function`,
      )
    }
    if (entry.maxVCpuCount !== undefined) {
      applyManagedInstances(service, name, lambdaLogicalId(name), entry)
      continue
    }
    const owned = ['provisionedConcurrency', 'concurrencyAutoscaling']
    if (entry.reserved !== undefined) owned.push('reservedConcurrency')
    for (const key of owned) {
      if (fn[key] !== undefined) {
        throw new Error(
          `function "${name}" sets ${key} and has a provisioned concurrency entry; remove one`,
        )
      }
    }
    fn.provisionedConcurrency = entry.min
    fn.concurrencyAutoscaling = scalingFor(entry)
    if (entry.reserved !== undefined) {
      fn.reservedConcurrency = entry.reserved
    }
  }
}
