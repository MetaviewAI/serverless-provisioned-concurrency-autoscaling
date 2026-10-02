"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dependMethodsOnManagedInstancePermissions = exports.aliasManagedInstances = exports.applyGeneratedConfig = exports.applyEntry = exports.LIVE_ALIAS = exports.scalingFor = exports.resolveEntry = exports.selectDeploy = void 0;
const crypto_1 = require("crypto");
const SETTING_KEYS = [
    'min',
    'max',
    'maxVCpuCount',
    'targetUtilization',
    'scaleInCooldown',
    'statistic',
];
const isBlock = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
function validateBlocks(name, concurrency, deploys) {
    var _a, _b;
    for (const [key, value] of Object.entries(concurrency)) {
        if (isBlock(value) && !deploys.includes(key)) {
            throw new Error(`concurrency of function "${name}" has a block for unknown deploy "${key}"; ` +
                `expected one of ${deploys.join(', ')}`);
        }
        const settings = isBlock(value) ? Object.keys(value) : [key];
        const unknown = settings.filter((setting) => !SETTING_KEYS.includes(setting));
        if (unknown.length > 0) {
            throw new Error(`concurrency of function "${name}" has unknown setting ${unknown.join(', ')}; ` +
                `expected ${SETTING_KEYS.join(', ')}`);
        }
        if (isBlock(value) &&
            Number((_a = value.max) !== null && _a !== void 0 ? _a : 0) > 0 &&
            !Number((_b = value.min) !== null && _b !== void 0 ? _b : 0)) {
            throw new Error(`concurrency of function "${name}" sets ${key}.max without a floor; ` +
                'provisioned concurrency cannot scale up from 0, so set min or omit max');
        }
    }
}
function selectDeploy(config) {
    var _a;
    if (!isBlock(config) ||
        typeof config.target !== 'string' ||
        !isBlock(config.deploys)) {
        throw new Error('functions declare concurrency, but custom.provisionedConcurrencyAutoscaling needs a target and deploys');
    }
    const deploys = Object.keys(config.deploys);
    if (!deploys.includes(config.target)) {
        throw new Error(`deploy "${config.target}" is not in provisionedConcurrencyAutoscaling.deploys (${deploys.join(', ')})`);
    }
    const entry = (_a = config.deploys[config.target]) !== null && _a !== void 0 ? _a : {};
    if (!isBlock(entry)) {
        throw new Error(`deploy "${config.target}" must be a mapping`);
    }
    const deploy = entry;
    const { from, maxFloor } = deploy;
    if (from !== undefined && !deploys.includes(from)) {
        throw new Error(`deploy "${config.target}" borrows from unknown deploy "${from}"`);
    }
    if (maxFloor !== undefined &&
        !(Number.isInteger(maxFloor) && maxFloor >= 0)) {
        throw new Error(`deploy "${config.target}" has maxFloor ${maxFloor}; expected an integer >= 0`);
    }
    return { target: config.target, deploy, deploys };
}
exports.selectDeploy = selectDeploy;
function resolveEntry(name, concurrency, { target, deploy, deploys }) {
    validateBlocks(name, concurrency, deploys);
    const shared = Object.fromEntries(Object.entries(concurrency).filter(([, value]) => !isBlock(value)));
    const block = (key) => {
        const value = concurrency[key];
        return isBlock(value) ? value : {};
    };
    const resolved = Object.assign({ min: 0 }, shared);
    if (deploy.from !== undefined) {
        Object.assign(resolved, block(deploy.from));
        if (deploy.maxFloor !== undefined && resolved.maxVCpuCount === undefined) {
            resolved.min = Math.min(resolved.min, deploy.maxFloor);
        }
    }
    Object.assign(resolved, block(target));
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
            `for ${target}; expected integers with 0 <= min <= max`);
    }
    return resolved;
}
exports.resolveEntry = resolveEntry;
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
const DEACTIVATE_LATEST_PUBLISHED = false;
exports.LIVE_ALIAS = 'live';
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
    service.functions[name].versionFunction = true;
    functionResource.Properties.PublishToLatestPublished = false;
    functionResource.Properties.FunctionScalingConfig =
        DEACTIVATE_LATEST_PUBLISHED
            ? { MinExecutionEnvironments: 0, MaxExecutionEnvironments: 0 }
            : Object.assign(Object.assign({}, functionResource.Properties.FunctionScalingConfig), { MinExecutionEnvironments: entry.min });
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
    const managed = {};
    const declared = Object.entries((_a = service.functions) !== null && _a !== void 0 ? _a : {}).filter(([, fn]) => isBlock(fn) && fn.concurrency !== undefined);
    if (declared.length === 0)
        return managed;
    const selection = selectDeploy((_b = service.custom) === null || _b === void 0 ? void 0 : _b.provisionedConcurrencyAutoscaling);
    for (const [name, fn] of declared) {
        const definition = fn;
        const entry = resolveEntry(name, definition.concurrency, selection);
        delete definition.concurrency;
        applyEntry(service, name, entry, lambdaLogicalId);
        if (entry.maxVCpuCount !== undefined)
            managed[name] = entry.min;
    }
    return managed;
}
exports.applyGeneratedConfig = applyGeneratedConfig;
const stableJson = (value) => Array.isArray(value)
    ? `[${value.map(stableJson).join(',')}]`
    : isBlock(value)
        ? `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
            .join(',')}}`
        : JSON.stringify(value);
