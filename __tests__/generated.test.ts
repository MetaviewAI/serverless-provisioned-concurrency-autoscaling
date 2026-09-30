/* eslint-disable @typescript-eslint/no-explicit-any */
import Plugin from '../src/plugin'
import { applyGeneratedConfig, Deploy, resolveEntry } from '../src/generated'

const deploys: Record<string, Deploy> = {
  'uk-prod': {},
  'uk-alpha': {},
  'us-prod': { from: 'uk-prod', maxFloor: 1 },
  'us-alpha': { from: 'uk-alpha' },
}

const graphql = {
  targetUtilization: 0.6,
  scaleInCooldown: 2700,
  'uk-prod': { min: 120, max: 600 },
  'uk-alpha': { min: 2, max: 25 },
}
const authorizer = {
  statistic: 'maximum',
  targetUtilization: 0.8,
  'uk-prod': { min: 3, max: 150 },
}

const resolve = (concurrency: any, target: string) =>
  resolveEntry('fn', concurrency, {
    target,
    deploy: deploys[target] ?? {},
    deploys: Object.keys(deploys),
  })

const logicalId = (name: string) =>
  `${name[0].toUpperCase()}${name.slice(1)}LambdaFunction`

const serviceWith = (target: string, functions: any, resources?: any): any => ({
  custom: { provisionedConcurrencyAutoscaling: { target, deploys } },
  functions,
  resources,
})

describe('resolveEntry', () => {
  it('reads the block named after the target, with the shared settings', () => {
    // Given / When
    const resolved = resolve(graphql, 'uk-prod')

    // Then
    expect(resolved).toEqual({
      targetUtilization: 0.6,
      scaleInCooldown: 2700,
      min: 120,
      max: 600,
    })
  })

  it('borrows the fallback block with its floor capped at maxFloor', () => {
    // Given / When
    const resolved = resolve(graphql, 'us-prod')

    // Then
    expect([resolved.min, resolved.max, resolved.targetUtilization]).toEqual([
      1, 600, 0.6,
    ])
  })

  it('never raises a floor to maxFloor', () => {
    // Given / When / Then
    expect(resolve({ 'uk-prod': { min: 0 } }, 'us-prod').min).toBe(0)
  })

  it("lays the target's own block over the borrowed one", () => {
    // Given
    const withOwn = {
      ...graphql,
      'us-prod': { min: 50, targetUtilization: 0.7 },
    }

    // When
    const us = resolve(withOwn, 'us-prod')
    const uk = resolve(withOwn, 'uk-prod')

    // Then
    expect([us.min, us.max, us.targetUtilization]).toEqual([50, 600, 0.7])
    expect(uk.min).toBe(120)
    expect(uk['us-prod']).toBeUndefined()
  })

  it('borrows a block unchanged when the fallback has no maxFloor', () => {
    // Given / When
    const uk = resolve(graphql, 'uk-alpha')
    const us = resolve(graphql, 'us-alpha')

    // Then
    expect(us).toEqual(uk)
    expect([us.min, us.max]).toEqual([2, 25])
  })

  it('treats a missing block, floor or ceiling as 0', () => {
    // Given
    const settingsOnly = {
      'uk-prod': { min: 1, max: 2 },
      'uk-alpha': { targetUtilization: 0.5 },
    }

    // When / Then
    expect(resolve(authorizer, 'uk-alpha')).toEqual({
      statistic: 'maximum',
      targetUtilization: 0.8,
      min: 0,
      max: 0,
    })
    expect(resolve(settingsOnly, 'uk-alpha')).toEqual({
      min: 0,
      max: 0,
      targetUtilization: 0.5,
    })
  })

  it('rejects entries that cannot resolve or could never take effect', () => {
    // Given
    const floorAboveCeiling = { ...graphql, 'us-prod': { min: 700 } }
    const ceilingWithoutFloor = {
      'uk-prod': { min: 1, max: 2 },
      'uk-alpha': { min: 0, max: 10 },
    }
    const fractional = { 'uk-prod': { min: 1.5, max: 2 } }
    const unknownSetting = { 'uk-prod': { min: 1, max: 2, reserved: 500 } }
    const typo = { 'uk-prd': { min: 3, max: 500 } }

    // When / Then
    expect(() => resolve(floorAboveCeiling, 'us-prod')).toThrow(
      'min 700 / max 600 for us-prod',
    )
    expect(() => resolve(ceilingWithoutFloor, 'uk-prod')).toThrow(
      'uk-alpha.max without a floor',
    )
    expect(() => resolve(fractional, 'uk-prod')).toThrow('expected integers')
    expect(() => resolve(typo, 'uk-prod')).toThrow('unknown deploy "uk-prd"')
    expect(() => resolve(unknownSetting, 'uk-prod')).toThrow(
      'unknown setting reserved',
    )
  })
})

