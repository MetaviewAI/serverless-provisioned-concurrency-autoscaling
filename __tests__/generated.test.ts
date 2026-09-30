/* eslint-disable @typescript-eslint/no-explicit-any */
import Plugin from '../src/plugin'
import {
  applyGeneratedConfig,
  DeploymentTarget,
  resolveEntry,
} from '../src/generated'

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

const graphql = {
  targetUtilization: 0.6,
  scaleInCooldown: 2700,
  prod: { min: 120, max: 600 },
  alpha: { min: 2, max: 25 },
}
const authorizer = {
  statistic: 'maximum',
  targetUtilization: 0.8,
  prod: { min: 3, max: 150 },
  alpha: { min: 20, max: 25 },
}
const evaluate = {
  targetUtilization: 0.8,
  prod: { min: 20, max: 600 },
}

const logicalId = (name: string) =>
  `${name[0].toUpperCase()}${name.slice(1)}LambdaFunction`

const serviceWith = (target: string, functions: any, resources?: any): any => ({
  custom: { provisionedConcurrencyAutoscaling: { target: targets[target] } },
  functions,
  resources,
})

describe('resolveEntry', () => {
  it('keeps the prod block on the primary prod target', () => {
    // Given / When
    const resolved = resolveEntry('graphql', graphql, targets['uk-prod'])

    // Then
    expect(resolved).toEqual({
      targetUtilization: 0.6,
      scaleInCooldown: 2700,
      min: 120,
      max: 600,
    })
  })

  it('gives other prod targets the shared ceiling and the higher of the alpha floor and 1', () => {
    // Given / When
    const withAlphaFloor = resolveEntry('graphql', graphql, targets['us-prod'])
    const withoutAlphaFloor = resolveEntry(
      'evaluate',
      evaluate,
      targets['us-prod'],
    )

    // Then
    expect([withAlphaFloor.min, withAlphaFloor.max]).toEqual([2, 600])
    expect([withoutAlphaFloor.min, withoutAlphaFloor.max]).toEqual([1, 600])
  })

  it('never gives another prod target a warmer floor than the primary', () => {
    // Given
    const dormant = { prod: {}, alpha: { min: 5, max: 5 } }

    // When / Then
    expect(resolveEntry('authorizer', authorizer, targets['us-prod']).min).toBe(
      3,
    )
    expect(resolveEntry('dormant', dormant, targets['us-prod']).min).toBe(0)
  })

  it('follows a configured primary deployment group', () => {
    // Given / When
    const resolved = resolveEntry('graphql', graphql, targets['us-prod'], 'us')

    // Then
    expect(resolved.min).toBe(120)
  })

  it('shares the alpha block across alpha targets', () => {
    // Given / When
    const uk = resolveEntry('graphql', graphql, targets['uk-alpha'])
    const us = resolveEntry('graphql', graphql, targets['us-alpha'])

    // Then
    expect(uk).toEqual(us)
    expect([uk.min, uk.max, uk.targetUtilization]).toEqual([2, 25, 0.6])
  })

  it('applies a deployment-target override to that target only', () => {
    // Given
    const withOverride = {
      ...graphql,
      'us-prod': { min: 50, targetUtilization: 0.7 },
    }

    // When
    const us = resolveEntry('graphql', withOverride, targets['us-prod'])
    const uk = resolveEntry('graphql', withOverride, targets['uk-prod'])

    // Then
    expect([us.min, us.max, us.targetUtilization]).toEqual([50, 600, 0.7])
    expect(uk.min).toBe(120)
    expect(uk['us-prod']).toBeUndefined()
  })

  it('treats a missing stage block, floor or ceiling as 0', () => {
    // Given
    const prodOnly = { prod: { min: 1, max: 2 } }
    const settingsOnly = {
      prod: { min: 1, max: 2 },
      alpha: { targetUtilization: 0.5 },
    }
    const regionOff = { ...graphql, 'us-prod': { min: 0 } }

    // When / Then
    expect(resolveEntry('fn', prodOnly, targets['us-alpha'])).toEqual({
      min: 0,
      max: 0,
    })
    expect(resolveEntry('fn', settingsOnly, targets['uk-alpha'])).toEqual({
      min: 0,
      max: 0,
      targetUtilization: 0.5,
    })
    expect(resolveEntry('fn', prodOnly, targets['us-prod']).min).toBe(1)
    expect(resolveEntry('graphql', regionOff, targets['us-prod']).min).toBe(0)
  })

  it('rejects entries that cannot resolve or could never take effect', () => {
    // Given
    const floorAboveCeiling = { ...graphql, 'us-prod': { min: 700 } }
    const ceilingWithoutFloor = {
      prod: { min: 1, max: 2 },
      alpha: { min: 0, max: 10 },
    }
    const fractional = { prod: { min: 1.5, max: 2 } }
    const unknownSetting = { prod: { min: 1, max: 2, reserved: 500 } }

    // When / Then
    expect(() =>
      resolveEntry('graphql', floorAboveCeiling, targets['us-prod']),
    ).toThrow('min 700 / max 600 for us-prod')
    expect(() =>
      resolveEntry('fn', ceilingWithoutFloor, targets['uk-prod']),
    ).toThrow('alpha.max without a floor')
    expect(() => resolveEntry('fn', fractional, targets['uk-prod'])).toThrow(
      'expected integers',
    )
    expect(() =>
      resolveEntry('fn', unknownSetting, targets['uk-prod']),
    ).toThrow('unknown setting reserved')
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
      provisionedConcurrency: 2,
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
    expect(service.functions.plain).toEqual({ handler: 'p' })
  })

  it('gives a function no warm pool on a target where its floor is 0', () => {
    // Given
    const service = serviceWith('uk-alpha', {
      evaluate: { handler: 'e', concurrency: evaluate },
      stream: {
        handler: 's',
        reservedConcurrency: 10,
        concurrency: { prod: { min: 120, max: 200 } },
      },
    })

    // When
    applyGeneratedConfig(service, logicalId)

    // Then
    expect(service.functions.evaluate).toEqual({ handler: 'e' })
    expect(service.functions.stream).toEqual({
      handler: 's',
      reservedConcurrency: 10,
    })
  })

  it('sizes a Managed Instances function and its capacity provider', () => {
    // Given
    const service = serviceWith(
      'us-prod',
      {
        server: {
          handler: 's',
          concurrency: {
            prod: { min: 3, maxVCpuCount: 400 },
            alpha: { min: 3, maxVCpuCount: 40 },
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

  it('rejects configuration it cannot apply unambiguously', () => {
    // Given
    const noTarget: any = {
      custom: {},
      functions: { evaluate: { concurrency: evaluate } },
    }
    const badTarget: any = {
      custom: {
        provisionedConcurrencyAutoscaling: { target: { stage: 'prod' } },
      },
      functions: { evaluate: { concurrency: evaluate } },
    }
    const alsoConfigured = serviceWith('uk-prod', {
      evaluate: { provisionedConcurrency: 5, concurrency: evaluate },
    })
    const notManaged = serviceWith(
      'uk-prod',
      {
        server: {
          concurrency: {
            prod: { min: 3, maxVCpuCount: 40 },
            alpha: { min: 3, maxVCpuCount: 40 },
          },
        },
      },
      { Resources: {}, extensions: {} },
    )

    // When / Then
    expect(() => applyGeneratedConfig(noTarget, logicalId)).toThrow(
      'target is not set',
    )
    expect(() => applyGeneratedConfig(badTarget, logicalId)).toThrow(
      'needs a "deploymentTarget"',
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
      serviceWith('uk-prod', { evaluate: { concurrency: evaluate } }),
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

  it('leaves services without function concurrency untouched', () => {
    // Given
    const serverless = serverlessWith({
      custom: {},
      functions: { evaluate: { provisionedConcurrency: 1 } },
    })
    const plugin = new Plugin(serverless, {}, logging)

    // When
    ;(plugin.hooks.initialize as () => void)()

    // Then
    expect(serverless.service.functions.evaluate).toEqual({
      provisionedConcurrency: 1,
    })
  })
})