function versionLogicalIdWithExtensions(versionLogicalId, extension) {
    const _a = extension !== null && extension !== void 0 ? extension : {}, { FunctionScalingConfig } = _a, properties = __rest(_a, ["FunctionScalingConfig"]);
    const digest = (0, crypto_1.createHash)('sha256').update(stableJson(properties));
    return `${versionLogicalId}${digest.digest('hex').slice(0, 12)}`;
}
function aliasManagedInstances(service, managed, naming) {
    var _a, _b, _c, _d;
    const template = service.provider.compiledCloudFormationTemplate;
    for (const [name, min] of Object.entries(managed)) {
        const fn = service.functions[name];
        const functionLogicalId = naming.getLambdaLogicalId(name);
        const version = template.Resources[fn.versionLogicalId];
        if ((version === null || version === void 0 ? void 0 : version.Type) !== 'AWS::Lambda::Version') {
            throw new Error(`Managed Instances function "${name}" has no compiled AWS::Lambda::Version to alias`);
        }
        if (fn.targetAlias !== undefined) {
            throw new Error(`Managed Instances function "${name}" already targets alias "${fn.targetAlias.name}"; ` +
                'remove provisionedConcurrency, snapStart or durableConfig');
        }
        const versionLogicalId = versionLogicalIdWithExtensions(fn.versionLogicalId, (_c = (_b = (_a = service.resources) === null || _a === void 0 ? void 0 : _a.extensions) === null || _b === void 0 ? void 0 : _b[functionLogicalId]) === null || _c === void 0 ? void 0 : _c.Properties);
        delete template.Resources[fn.versionLogicalId];
        template.Resources[versionLogicalId] = version;
        fn.versionLogicalId = versionLogicalId;
        const output = (_d = template.Outputs) === null || _d === void 0 ? void 0 : _d[naming.getLambdaVersionOutputLogicalId(name)];
        if (output)
            output.Value = { Ref: versionLogicalId };
        version.Properties.FunctionScalingConfig = {
            MinExecutionEnvironments: min,
        };
        const aliasLogicalId = `${naming.getNormalizedFunctionName(name)}LiveLambdaAlias`;
        template.Resources[aliasLogicalId] = {
            Type: 'AWS::Lambda::Alias',
            Properties: {
                FunctionName: { Ref: functionLogicalId },
                FunctionVersion: { 'Fn::GetAtt': [versionLogicalId, 'Version'] },
                Name: exports.LIVE_ALIAS,
            },
            DependsOn: functionLogicalId,
        };
        fn.targetAlias = { name: exports.LIVE_ALIAS, logicalId: aliasLogicalId };
    }
}
exports.aliasManagedInstances = aliasManagedInstances;
function dependMethodsOnManagedInstancePermissions(service, managed, naming) {
    var _a;
    const resources = service.provider.compiledCloudFormationTemplate.Resources;
    for (const name of Object.keys(managed)) {
        const permissionLogicalId = naming.getLambdaApiGatewayPermissionLogicalId(name);
        if (resources[permissionLogicalId] === undefined)
            continue;
        const aliasLogicalId = service.functions[name].targetAlias.logicalId;
        for (const resource of Object.values(resources)) {
            if (resource.Type !== 'AWS::ApiGateway::Method')
                continue;
            const dependsOn = [(_a = resource.DependsOn) !== null && _a !== void 0 ? _a : []].flat();
            if (dependsOn.includes(aliasLogicalId) &&
                !dependsOn.includes(permissionLogicalId)) {
                resource.DependsOn = [...dependsOn, permissionLogicalId];
            }
        }
    }
}
exports.dependMethodsOnManagedInstancePermissions = dependMethodsOnManagedInstancePermissions;
//# sourceMappingURL=generated.js.map