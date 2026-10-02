"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const util = __importStar(require("util"));
const policy_1 = __importDefault(require("./aws/policy"));
const target_1 = __importDefault(require("./aws/target"));
const schema_1 = require("./schema/schema");
const generated_1 = require("./generated");
const text = {
    CLI_DONE: 'Added Provisioned Concurrency Auto Scaling to CloudFormation!',
    CLI_RESOURCE: ' - Building Configuration for resource "lambda/%s"',
    CLI_SKIP: 'Skipping Provisioned Concurrency Auto Scaling: %s!',
    CLI_START: 'Configuring Provisioned Concurrency Auto Scaling...',
    INVALID_CONFIG: 'Invalid serverless Config',
    NO_AUTOSCALING_CONFIG: 'Concurrency configuration is missing',
    ONLY_AWS_SUPPORT: 'Only supported for AWS provider',
};
class Plugin {
    constructor(serverless, options, logging) {
        this.hooks = {};
        this.managedInstances = {};
        this.serverless = serverless;
        this.options = options;
        this.logging = logging;
        if (this.serverless.configSchemaHandler &&
            this.serverless.configSchemaHandler.defineFunctionProperties) {
            this.serverless.configSchemaHandler.defineFunctionProperties('aws', schema_1.schema);
        }
        this.hooks = {
            initialize: this.applyGeneratedConfig.bind(this),
            'after:package:compileFunctions': this.aliasManagedInstances.bind(this),
            'package:compileEvents': this.beforeDeployResources.bind(this),
            'after:package:compileEvents': this.permitManagedInstanceAliases.bind(this),
        };
    }
    applyGeneratedConfig() {
        const naming = this.serverless.getProvider('aws').naming;
        this.managedInstances = (0, generated_1.applyGeneratedConfig)(this.serverless.service, (name) => naming.getLambdaLogicalId(name));
    }
    aliasManagedInstances() {
        return __awaiter(this, void 0, void 0, function* () {
            const routed = new Set();
            for (const name of Object.keys(this.managedInstances)) {
                if (yield this.liveAliasExists(name))
                    routed.add(name);
            }
            (0, generated_1.aliasManagedInstances)(this.serverless.service, this.managedInstances, this.serverless.getProvider('aws').naming, routed);
        });
    }
    liveAliasExists(name) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            try {
                yield this.serverless
                    .getProvider('aws')
                    .request('Lambda', 'getAlias', {
                    FunctionName: this.serverless.service.getFunction(name).name,
                    Name: generated_1.LIVE_ALIAS,
                });
                return true;
            }
            catch (error) {
                if (((_a = error === null || error === void 0 ? void 0 : error.providerError) === null || _a === void 0 ? void 0 : _a.statusCode) === 404)
                    return false;
                throw error;
            }
        });
    }
    permitManagedInstanceAliases() {
        const naming = this.serverless.getProvider('aws')
            .naming;
        (0, generated_1.permitManagedInstanceAliases)(this.serverless.service, this.managedInstances, naming);
        (0, generated_1.dependMethodsOnManagedInstancePermissions)(this.serverless.service, this.managedInstances, naming);
    }
    validate(pcFunctions) {
        (0, assert_1.default)(this.serverless, text.INVALID_CONFIG);
        (0, assert_1.default)(this.serverless.service, text.INVALID_CONFIG);
        (0, assert_1.default)(this.serverless.service.provider, text.INVALID_CONFIG);
        (0, assert_1.default)(this.serverless.service.provider.name, text.INVALID_CONFIG);
        (0, assert_1.default)(this.serverless.service.provider.name === 'aws', text.ONLY_AWS_SUPPORT);
        (0, assert_1.default)(pcFunctions[0] !== undefined, text.NO_AUTOSCALING_CONFIG);
    }
    defaults(config) {
        var _a;
        const alias = config.alias || 'provisioned';
        const customMetricConfig = {
            metricName: 'ProvisionedConcurrencyUtilization',
            namespace: 'AWS/Lambda',
            statistic: ((_a = config.customMetric) === null || _a === void 0 ? void 0 : _a.statistic) || 'Maximum',
            unit: 'Count',
            dimensions: [
                { name: 'FunctionName', value: config.name },
                { name: 'Resource', value: `${config.name}:${alias}` },
            ],
        };
        return {
            alias,
            name: config.name,
            function: config.function,
            usage: typeof config.usage !== 'undefined' && config.usage > 0
                ? config.usage
                : 0.75,
            minimum: typeof config.minimum !== 'undefined' ? config.minimum : 1,
            maximum: typeof config.maximum !== 'undefined' ? config.maximum : 10,
            scaleInCooldown: typeof config.scaleInCooldown !== 'undefined'
                ? config.scaleInCooldown
                : 0,
            scaleOutCooldown: typeof config.scaleOutCooldown !== 'undefined'
                ? config.scaleOutCooldown
                : 0,
            customMetric: config.customMetric ? customMetricConfig : undefined,
            scheduledActions: config.scheduledActions,
        };
    }
    resources(config) {
        const data = this.defaults(config);
        const options = {
            region: this.serverless.getProvider('aws').getRegion(),
            service: this.serverless.service.getServiceName(),
            stage: this.serverless.getProvider('aws').getStage(),
        };
        this.logging.log.info(util.format(text.CLI_RESOURCE, config.function));
        const resources = [];
        resources.push(...this.getPolicyAndTarget(options, data));
        return resources;
    }
    getPolicyAndTarget(options, data) {
        return [new policy_1.default(options, data), new target_1.default(options, data)];
    }
    generate(config) {
        let resources = [];
        let lastResources = [];
        const current = this.resources(config).map((resource) => {
            resource.dependencies = lastResources;
            return resource.toJSON();
        });
        resources = resources.concat(current);
        lastResources = current.map((item) => Object.keys(item).pop());
        return resources;
    }
    validateFunctions(instance) {
        return !!(instance.provisionedConcurrency &&
            typeof instance.provisionedConcurrency === 'number' &&
            instance.provisionedConcurrency > 0 &&
            instance.concurrencyAutoscaling &&
            ((typeof instance.concurrencyAutoscaling === 'boolean' &&
                instance.concurrencyAutoscaling) ||
                (typeof instance.concurrencyAutoscaling === 'object' &&
                    instance.concurrencyAutoscaling.enabled === true)));
    }
    getFunctions() {
        const pcFunctions = [];
        const allFunctions = this.serverless.service.getAllFunctions();
        allFunctions.forEach((functionName) => {
            const instance = this.serverless.service.getFunction(functionName);
            if (this.validateFunctions(instance)) {
                pcFunctions.push(Object.assign({ function: functionName, name: instance.name }, instance.concurrencyAutoscaling));
            }
        });
        return pcFunctions;
    }
    process(pcFunctions) {
        pcFunctions.forEach((config) => {
            const functionConfig = this.generate(config);
            functionConfig.forEach((resource) => {
                this.serverless.service.provider.compiledCloudFormationTemplate.Resources = Object.assign(Object.assign({}, this.serverless.service.provider.compiledCloudFormationTemplate
                    .Resources), resource);
            });
        });
        return true;
    }
    beforeDeployResources() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const pcFunctions = this.getFunctions();
                this.validate(pcFunctions);
                this.logging.log.info(util.format(text.CLI_START));
                this.process(pcFunctions);
                this.logging.log.info(util.format(text.CLI_DONE));
            }
            catch (err) {
                this.logging.log.info(util.format(text.CLI_SKIP, err.message));
            }
        });
    }
}
exports.default = Plugin;
//# sourceMappingURL=plugin.js.map