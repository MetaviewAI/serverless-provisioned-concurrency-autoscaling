import { AwsFunctionConfig } from './@types'

// Generated configuration: a function declares its concurrency for every deployment target, and
// the plugin resolves it for the target being packaged.
//
//   custom:
//     provisionedConcurrencyAutoscaling:
//       target:                    # the deployment target being packaged
//         deploymentTarget: us-prod
//         stage: prod
//         deploymentGroup: us
//       primaryDeploymentGroup: uk # optional, default uk
//
//   functions:
//     graphql:
//       handler: graphql.handler
//       concurrency:
//         targetUtilization: 0.8   # shared by every target, as are scaleInCooldown and statistic
//         prod: { min: 3, max: 500 }
//         alpha: { min: 1, max: 2 }
//         us-prod: { min: 10 }     # optional override for one deployment target, applied last
//
// Resolution:
//   - every target of a stage shares that stage's block;
//   - the prod target in the primary deployment group keeps `prod.min`; every other prod target
//     gets max(alpha.min, 1) capped at `prod.min`;
//   - a block keyed by the target's deploymentTarget overrides the result for that target.
//
// A missing stage block, `min` or `max` means 0, and a floor of 0 means no warm pool on that
// target; a stage block with a ceiling but no floor is rejected, since it could never take effect. A resolved entry with a floor above 0 becomes the function's provisionedConcurrency
// (min) and concurrencyAutoscaling. An entry with
// `maxVCpuCount` instead sizes a Lambda Managed Instances function: `min` becomes its
// FunctionScalingConfig.MinExecutionEnvironments and `maxVCpuCount` the MaxVCpuCount of the
// capacity provider its CapacityProviderConfig references (both in `resources`).

export interface DeploymentTarget {
  deploymentTarget: string
  stage: string
  deploymentGroup: string
}

export interface GeneratedConfig {
  target: DeploymentTarget
  primaryDeploymentGroup?: string
}

export type SpecEntry = Record<string, unknown>

export interface ResolvedEntry {
  min: number
  max?: number
  maxVCpuCount?: number
  targetUtilization?: number
  scaleInCooldown?: number
  statistic?: string
  [key: string]: unknown
}

const STAGE_KEYS = ['prod', 'alpha']
const SETTING_KEYS = [
  'min',
  'max',
  'maxVCpuCount',
  'targetUtilization',
  'scaleInCooldown',
  'statistic',
]
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
  for (const [key, value] of Object.entries(entry)) {
    const settings = isBlock(value) ? Object.keys(value) : [key]
    const unknown = settings.filter(
      (setting) => !SETTING_KEYS.includes(setting),
    )
    if (unknown.length > 0) {
      throw new Error(
        `concurrency of function "${name}" has unknown setting ${unknown.join(', ')}; ` +
          `expected ${SETTING_KEYS.join(', ')}`,
      )
    }
  }
  for (const stage of STAGE_KEYS) {
    const written = entry[stage]
    if (
      isBlock(written) &&
      Number(written.max ?? 0) > 0 &&
      !Number(written.min ?? 0)
    ) {
      throw new Error(
        `concurrency of function "${name}" sets ${stage}.max without a floor; ` +
          'provisioned concurrency cannot scale up from 0, so set min or omit max',
      )
    }
  }
  const block = entry[target.stage]
  const stageBlock: Record<string, unknown> = isBlock(block) ? block : {}
  const resolved: Record<string, unknown> = { min: 0, ...shared, ...stageBlock }

  if (
    target.stage === 'prod' &&
    target.deploymentGroup !== primaryDeploymentGroup
  ) {
    const alpha = entry.alpha
    const alphaMin =
      isBlock(alpha) && typeof alpha.min === 'number' ? alpha.min : 0
    resolved.min = Math.min(resolved.min as number, Math.max(alphaMin, 1))
  }

  const override = entry[target.deploymentTarget]
  if (isBlock(override)) {
    Object.assign(resolved, override)
  }
  if (resolved.max === undefined && resolved.maxVCpuCount === undefined) {
    resolved.max = 0
  }

  const { min, max, maxVCpuCount } = resolved
  const validMin = Number.isInteger(min) && (min as number) >= 0
  const validMax =
    max === undefined
      ? Number.isInteger(maxVCpuCount)
      : Number.isInteger(max) && (max as number) >= (min as number)
  if (!validMin || !validMax) {
    throw new Error(
      `concurrency of function "${name}" resolves to min ${min} / max ${max ?? maxVCpuCount} ` +
        `for ${target.deploymentTarget}; expected integers with 0 <= min <= max`,
    )
  }
  return resolved as ResolvedEntry
}

export function validateTarget(target: DeploymentTarget): void {
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
      `concurrency of function "${name}" sets maxVCpuCount, but resources.extensions.${logicalId} ` +
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

export function applyEntry(
  service: Service,
  name: string,
  entry: ResolvedEntry,
  lambdaLogicalId: (functionName: string) => string,
): void {
  if (entry.maxVCpuCount !== undefined) {
    applyManagedInstances(service, name, lambdaLogicalId(name), entry)
    return
  }
  const fn = service.functions[name]
  for (const key of ['provisionedConcurrency', 'concurrencyAutoscaling']) {
    if (fn[key] !== undefined) {
      throw new Error(
        `function "${name}" sets both ${key} and concurrency; remove one`,
      )
    }
  }
  // A floor of 0 means no warm pool: no alias, no scaling target.
  if (entry.min > 0) {
    fn.provisionedConcurrency = entry.min
    fn.concurrencyAutoscaling = scalingFor(entry)
  }
}

export function applyGeneratedConfig(
  service: Service,
  lambdaLogicalId: (functionName: string) => string,
): void {
  const declared = Object.entries(service.functions ?? {}).filter(
    ([, fn]) => isBlock(fn) && fn.concurrency !== undefined,
  )
  if (declared.length === 0) return

  const config: GeneratedConfig | undefined =
    service.custom?.provisionedConcurrencyAutoscaling
  if (!config) {
    throw new Error(
      'functions declare concurrency but custom.provisionedConcurrencyAutoscaling.target is not set',
    )
  }
  validateTarget(config.target)
  for (const [name, fn] of declared) {
    const entry = resolveEntry(
      name,
      (fn as Record<string, unknown>).concurrency as SpecEntry,
      config.target,
      config.primaryDeploymentGroup,
    )
    delete (fn as Record<string, unknown>).concurrency
    applyEntry(service, name, entry, lambdaLogicalId)
  }
}
