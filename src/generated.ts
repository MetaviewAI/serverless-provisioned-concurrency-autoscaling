import { createHash } from 'crypto'
import { AwsFunctionConfig } from './@types'

// Generated configuration: a function declares its concurrency per deploy, in blocks named after
// the deploys, and the plugin applies the block for the deploy being packaged.
//
//   custom:
//     provisionedConcurrencyAutoscaling:
//       target: us-prod                          # the deploy being packaged
//       deploys:                                 # every valid deploy name
//         uk-prod: {}
//         us-prod: { from: uk-prod, maxFloor: 1 } # borrows uk-prod, at most 1 warm instance
//
//   functions:
//     graphql:
//       handler: graphql.handler
//       concurrency:
//         targetUtilization: 0.8                 # settings outside a block apply to every block
//         uk-prod: { min: 3, max: 500 }
//         us-prod: { min: 10 }                   # optional: laid over the borrowed block
//
// For the target, the plugin starts from the `from` block of the target's deploy entry, if any
// (its provisioned-concurrency floor capped at `maxFloor`), then lays the target's own block over
// it. Block names outside `deploys` fail the package, so a typo cannot silently drop a warm pool.
// A missing block, `min` or `max` means 0, and a floor of 0 means no warm pool: the function gets
// no provisionedConcurrency or concurrencyAutoscaling. A floor above 0 becomes the function's
// provisionedConcurrency and concurrencyAutoscaling. An entry with `maxVCpuCount` instead sizes a
// Lambda Managed Instances function: `min` becomes its FunctionScalingConfig.MinExecutionEnvironments
// and `maxVCpuCount` the MaxVCpuCount of the capacity provider its CapacityProviderConfig
// references (both in `resources`); `maxFloor` does not apply to it.
//
// A Managed Instances function is served through a `live` alias on a numbered version, never
// through $LATEST.PUBLISHED: every republish of $LATEST.PUBLISHED orphans a copy of the previous
// package in the account's code storage, which no API lists or frees. The function is versioned on
// every deploy, each version holds `min` execution environments, and the alias has its own API
// Gateway permission. Events move onto the alias, and PublishToLatestPublished turns off, only once
// the alias already exists in the account: a failed deploy that rolls back deletes resources it
// created but leaves the API Gateway stage on the new deployment, so that deployment may only
// invoke an alias and permission that survive the rollback.

export interface Deploy {
  from?: string
  maxFloor?: number
}

export interface GeneratedConfig {
  target: string
  deploys: Record<string, Deploy | null>
}

export type ConcurrencyBlocks = Record<string, unknown>

export interface ResolvedEntry {
  min: number
  max?: number
  maxVCpuCount?: number
  targetUtilization?: number
  scaleInCooldown?: number
  statistic?: string
  [key: string]: unknown
}

const SETTING_KEYS = [
  'min',
  'max',
  'maxVCpuCount',
  'targetUtilization',
  'scaleInCooldown',
  'statistic',
]

const isBlock = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function validateBlocks(
  name: string,
  concurrency: ConcurrencyBlocks,
  deploys: string[],
): void {
  for (const [key, value] of Object.entries(concurrency)) {
    if (isBlock(value) && !deploys.includes(key)) {
      throw new Error(
        `concurrency of function "${name}" has a block for unknown deploy "${key}"; ` +
          `expected one of ${deploys.join(', ')}`,
      )
    }
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
    if (
      isBlock(value) &&
      Number(value.max ?? 0) > 0 &&
      !Number(value.min ?? 0)
    ) {
      throw new Error(
        `concurrency of function "${name}" sets ${key}.max without a floor; ` +
          'provisioned concurrency cannot scale up from 0, so set min or omit max',
      )
    }
  }
}

export interface Selection {
  target: string
  deploy: Deploy
  deploys: string[]
}

export function selectDeploy(config: GeneratedConfig | undefined): Selection {
  if (
    !isBlock(config) ||
    typeof config.target !== 'string' ||
    !isBlock(config.deploys)
  ) {
    throw new Error(
      'functions declare concurrency, but custom.provisionedConcurrencyAutoscaling needs a target and deploys',
    )
  }
  const deploys = Object.keys(config.deploys)
  if (!deploys.includes(config.target)) {
    throw new Error(
      `deploy "${config.target}" is not in provisionedConcurrencyAutoscaling.deploys (${deploys.join(', ')})`,
    )
  }
  const entry: unknown = config.deploys[config.target] ?? {}
  if (!isBlock(entry)) {
    throw new Error(`deploy "${config.target}" must be a mapping`)
  }
  const deploy = entry as Deploy
  const { from, maxFloor } = deploy
  if (from !== undefined && !deploys.includes(from)) {
    throw new Error(
      `deploy "${config.target}" borrows from unknown deploy "${from}"`,
    )
  }
  if (
    maxFloor !== undefined &&
    !(Number.isInteger(maxFloor) && maxFloor >= 0)
  ) {
    throw new Error(
      `deploy "${config.target}" has maxFloor ${maxFloor}; expected an integer >= 0`,
    )
  }
  return { target: config.target, deploy, deploys }
}

