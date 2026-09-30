"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyGeneratedConfig = exports.applyEntry = exports.scalingFor = exports.validateTarget = exports.resolveEntry = void 0;
const STAGE_KEYS = ['prod', 'alpha'];
const SETTING_KEYS = [
    'min',
    'max',
    'maxVCpuCount',
    'targetUtilization',
    'scaleInCooldown',
    'statistic',
];
const DEFAULT_PRIMARY_DEPLOYMENT_GROUP = 'uk';
const isBlock = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function resolveEntry(name, entry, target, primaryDeploymentGroup = DEFAULT_PRIMARY_DEPLOYMENT_GROUP) {
    var _a, _b;
    const shared = Object.fromEntries(Object.entries(entry).filter(([, value]) => !isBlock(value)));
    for (const [key, value] of Object.entries(entry)) {
        const settings = isBlock(value) ? Object.keys(value) : [key];
        const unknown = settings.filter((setting) => !SETTING_KEYS.includes(setting));
        if (unknown.length > 0) {
            throw new Error(`concurrency of function "${name}" has unknown setting ${unknown.join(', ')}; ` +
                `expected ${SETTING_KEYS.join(', ')}`);
        }
    }
    for (const stage of STAGE_KEYS) {
        const written = entry[stage];
        if (isBlock(written) &&
            Number((_a = written.max) !== null && _a !== void 0 ? _a : 0) > 0 &&
            !Number((_b = written.min) !== null && _b !== void 0 ? _b : 0)) {
            throw new Error(`concurrency of function "${name}" sets ${stage}.max without a floor; ` +
                'provisioned concurrency cannot scale up from 0, so set min or omit max');
        }
    }
    const block = entry[target.stage];
    const stageBlock = isBlock(block) ? block : {};
    const resolved = Object.assign(Object.assign({ min: 0 }, shared), stageBlock);
    if (target.stage === 'prod' &&
        target.deploymentGroup !== primaryDeploymentGroup) {
        const alpha = entry.alpha;
        const alphaMin = isBlock(alpha) && typeof alpha.min === 'number' ? alpha.min : 0;
        resolved.min = Math.min(resolved.min, Math.max(alphaMin, 1));
    }
    const override = entry[target.deploymentTarget];
    if (isBlock(override)) {
        Object.assign(resolved, override);
    }
    if (resolved.max === undefined && resolved.maxVCpuCount === undefined) {
        resolved.max = 0;
    }
    const { min, max, maxVCpuCount } = resolved;
    const validMin = Number.isInteger(min) && min >= 0;
    const validMax = max === undefined
        ? Number.isInteger(maxVCpuCount)
        : Number.isInteger(max) && max >= min;
    if (!validMin || !validMax) {
        throw new Error(`concurrency of function "${name}" resolves to min ${min} / max ${max !== null && max !== void 0 ? max : maxVCpuCount} ` +
            `for ${target.deploymentTarget}; expected integers with 0 <= min <= max`);
    }
    return resolved;
}
exports.resolveEntry = resolveEntry;
function validateTarget(target) {
    for (const key of ['deploymentTarget', 'stage', 'deploymentGroup']) {
        if (typeof (target === null || target === void 0 ? void 0 : target[key]) !== 'string') {
            throw new Error(`provisionedConcurrencyAutoscaling.target needs a "${key}"`);
        }
    }
    if (!STAGE_KEYS.includes(target.stage)) {
        throw new Error(`unsupported stage "${target.stage}"; expected one of ${STAGE_KEYS.join(', ')}`);
    }
}
exports.validateTarget = validateTarget;
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
        throw new Error(`concurrency of function "${name}" sets maxVCpuCount, but resources.extensions.${logicalId} ` +
            'does not reference an AWS::Lambda::CapacityProvider in resources.Resources');
    }
    functionResource.Properties.FunctionScalingConfig = Object.assign(Object.assign({}, functionResource.Properties.FunctionScalingConfig), { MinExecutionEnvironments: entry.min });
    provider.Properties.CapacityProviderScalingConfig = Object.assign(Object.assign({}, provider.Properties.CapacityProviderScalingConfig), { MaxVCpuCount: entry.maxVCpuCount });
}
function applyEntry(service, name, entry, lambdaLogicalId) {
    if (entry.maxVCpuCount !== undefined) {
        applyManagedInstances(service, name, lambdaLogicalId(name), entry);
        return;
    }
    const fn = service.functions[name];
    for (const key of ['provisionedConcurrency', 'concurrencyAutoscaling']) {
        if (fn[key] !== undefined) {
            throw new Error(`function "${name}" sets both ${key} and concurrency; remove one`);
        }
    }
    if (entry.min > 0) {
        fn.provisionedConcurrency = entry.min;
        fn.concurrencyAutoscaling = scalingFor(entry);
    }
}
exports.applyEntry = applyEntry;
function applyGeneratedConfig(service, lambdaLogicalId) {
    var _a, _b;
    const declared = Object.entries((_a = service.functions) !== null && _a !== void 0 ? _a : {}).filter(([, fn]) => isBlock(fn) && fn.concurrency !== undefined);
    if (declared.length === 0)
        return;
    const config = (_b = service.custom) === null || _b === void 0 ? void 0 : _b.provisionedConcurrencyAutoscaling;
    if (!config) {
        throw new Error('functions declare concurrency but custom.provisionedConcurrencyAutoscaling.target is not set');
    }
    validateTarget(config.target);
    for (const [name, fn] of declared) {
        const entry = resolveEntry(name, fn.concurrency, config.target, config.primaryDeploymentGroup);
        delete fn.concurrency;
        applyEntry(service, name, entry, lambdaLogicalId);
    }
}
exports.applyGeneratedConfig = applyGeneratedConfig;
//# sourceMappingURL=generated.js.map