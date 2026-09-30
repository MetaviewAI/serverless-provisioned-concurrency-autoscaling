"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applySpec = exports.scalingFor = exports.resolveSpec = exports.resolveEntry = void 0;
const STAGE_KEYS = ['prod', 'alpha'];
const DEFAULT_PRIMARY_DEPLOYMENT_GROUP = 'uk';
const isBlock = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function resolveEntry(name, entry, target, primaryDeploymentGroup = DEFAULT_PRIMARY_DEPLOYMENT_GROUP) {
    const shared = Object.fromEntries(Object.entries(entry).filter(([, value]) => !isBlock(value)));
    const stageBlock = entry[target.stage];
    if (!isBlock(stageBlock)) {
        throw new Error(`provisioned concurrency entry "${name}" has no "${target.stage}" block`);
    }
    const resolved = Object.assign(Object.assign({}, shared), stageBlock);
    if (target.stage === 'prod' &&
        target.deploymentGroup !== primaryDeploymentGroup) {
        const alpha = entry.alpha;
        const alphaMin = isBlock(alpha) && typeof alpha.min === 'number' ? alpha.min : 0;
        resolved.min = Math.min(stageBlock.min, Math.max(alphaMin, 1));
    }
    const override = entry[target.deploymentTarget];
    if (isBlock(override)) {
        Object.assign(resolved, override);
    }
    const { min, max, maxVCpuCount } = resolved;
    const validMin = Number.isInteger(min) && min >= 0;
    const validMax = max === undefined
        ? Number.isInteger(maxVCpuCount)
        : Number.isInteger(max) && max >= min;
    if (!validMin || !validMax) {
        throw new Error(`provisioned concurrency entry "${name}" resolves to min ${min} / max ${max !== null && max !== void 0 ? max : maxVCpuCount} ` +
            `for ${target.deploymentTarget}; expected integers with 0 <= min <= max`);
    }
    return resolved;
}
exports.resolveEntry = resolveEntry;
function resolveSpec(config) {
    const { spec, target, primaryDeploymentGroup } = config;
    for (const key of ['deploymentTarget', 'stage', 'deploymentGroup']) {
        if (typeof (target === null || target === void 0 ? void 0 : target[key]) !== 'string') {
            throw new Error(`provisionedConcurrencyAutoscaling.target needs a "${key}"`);
        }
    }
    if (!STAGE_KEYS.includes(target.stage)) {
        throw new Error(`unsupported stage "${target.stage}"; expected one of ${STAGE_KEYS.join(', ')}`);
    }
    return Object.fromEntries(Object.entries(spec !== null && spec !== void 0 ? spec : {}).map(([name, entry]) => [
        name,
        resolveEntry(name, entry, target, primaryDeploymentGroup),
    ]));
}
exports.resolveSpec = resolveSpec;
function scalingFor(entry) {
    const { min, max, targetUtilization, scaleInCooldown, statistic } = entry;
    return Object.assign(Object.assign(Object.assign({ enabled: true, minimum: min, maximum: max }, (targetUtilization !== undefined && { usage: targetUtilization })), (scaleInCooldown !== undefined && { scaleInCooldown })), { customMetric: { statistic: statistic !== null && statistic !== void 0 ? statistic : 'average' } });
}
exports.scalingFor = scalingFor;
function capacityProviderLogicalId(arn) {
    const getAtt = isBlock(arn) ? arn['Fn::GetAtt'] : undefined;
    if (Array.isArray(getAtt))
        return getAtt[0];
    if (typeof getAtt === 'string')
        return getAtt.split('.')[0];
    return undefined;
}
function applyManagedInstances(service, name, logicalId, entry) {
    var _a, _b, _c, _d, _e;
    const resources = (_a = service.resources) !== null && _a !== void 0 ? _a : {};
    const functionResource = (_b = resources.extensions) === null || _b === void 0 ? void 0 : _b[logicalId];
    const providerConfig = (_d = (_c = functionResource === null || functionResource === void 0 ? void 0 : functionResource.Properties) === null || _c === void 0 ? void 0 : _c.CapacityProviderConfig) === null || _d === void 0 ? void 0 : _d.LambdaManagedInstancesCapacityProviderConfig;
    const providerId = capacityProviderLogicalId(providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.CapacityProviderArn);
    const provider = providerId ? (_e = resources.Resources) === null || _e === void 0 ? void 0 : _e[providerId] : undefined;
    if ((provider === null || provider === void 0 ? void 0 : provider.Type) !== 'AWS::Lambda::CapacityProvider') {
        throw new Error(`provisioned concurrency entry "${name}" sets maxVCpuCount, but resources.extensions.${logicalId} ` +
            'does not reference an AWS::Lambda::CapacityProvider in resources.Resources');
    }
    functionResource.Properties.FunctionScalingConfig = Object.assign(Object.assign({}, functionResource.Properties.FunctionScalingConfig), { MinExecutionEnvironments: entry.min });
    provider.Properties.CapacityProviderScalingConfig = Object.assign(Object.assign({}, provider.Properties.CapacityProviderScalingConfig), { MaxVCpuCount: entry.maxVCpuCount });
}
function applySpec(service, resolved, lambdaLogicalId) {
    var _a;
    for (const [name, entry] of Object.entries(resolved)) {
        const fn = (_a = service.functions) === null || _a === void 0 ? void 0 : _a[name];
        if (!fn) {
            throw new Error(`provisioned concurrency entry "${name}" matches no function`);
        }
        if (entry.maxVCpuCount !== undefined) {
            applyManagedInstances(service, name, lambdaLogicalId(name), entry);
            continue;
        }
        const owned = ['provisionedConcurrency', 'concurrencyAutoscaling'];
        if (entry.reserved !== undefined)
            owned.push('reservedConcurrency');
        for (const key of owned) {
            if (fn[key] !== undefined) {
                throw new Error(`function "${name}" sets ${key} and has a provisioned concurrency entry; remove one`);
            }
        }
        fn.provisionedConcurrency = entry.min;
        fn.concurrencyAutoscaling = scalingFor(entry);
        if (entry.reserved !== undefined) {
            fn.reservedConcurrency = entry.reserved;
        }
    }
}
exports.applySpec = applySpec;
//# sourceMappingURL=generated.js.map