export function resolveEntry(
  name: string,
  concurrency: ConcurrencyBlocks,
  { target, deploy, deploys }: Selection,
): ResolvedEntry {
  validateBlocks(name, concurrency, deploys)
  const shared = Object.fromEntries(
    Object.entries(concurrency).filter(([, value]) => !isBlock(value)),
  )
  const block = (key: string) => {
    const value = concurrency[key]
    return isBlock(value) ? value : {}
  }

  const resolved: Record<string, unknown> = { min: 0, ...shared }
  if (deploy.from !== undefined) {
    Object.assign(resolved, block(deploy.from))
    if (deploy.maxFloor !== undefined && resolved.maxVCpuCount === undefined) {
      resolved.min = Math.min(resolved.min as number, deploy.maxFloor)
    }
  }
  Object.assign(resolved, block(target))
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
        `for ${target}; expected integers with 0 <= min <= max`,
    )
  }
  return resolved as ResolvedEntry
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

// The function-level FunctionScalingConfig governs the frozen $LATEST.PUBLISHED, which keeps
// serving until the deploy that moves a stage's events onto the alias completes. Once every stage
// has made that deploy, set this to true to deactivate $LATEST.PUBLISHED and release its capacity.
const DEACTIVATE_LATEST_PUBLISHED = false

// Functions served by the `live` alias, with the execution environments each version holds.
export type ManagedInstances = Record<string, number>

export const LIVE_ALIAS = 'live'

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
  service.functions[name].versionFunction = true
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
): ManagedInstances {
  const managed: ManagedInstances = {}
  const declared = Object.entries(service.functions ?? {}).filter(
    ([, fn]) => isBlock(fn) && fn.concurrency !== undefined,
  )
  if (declared.length === 0) return managed

  const selection = selectDeploy(
    service.custom?.provisionedConcurrencyAutoscaling,
  )
  for (const [name, fn] of declared) {
    const definition = fn as Record<string, unknown>
    const entry = resolveEntry(
      name,
      definition.concurrency as ConcurrencyBlocks,
      selection,
    )
    delete definition.concurrency
    applyEntry(service, name, entry, lambdaLogicalId)
    if (entry.maxVCpuCount !== undefined) managed[name] = entry.min
  }
  return managed
}

export interface Naming {
  getLambdaLogicalId(functionName: string): string
  getNormalizedFunctionName(functionName: string): string
  getLambdaVersionOutputLogicalId(functionName: string): string
  getLambdaApiGatewayPermissionLogicalId(functionName: string): string
}

const liveAliasLogicalId = (naming: Naming, name: string): string =>
  `${naming.getNormalizedFunctionName(name)}LiveLambdaAlias`