describe('applyGeneratedConfig', () => {
  it('replaces each function concurrency block with provisioned concurrency and autoscaling', () => {
    // Given
    const service = serviceWith('us-prod', {
      graphql: { handler: 'g', concurrency: graphql },
      authorizer: { handler: 'a', concurrency: authorizer },
      plain: { handler: 'p' },
    })

    // When
    applyGeneratedConfig(service, logicalId)

    // Then
    expect(service.functions.graphql).toEqual({
      handler: 'g',
      provisionedConcurrency: 1,
      concurrencyAutoscaling: {
        enabled: true,
        minimum: 1,
        maximum: 600,
        usage: 0.6,
        scaleInCooldown: 2700,
        customMetric: { statistic: 'average' },
      },
    })
    expect(service.functions.authorizer.concurrencyAutoscaling).toEqual({
      enabled: true,
      minimum: 1,
      maximum: 150,
      usage: 0.8,
      customMetric: { statistic: 'maximum' },
    })
    expect(service.functions.plain).toEqual({ handler: 'p' })
  })

  it('gives a function no warm pool when its floor is 0', () => {
    // Given
    const service = serviceWith('uk-alpha', {
      authorizer: { handler: 'a', concurrency: authorizer },
      stream: {
        handler: 's',
        reservedConcurrency: 10,
        concurrency: { 'uk-prod': { min: 120, max: 200 } },
      },
    })

    // When
    applyGeneratedConfig(service, logicalId)

    // Then
    expect(service.functions.authorizer).toEqual({ handler: 'a' })
    expect(service.functions.stream).toEqual({
      handler: 's',
      reservedConcurrency: 10,
    })
  })

  it('sizes a Managed Instances function and its capacity provider', () => {
    // Given
    const service = serviceWith(
      'uk-prod',
      {
        server: {
          handler: 's',
          concurrency: {
            'uk-prod': { min: 3, maxVCpuCount: 400 },
            'uk-alpha': { min: 3, maxVCpuCount: 40 },
          },
        },
      },
      {
        Resources: {
          ServerProvider: {
            Type: 'AWS::Lambda::CapacityProvider',
            Properties: {
              CapacityProviderScalingConfig: { ScalingMode: 'Auto' },
            },
          },
        },
        extensions: {
          ServerLambdaFunction: {
            Properties: {
              MemorySize: 4096,
              CapacityProviderConfig: {
                LambdaManagedInstancesCapacityProviderConfig: {
                  CapacityProviderArn: {
                    'Fn::GetAtt': ['ServerProvider', 'Arn'],
                  },
                },
              },
            },
          },
        },
      },
    )

    // When
    applyGeneratedConfig(service, logicalId)

    // Then
    expect(service.functions.server).toEqual({ handler: 's' })
    expect(
      service.resources.extensions.ServerLambdaFunction.Properties
        .FunctionScalingConfig,
    ).toEqual({
      MinExecutionEnvironments: 3,
    })
    expect(
      service.resources.Resources.ServerProvider.Properties
        .CapacityProviderScalingConfig,
    ).toEqual({
      ScalingMode: 'Auto',
      MaxVCpuCount: 400,
    })
  })

  it('does not cap a Managed Instances floor with maxFloor', () => {
    // Given / When
    const resolved = resolve(
      { 'uk-prod': { min: 3, maxVCpuCount: 400 } },
      'us-prod',
    )

    // Then
    expect(resolved).toEqual({ min: 3, maxVCpuCount: 400 })
  })

  it('rejects configuration it cannot apply unambiguously', () => {
    // Given
    const noTarget: any = {
      custom: {},
      functions: { authorizer: { concurrency: authorizer } },
    }
    const unknownTarget = serviceWith('eu-prod', {
      authorizer: { concurrency: authorizer },
    })
    const unknownSource: any = {
      custom: {
        provisionedConcurrencyAutoscaling: {
          target: 'us-prod',
          deploys: { 'uk-prod': {}, 'us-prod': { from: 'uk-prd' } },
        },
      },
      functions: { authorizer: { concurrency: authorizer } },
    }
    const alsoConfigured = serviceWith('uk-prod', {
      authorizer: { provisionedConcurrency: 5, concurrency: authorizer },
    })
    const notManaged = serviceWith(
      'uk-prod',
      { server: { concurrency: { 'uk-prod': { min: 3, maxVCpuCount: 40 } } } },
      { Resources: {}, extensions: {} },
    )

    // When / Then
    expect(() => applyGeneratedConfig(noTarget, logicalId)).toThrow(
      'needs a target and deploys',
    )
    expect(() => applyGeneratedConfig(unknownTarget, logicalId)).toThrow(
      'deploy "eu-prod" is not in provisionedConcurrencyAutoscaling.deploys',
    )
    expect(() => applyGeneratedConfig(unknownSource, logicalId)).toThrow(
      'borrows from unknown deploy "uk-prd"',
    )
    expect(() => applyGeneratedConfig(alsoConfigured, logicalId)).toThrow(
      'sets both provisionedConcurrency and concurrency',
    )
    expect(() => applyGeneratedConfig(notManaged, logicalId)).toThrow(
      'does not reference an AWS::Lambda::CapacityProvider',
    )
  })
})

describe('Plugin generated configuration', () => {
  const logging: any = { log: { info: jest.fn() } }
  const serverlessWith = (service: any): any => ({
    service: { provider: { name: 'aws' }, ...service },
    getProvider: () => ({ naming: { getLambdaLogicalId: logicalId } }),
    configSchemaHandler: { defineFunctionProperties: jest.fn() },
  })

  it('applies function concurrency on initialize, before the framework compiles functions', () => {
    // Given
    const serverless = serverlessWith(
      serviceWith('uk-prod', { graphql: { concurrency: graphql } }),
    )
    const plugin = new Plugin(serverless, {}, logging)

    // When
    ;(plugin.hooks.initialize as () => void)()

    // Then
    expect(serverless.service.functions.graphql.provisionedConcurrency).toBe(
      120,
    )
    expect(
      serverless.service.functions.graphql.concurrencyAutoscaling.maximum,
    ).toBe(600)
  })

  it('leaves services without function concurrency untouched', () => {
    // Given
    const serverless = serverlessWith({
      custom: {},
      functions: { graphql: { provisionedConcurrency: 1 } },
    })
    const plugin = new Plugin(serverless, {}, logging)

    // When
    ;(plugin.hooks.initialize as () => void)()

    // Then
    expect(serverless.service.functions.graphql).toEqual({
      provisionedConcurrency: 1,
    })
  })
})
