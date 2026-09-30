/* eslint-disable @typescript-eslint/no-explicit-any */
import Plugin from '../src/plugin'
import { applySpec, DeploymentTarget, resolveSpec } from '../src/generated'

const targets: Record<string, DeploymentTarget> = {
  'uk-prod': {
    deploymentTarget: 'uk-prod',
    stage: 'prod',
    deploymentGroup: 'uk',
  },
  'us-prod': {
    deploymentTarget: 'us-prod',
    stage: 'prod',
    deploymentGroup: 'us',
  },
  'uk-alpha': {
    deploymentTarget: 'uk-alpha',
    stage: 'alpha',
    deploymentGroup: 'uk',
  },
  'us-alpha': {
    deploymentTarget: 'us-alpha',
    stage: 'alpha',
    deploymentGroup: 'us',
  },
}

const spec = {
  graphql: {
    targetUtilization: 0.6,
    scaleInCooldown: 2700,
    prod: { min: 120, max: 600, reserved: 800 },
    alpha: { min: 2, max: 25 },
  },
  authorizer: {
    statistic: 'maximum',
    targetUtilization: 0.8,
    prod: { min: 3, max: 150 },
    alpha: { min: 20, max: 25 },
  },
  evaluate: {
    targetUtilization: 0.8,
    prod: { min: 20, max: 600 },
    alpha: { min: 0, max: 0 },
  },
}

const resolve = (target: string, s: any = spec) =>
  resolveSpec({ spec: s, target: targets[target] })

const logicalId = (name: string) =>
  `${name[0].toUpperCase()}${name.slice(1)}LambdaFunction`

describe('resolveSpec', () => {
  it('keeps the prod block on the primary prod target', () => {
    // Given / When
    const resolved = resolve('uk-prod')

    // Then
    expect(resolved.graphql).toEqual({
      targetUtilization: 0.6,
      scaleInCooldown: 2700,
      min: 120,
      max: 600,
      reserved: 800,
    })
  })

  it('gives other prod targets the shared ceiling and the higher of the alpha floor and 1', () => {
    // Given / When
    const resolved = resolve('us-prod')

    // Then
    expect([
      resolved.graphql.min,
      resolved.graphql.max,
      resolved.graphql.reserved,
    ]).toEqual([2, 600, 800])
    expect([resolved.evaluate.min, resolved.evaluate.max]).toEqual([1, 600])
  })

  it('never gives another prod target a warmer floor than the primary', () => {
    // Given
    const dormant = {
      dormant: { prod: { min: 0, max: 10 }, alpha: { min: 5, max: 5 } },
    }

    // When
    const resolved = resolve('us-prod', { ...spec, ...dormant })

    // Then
    expect(resolved.authorizer.min).toBe(3)
    expect(resolved.dormant.min).toBe(0)
  })

  it('follows a configured primary deployment group', () => {
    // Given / When
    const resolved = resolveSpec({
      spec,
      target: targets['us-prod'],
      primaryDeploymentGroup: 'us',
    })

    // Then
    expect(resolved.graphql.min).toBe(120)
  })

  it('shares the alpha block across alpha targets', () => {
    // Given / When
    const uk = resolve('uk-alpha')
    const us = resolve('us-alpha')

    // Then
    expect(uk).toEqual(us)
    expect([
      uk.graphql.min,
      uk.graphql.max,
      uk.graphql.targetUtilization,
    ]).toEqual([2, 25, 0.6])
  })

  it('applies a deployment-target override to that target only', () => {
    // Given
    const withOverride = {
      graphql: {
        ...spec.graphql,
        'us-prod': { min: 50, targetUtilization: 0.7 },
      },
    }

    // When
    const us = resolve('us-prod', withOverride)
    const uk = resolve('uk-prod', withOverride)

    // Then
    expect([
      us.graphql.min,
      us.graphql.max,
      us.graphql.targetUtilization,
    ]).toEqual([50, 600, 0.7])
    expect(uk.graphql.min).toBe(120)
    expect(uk.graphql['us-prod']).toBeUndefined()
  })

  it('rejects specs that cannot resolve', () => {
    // Given
    const missingStage = { graphql: { prod: { min: 1, max: 2 } } }
    const floorAboveCeiling = {
      graphql: { ...spec.graphql, 'us-prod': { min: 700 } },
    }

    // When / Then
    expect(() => resolve('us-alpha', missingStage)).toThrow('no "alpha" block')
    expect(() => resolve('us-prod', floorAboveCeiling)).toThrow(
      'min 700 / max 600 for us-prod',
    )
    expect(() =>
      resolveSpec({ spec, target: { stage: 'prod' } as any }),
    ).toThrow('needs a "deploymentTarget"')
  })
})