const stableJson = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(stableJson).join(',')}]`
    : isBlock(value)
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value)

// The framework names a version after a digest of the function it compiled, which does not include
// the properties `resources.extensions` lays over the function later (MemorySize and
// CapacityProviderConfig live there). Folding those into the name publishes a new version when
// only they change. FunctionScalingConfig and PublishToLatestPublished are left out: they govern
// $LATEST.PUBLISHED, not versions.
function versionLogicalIdWithExtensions(
  versionLogicalId: string,
  extension: Record<string, unknown> | undefined,
): string {
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    FunctionScalingConfig,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    PublishToLatestPublished,
    ...properties
  } = extension ?? {}
  const digest = createHash('sha256').update(stableJson(properties))
  return `${versionLogicalId}${digest.digest('hex').slice(0, 12)}`
}

// Runs after the framework compiles functions and before it compiles events, which read
// `targetAlias` to point integrations and permissions at the alias and to make them depend on it.
// `routed` names the functions whose alias already exists in the account; only their events move
// onto it and only they stop publishing $LATEST.PUBLISHED, which serves the others' events.
export function aliasManagedInstances(
  service: Service,
  managed: ManagedInstances,
  naming: Naming,
  routed: ReadonlySet<string>,
): void {
  const template = service.provider.compiledCloudFormationTemplate
  for (const [name, min] of Object.entries(managed)) {
    const fn = service.functions[name]
    const functionLogicalId = naming.getLambdaLogicalId(name)
    const version = template.Resources[fn.versionLogicalId]
    if (version?.Type !== 'AWS::Lambda::Version') {
      throw new Error(
        `Managed Instances function "${name}" has no compiled AWS::Lambda::Version to alias`,
      )
    }
    if (fn.targetAlias !== undefined) {
      throw new Error(
        `Managed Instances function "${name}" already targets alias "${fn.targetAlias.name}"; ` +
          'remove provisionedConcurrency, snapStart or durableConfig',
      )
    }

    const versionLogicalId = versionLogicalIdWithExtensions(
      fn.versionLogicalId,
      service.resources?.extensions?.[functionLogicalId]?.Properties,
    )
    delete template.Resources[fn.versionLogicalId]
    template.Resources[versionLogicalId] = version
    fn.versionLogicalId = versionLogicalId
    const output =
      template.Outputs?.[naming.getLambdaVersionOutputLogicalId(name)]
    if (output) output.Value = { Ref: versionLogicalId }

    version.Properties.FunctionScalingConfig = {
      MinExecutionEnvironments: min,
    }
    const aliasLogicalId = liveAliasLogicalId(naming, name)
    template.Resources[aliasLogicalId] = {
      Type: 'AWS::Lambda::Alias',
      Properties: {
        FunctionName: { Ref: functionLogicalId },
        FunctionVersion: { 'Fn::GetAtt': [versionLogicalId, 'Version'] },
        Name: LIVE_ALIAS,
      },
      DependsOn: functionLogicalId,
    }
    if (!routed.has(name)) continue

    const properties =
      service.resources.extensions[functionLogicalId].Properties
    properties.PublishToLatestPublished = false
    if (DEACTIVATE_LATEST_PUBLISHED) {
      properties.FunctionScalingConfig = {
        MinExecutionEnvironments: 0,
        MaxExecutionEnvironments: 0,
      }
    }
    fn.targetAlias = { name: LIVE_ALIAS, logicalId: aliasLogicalId }
  }
}

// Gives each live alias its own API Gateway permission, a copy of the framework's with the alias as
// its target, so it exists before the deploy that routes events to the alias and outlives that
// deploy's rollback. The framework's permission follows targetAlias and is replaced by that deploy.
// Runs after the framework compiles events.
export function permitManagedInstanceAliases(
  service: Service,
  managed: ManagedInstances,
  naming: Naming,
): void {
  const resources = service.provider.compiledCloudFormationTemplate.Resources
  for (const name of Object.keys(managed)) {
    const permission =
      resources[naming.getLambdaApiGatewayPermissionLogicalId(name)]
    if (permission === undefined) continue
    const aliasLogicalId = liveAliasLogicalId(naming, name)
    resources[`${naming.getNormalizedFunctionName(name)}LiveLambdaPermissionApiGateway`] = {
      Type: 'AWS::Lambda::Permission',
      Properties: {
        ...permission.Properties,
        FunctionName: { Ref: aliasLogicalId },
      },
      DependsOn: aliasLogicalId,
    }
  }
}

// The framework makes each http method depend on its function's API Gateway permission, but merging
// a custom authorizer's DependsOn into the method overwrites that entry. Moving a function onto the
// alias replaces the permission, so without the dependency the stage deployment can route requests
// to the alias before API Gateway may invoke it. Runs after the framework compiles events.
export function dependMethodsOnManagedInstancePermissions(
  service: Service,
  managed: ManagedInstances,
  naming: Naming,
): void {
  const resources = service.provider.compiledCloudFormationTemplate.Resources
  for (const name of Object.keys(managed)) {
    const permissionLogicalId =
      naming.getLambdaApiGatewayPermissionLogicalId(name)
    const aliasLogicalId = service.functions[name].targetAlias?.logicalId
    if (resources[permissionLogicalId] === undefined || !aliasLogicalId)
      continue
    for (const resource of Object.values(resources) as Service[]) {
      if (resource.Type !== 'AWS::ApiGateway::Method') continue
      const dependsOn: string[] = [resource.DependsOn ?? []].flat()
      if (
        dependsOn.includes(aliasLogicalId) &&
        !dependsOn.includes(permissionLogicalId)
      ) {
        resource.DependsOn = [...dependsOn, permissionLogicalId]
      }
    }
  }
}
