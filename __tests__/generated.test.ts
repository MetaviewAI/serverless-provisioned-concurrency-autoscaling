/* eslint-disable @typescript-eslint/no-explicit-any */
import Plugin from '../src/plugin'
import {
  aliasManagedInstances,
  dependMethodsOnManagedInstancePermissions,
  permitManagedInstanceAliases,
  applyGeneratedConfig,
  Deploy,
  resolveEntry,
} from '../src/generated'

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

const managedService = (target: string): any =>
  serviceWith(
    target,
    {
      server: {
        handler: 's',
        concurrency: {
          'uk-prod': { min: 3, maxVCpuCount: 400 },
          'uk-alpha': { min: 1, maxVCpuCount: 40 },
        },
      },
      plain: { handler: 'p' },
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

  it('sizes a Managed Instances function and versions it instead of republishing $LATEST.PUBLISHED', () => {
    // Given
    const service = managedService('uk-prod')

    // When
    const managed = applyGeneratedConfig(service, logicalId)

    // Then
    expect(managed).toEqual({ server: 3 })
    expect(service.functions.server).toEqual({
      handler: 's',
      versionFunction: true,
    })
    const { Properties } = service.resources.extensions.ServerLambdaFunction
    expect(Properties.PublishToLatestPublished).toBeUndefined()
    expect(Properties.FunctionScalingConfig).toEqual({
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

const routed = new Set(['server'])

const naming = {
  getLambdaLogicalId: logicalId,
  getNormalizedFunctionName: (name: string) =>
    `${name[0].toUpperCase()}${name.slice(1)}`,
  getLambdaVersionOutputLogicalId: (name: string) =>
    `${logicalId(name)}QualifiedArn`,
  getLambdaApiGatewayPermissionLogicalId: (name: string) =>
    `${naming.getNormalizedFunctionName(name)}LambdaPermissionApiGateway`,
}

// What the framework's package:compileFunctions leaves for a versioned function.
const compileFunctions = (service: any): void => {
  service.provider = {
    ...service.provider,
    compiledCloudFormationTemplate: {
      Resources: {
        ServerLambdaFunction: { Type: 'AWS::Lambda::Function' },
        ServerLambdaVersionAbc: {
          Type: 'AWS::Lambda::Version',
          DeletionPolicy: 'Retain',
          Properties: {
            FunctionName: { Ref: 'ServerLambdaFunction' },
            CodeSha256: 'sha',
          },
        },
        PlainLambdaFunction: { Type: 'AWS::Lambda::Function' },
      },
      Outputs: {
        ServerLambdaFunctionQualifiedArn: {
          Value: { Ref: 'ServerLambdaVersionAbc' },
        },
      },
    },
  }
  service.functions.server.versionLogicalId = 'ServerLambdaVersionAbc'
}

const versionIdAfterAliasing = (target: string, extension: any): string => {
  const service = managedService(target)
  const managed = applyGeneratedConfig(service, logicalId)
  Object.assign(
    service.resources.extensions.ServerLambdaFunction.Properties,
    extension,
  )
  compileFunctions(service)
  aliasManagedInstances(service, managed, naming, routed)
  return service.functions.server.versionLogicalId
}

describe('aliasManagedInstances', () => {
  it('serves a Managed Instances function through a live alias on its new version', () => {
    // Given
    const service = managedService('uk-prod')
    const managed = applyGeneratedConfig(service, logicalId)
    compileFunctions(service)

    // When
    aliasManagedInstances(service, managed, naming, routed)

    // Then
    expect(
      service.resources.extensions.ServerLambdaFunction.Properties
        .PublishToLatestPublished,
    ).toBe(false)
    const { Resources, Outputs } =
      service.provider.compiledCloudFormationTemplate
    const versionId = service.functions.server.versionLogicalId
    expect(versionId).toMatch(/^ServerLambdaVersionAbc[0-9a-f]{12}$/)
    expect(Resources.ServerLambdaVersionAbc).toBeUndefined()
    expect(Resources[versionId]).toEqual({
      Type: 'AWS::Lambda::Version',
      DeletionPolicy: 'Retain',
      Properties: {
        FunctionName: { Ref: 'ServerLambdaFunction' },
        CodeSha256: 'sha',
        FunctionScalingConfig: { MinExecutionEnvironments: 3 },
      },
    })
    expect(Resources.ServerLiveLambdaAlias).toEqual({
      Type: 'AWS::Lambda::Alias',
      Properties: {
        FunctionName: { Ref: 'ServerLambdaFunction' },
        FunctionVersion: { 'Fn::GetAtt': [versionId, 'Version'] },
        Name: 'live',
      },
      DependsOn: 'ServerLambdaFunction',
    })
    expect(Outputs.ServerLambdaFunctionQualifiedArn.Value).toEqual({
      Ref: versionId,
    })
    expect(service.functions.server.targetAlias).toEqual({
      name: 'live',
      logicalId: 'ServerLiveLambdaAlias',
    })
    expect(service.functions.plain.targetAlias).toBeUndefined()
  })

  it('creates the alias but leaves events on $LATEST.PUBLISHED until the alias exists', () => {
    // Given
    const service = managedService('uk-prod')
    const managed = applyGeneratedConfig(service, logicalId)
    compileFunctions(service)

    // When
    aliasManagedInstances(service, managed, naming, new Set())

    // Then
    const { Resources } = service.provider.compiledCloudFormationTemplate
    expect(Resources.ServerLiveLambdaAlias.Properties.FunctionVersion).toEqual({
      'Fn::GetAtt': [service.functions.server.versionLogicalId, 'Version'],
    })
    expect(service.functions.server.targetAlias).toBeUndefined()
    expect(
      service.resources.extensions.ServerLambdaFunction.Properties,
    ).not.toHaveProperty('PublishToLatestPublished')
  })

  it('names the version the same before and after events move onto the alias', () => {
    // Given
    const before = managedService('uk-prod')
    const after = managedService('uk-prod')
    for (const service of [before, after]) compileFunctions(service)

    // When
    aliasManagedInstances(
      before,
      applyGeneratedConfig(before, logicalId),
      naming,
      new Set(),
    )
    aliasManagedInstances(
      after,
      applyGeneratedConfig(after, logicalId),
      naming,
      routed,
    )

    // Then
    expect(after.functions.server.versionLogicalId).toBe(
      before.functions.server.versionLogicalId,
    )
  })

  it('publishes a new version when only the extension properties change', () => {
    // Given / When
    const baseline = versionIdAfterAliasing('uk-prod', {})
    const resized = versionIdAfterAliasing('uk-prod', { MemorySize: 8192 })
    const rescaled = versionIdAfterAliasing('uk-alpha', {})

    // Then
    expect(resized).not.toBe(baseline)
    expect(rescaled).toBe(baseline)
  })

  it('rejects a function it cannot alias', () => {
    // Given
    const unversioned = managedService('uk-prod')
    const unversionedManaged = applyGeneratedConfig(unversioned, logicalId)
    compileFunctions(unversioned)
    delete unversioned.functions.server.versionLogicalId
    const aliased = managedService('uk-prod')
    const aliasedManaged = applyGeneratedConfig(aliased, logicalId)
    compileFunctions(aliased)
    aliased.functions.server.targetAlias = { name: 'snap', logicalId: 'X' }

    // When / Then
    expect(() =>
      aliasManagedInstances(unversioned, unversionedManaged, naming, routed),
    ).toThrow('has no compiled AWS::Lambda::Version')
    expect(() =>
      aliasManagedInstances(aliased, aliasedManaged, naming, routed),
    ).toThrow('already targets alias "snap"')
  })
})

describe('dependMethodsOnManagedInstancePermissions', () => {
  it('makes methods routed to the alias depend on its permission', () => {
    // Given: the framework's DependsOn after an authorizer overwrote the permission entry
    const service = managedService('uk-prod')
    const managed = applyGeneratedConfig(service, logicalId)
    compileFunctions(service)
    aliasManagedInstances(service, managed, naming, routed)
    Object.assign(service.provider.compiledCloudFormationTemplate.Resources, {
      ServerLambdaPermissionApiGateway: { Type: 'AWS::Lambda::Permission' },
      ApiGatewayMethodAny: {
        Type: 'AWS::ApiGateway::Method',
        DependsOn: ['Authorizer', 'ServerLiveLambdaAlias'],
      },
      ApiGatewayMethodPlainGet: {
        Type: 'AWS::ApiGateway::Method',
        DependsOn: ['PlainLambdaPermissionApiGateway'],
      },
    })

    // When
    dependMethodsOnManagedInstancePermissions(service, managed, naming)

    // Then
    const { Resources } = service.provider.compiledCloudFormationTemplate
    expect(Resources.ApiGatewayMethodAny.DependsOn).toEqual([
      'Authorizer',
      'ServerLiveLambdaAlias',
      'ServerLambdaPermissionApiGateway',
    ])
    expect(Resources.ApiGatewayMethodPlainGet.DependsOn).toEqual([
      'PlainLambdaPermissionApiGateway',
    ])
  })
})

describe('permitManagedInstanceAliases', () => {
  it.each([
    ['before events move onto the alias', new Set<string>()],
    ['after events move onto the alias', routed],
  ])(
    'gives the alias and the unqualified function the same permission %s',
    (_, routedFunctions: Set<string>) => {
      // Given
      const service = managedService('uk-prod')
      const managed = applyGeneratedConfig(service, logicalId)
      compileFunctions(service)
      aliasManagedInstances(service, managed, naming, routedFunctions)
      const sourceArn = { 'Fn::Join': ['', ['arn:', 'api', '/*/*']] }
      Object.assign(service.provider.compiledCloudFormationTemplate.Resources, {
        ServerLambdaPermissionApiGateway: {
          Type: 'AWS::Lambda::Permission',
          Properties: {
            FunctionName: { 'Fn::GetAtt': ['ServerLambdaFunction', 'Arn'] },
            Action: 'lambda:InvokeFunction',
            Principal: 'apigateway.amazonaws.com',
            SourceArn: sourceArn,
          },
        },
      })

      // When
      permitManagedInstanceAliases(service, managed, naming)

      // Then
      expect(
        service.provider.compiledCloudFormationTemplate.Resources
          .ServerLiveLambdaPermissionApiGateway,
      ).toEqual({
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: { Ref: 'ServerLiveLambdaAlias' },
          Action: 'lambda:InvokeFunction',
          Principal: 'apigateway.amazonaws.com',
          SourceArn: sourceArn,
        },
        DependsOn: 'ServerLiveLambdaAlias',
      })
      expect(
        service.provider.compiledCloudFormationTemplate.Resources
          .ServerUnqualifiedLambdaPermissionApiGateway,
      ).toEqual({
        Type: 'AWS::Lambda::Permission',
        Properties: {
          FunctionName: { 'Fn::GetAtt': ['ServerLambdaFunction', 'Arn'] },
          Action: 'lambda:InvokeFunction',
          Principal: 'apigateway.amazonaws.com',
          SourceArn: sourceArn,
        },
      })
    },
  )
})

describe('Plugin generated configuration', () => {
  const logging: any = { log: { info: jest.fn() } }
  const serverlessWith = (service: any, request = jest.fn()): any => ({
    service: {
      provider: { name: 'aws' },
      ...service,
      getFunction(name: string) {
        return this.functions[name]
      },
    },
    getProvider: () => ({ naming, request }),
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

  it.each([
    [
      'routes events to an existing alias',
      jest.fn().mockResolvedValue({}),
      'live',
    ],
    [
      'keeps events off an alias the account does not have yet',
      jest.fn().mockRejectedValue({ providerError: { statusCode: 404 } }),
      undefined,
    ],
  ])(
    '%s after the framework compiles functions',
    async (_, request: jest.Mock, targetAlias: string | undefined) => {
      // Given
      const service = managedService('uk-prod')
      service.functions.server.name = 'svc-uk-prod-server'
      const serverless = serverlessWith(service, request)
      const plugin = new Plugin(serverless, {}, logging)
      ;(plugin.hooks.initialize as () => void)()
      compileFunctions(serverless.service)

      // When
      await (
        plugin.hooks['after:package:compileFunctions'] as () => Promise<void>
      )()

      // Then
      expect(request).toHaveBeenCalledWith('Lambda', 'getAlias', {
        FunctionName: 'svc-uk-prod-server',
        Name: 'live',
      })
      expect(serverless.service.functions.server.targetAlias?.name).toBe(
        targetAlias,
      )
    },
  )

  it('fails packaging when it cannot tell whether the alias exists', async () => {
    // Given
    const request = jest.fn().mockRejectedValue(new Error('AccessDenied'))
    const serverless = serverlessWith(managedService('uk-prod'), request)
    const plugin = new Plugin(serverless, {}, logging)
    ;(plugin.hooks.initialize as () => void)()
    compileFunctions(serverless.service)

    // When / Then
    await expect(
      (plugin.hooks['after:package:compileFunctions'] as () => Promise<void>)(),
    ).rejects.toThrow('AccessDenied')
  })
})