describe('applySpec', () => {
  it('sets provisioned concurrency, the autoscaling block and reserved concurrency', () => {
    // Given
    const service: any = {
      functions: {
        graphql: { handler: 'g' },
        authorizer: { handler: 'a' },
        evaluate: {},
      },
    }

    // When
    applySpec(service, resolve('us-prod'), logicalId)

    // Then
    expect(service.functions.graphql).toEqual({
      handler: 'g',
      provisionedConcurrency: 2,
      reservedConcurrency: 800,
      concurrencyAutoscaling: {
        enabled: true,
        minimum: 2,
        maximum: 600,
        usage: 0.6,
        scaleInCooldown: 2700,
        customMetric: { statistic: 'average' },
      },
    })
    expect(service.functions.authorizer.concurrencyAutoscaling).toEqual({
      enabled: true,
      minimum: 3,
      maximum: 150,
      usage: 0.8,
      customMetric: { statistic: 'maximum' },
    })
  })

  it('sizes a Managed Instances function and its capacity provider', () => {
    // Given
    const service: any = {
      functions: { server: { handler: 's' } },
      resources: {
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
    }
    const managed = {
      server: {
        prod: { min: 3, maxVCpuCount: 400 },
        alpha: { min: 3, maxVCpuCount: 40 },
      },
    }

    // When
    applySpec(service, resolve('us-prod', managed), logicalId)

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

  it('rejects entries it cannot apply unambiguously', () => {
    // Given
    const unmatched: any = { functions: {} }
    const alreadyConfigured: any = {
      functions: { evaluate: { provisionedConcurrency: 5 } },
    }
    const notManaged: any = {
      functions: { server: {} },
      resources: { Resources: {}, extensions: {} },
    }
    const managed = {
      server: {
        prod: { min: 3, maxVCpuCount: 40 },
        alpha: { min: 3, maxVCpuCount: 40 },
      },
    }

    // When / Then
    expect(() =>
      applySpec(
        unmatched,
        resolve('uk-prod', { evaluate: spec.evaluate }),
        logicalId,
      ),
    ).toThrow('matches no function')
    expect(() =>
      applySpec(
        alreadyConfigured,
        resolve('uk-prod', { evaluate: spec.evaluate }),
        logicalId,
      ),
    ).toThrow('sets provisionedConcurrency')
    expect(() =>
      applySpec(notManaged, resolve('uk-prod', managed), logicalId),
    ).toThrow('does not reference an AWS::Lambda::CapacityProvider')
  })
})

describe('Plugin generated configuration', () => {
  const logging: any = { log: { info: jest.fn() } }
  const serverlessWith = (custom: any, functions: any): any => ({
    service: { provider: { name: 'aws' }, custom, functions },
    getProvider: () => ({ naming: { getLambdaLogicalId: logicalId } }),
    configSchemaHandler: { defineFunctionProperties: jest.fn() },
  })

  it('applies the spec on initialize, before the framework compiles functions', () => {
    // Given
    const serverless = serverlessWith(
      {
        provisionedConcurrencyAutoscaling: {
          spec: { evaluate: spec.evaluate },
          target: targets['uk-prod'],
        },
      },
      { evaluate: {} },
    )
    const plugin = new Plugin(serverless, {}, logging)

    // When
    ;(plugin.hooks.initialize as () => void)()

    // Then
    expect(serverless.service.functions.evaluate.provisionedConcurrency).toBe(
      20,
    )
    expect(
      serverless.service.functions.evaluate.concurrencyAutoscaling.maximum,
    ).toBe(600)
  })

  it('leaves services without generated configuration untouched', () => {
    // Given
    const serverless = serverlessWith(
      {},
      { evaluate: { provisionedConcurrency: 1 } },
    )
    const plugin = new Plugin(serverless, {}, logging)

    // When
    ;(plugin.hooks.initialize as () => void)()

    // Then
    expect(serverless.service.functions.evaluate).toEqual({
      provisionedConcurrency: 1,
    })
  })
})
