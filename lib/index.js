/**
 * DeepSeek Harness 上下文窗口手动配置插件 (dsh-context-window) — Host half & shared utilities.
 *
 * 1. 在底部聊天输入框的模型选择弹窗中（通过 `conversation.input.model` 插槽 `priority: -10` 无损接管），
 *    原汁原味扩展第三行【上下文窗口】（Context window）及二级档位/自定义输入面板，
 *    直接通过 `ctx.remote.settings.mutate("llm-pi-ai", ...)` 写回 `cordis.patch.yml` 并触发 `directory.select`
 *    实时刷新当前会话的上下文容量与 Context Pressure 进度条。
 * 2. 自适应压缩预算联动与高切低防失败守卫：
 *    - 根据目标 `contextWindow` 自动按比例收敛模型 `maxTokens`（上限 `12.5%`）与 `compaction-basic` 的
 *      `headroomTokens` / `maxTokens`（上限 `7.5%`），彻底消除切换至 `64K` / `128K` 时因默认预留 `32K + 64K = 96K`
 *      导致 `pressureBudgetTokens <= 0` 抛 `TargetPressureConfigError` 的问题，确保 80% 预防性自动压缩在任意窗口下精准生效。
 *    - 宿主端拦截上一轮大窗口遗留的 `requestHeader.config.maxTokens` 并在窗口变更时立即同步 `request/context` 事件。
 *
 * @module dsh-context-window
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function importHostPackage(specifier) {
  try {
    return await import(specifier);
  } catch {
    const anchors = [
      process.argv[1],
      typeof process.resourcesPath === 'string'
        ? path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json')
        : undefined,
    ].filter((item) => typeof item === 'string' && item.length > 0);

    for (const anchor of anchors) {
      try {
        const req = createRequire(anchor);
        const resolved = req.resolve(specifier);
        return await import(pathToFileURL(resolved).href);
      } catch {
        // try next anchor
      }
    }
    return null;
  }
}

const schemasteryMod = await importHostPackage('@deepseek-ai/schemastery');
const schemastery = schemasteryMod ? (schemasteryMod.default ?? schemasteryMod) : null;

export const name = 'context-window';
export const inject = [];

/** 默认上下文窗口容量（256K = 262,144 tokens） */
export const DEFAULT_CONTEXT_WINDOW = 262144;

/** DeepSeek 官方适配器默认上下文窗口容量（1M = 1,000,000 tokens） */
export const DEFAULT_DEEPSEEK_CONTEXT_WINDOW = 1000000;

/** DeepSeek 官方适配器默认最大输出（256,000 tokens） */
export const DEFAULT_DEEPSEEK_MAX_TOKENS = 256000;

/** pi-ai 适配器默认最大输出（32K = 32,768 tokens） */
export const DEFAULT_PI_AI_MAX_TOKENS = 32768;

/** compaction-basic 默认压缩余量（64K = 65,536 tokens） */
export const DEFAULT_COMPACTION_HEADROOM_TOKENS = 65536;

/** 二级面板预设档位列表（按 1024 进制换算） */
export const CONTEXT_WINDOW_PRESETS = Object.freeze([
  Object.freeze({ key: 'preset:64k', label: '64K', value: 64 * 1024 }),
  Object.freeze({ key: 'preset:128k', label: '128K', value: 128 * 1024 }),
  Object.freeze({ key: 'preset:256k', label: '256K', value: 256 * 1024 }),
  Object.freeze({ key: 'preset:512k', label: '512K', value: 512 * 1024 }),
  Object.freeze({ key: 'preset:1m', label: '1M', value: 1024 * 1024 }),
  Object.freeze({ key: 'preset:2m', label: '2M', value: 2 * 1024 * 1024 }),
]);

/**
 * 计算与目标 `contextWindow` 匹配的自适应输出预留与压缩预算参数。
 *
 * DSH 内核 `dsh-compaction-basic` 的预算公式为：
 * - `messageBudgetTokens = contextWindow - reservedCompletionTokens`
 * - `pressureBudgetTokens = messageBudgetTokens - headroomTokens`
 * - `thresholdTokens = Math.floor(Math.min(contextWindow * 0.8, pressureBudgetTokens))`
 *
 * 通过将单次输出预留 `maxSafeCompletionTokens` 控制在窗口的 `12.5%` 以内、
 * 压缩总结余量 `headroomTokens` 控制在窗口的 `7.5%` 以内（合计 `<= 20%`），
 * 可保证任意窗口档位（包括 `64K` / `128K`）下 `pressureBudgetTokens >= 0.8 * contextWindow`，
 * 既不会抛出 `TargetPressureConfigError`，也不会导致提前压缩或总结请求超限。
 *
 * @param {number} contextWindow
 * @param {number} [thresholdRatio=0.8]
 * @param {number} [retainRatio=0.16]
 * @returns {{
 *   contextWindow: number,
 *   maxSafeCompletionTokens: number,
 *   headroomTokens: number,
 *   summarizationMaxTokens: number,
 *   thresholdTokens: number,
 *   retainTokens: number
 * }}
 */
export function computeAdaptiveCompactionBudget(
  contextWindow,
  thresholdRatio = 0.8,
  retainRatio = 0.16,
) {
  const cw =
    typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.round(contextWindow)
      : DEFAULT_CONTEXT_WINDOW;

  // 12.5% 作为单次输出预留上限（64K->8K, 128K->16K, 256K->32K, >=512K->64K）
  const maxSafeCompletionTokens = Math.max(
    1,
    Math.min(DEFAULT_COMPACTION_HEADROOM_TOKENS, Math.floor(cw * 0.125) || 1),
  );

  // 7.5% 作为压缩总结余量与总结输出上限（确保 maxSafeCompletionTokens + headroomTokens <= 20% * cw）
  const remainingAfterThreshold = Math.max(
    1,
    cw - maxSafeCompletionTokens - Math.floor(cw * thresholdRatio),
  );
  const headroomTokens = Math.max(
    1,
    Math.min(
      DEFAULT_COMPACTION_HEADROOM_TOKENS,
      remainingAfterThreshold,
      Math.floor(cw * 0.075) || 1,
    ),
  );

  const messageBudgetTokens = Math.max(1, cw - maxSafeCompletionTokens);
  const pressureBudgetTokens = Math.max(1, messageBudgetTokens - headroomTokens);
  const thresholdTokens = Math.max(
    1,
    Math.floor(Math.min(cw * thresholdRatio, pressureBudgetTokens)),
  );
  const retainTokens = Math.max(0, Math.floor(messageBudgetTokens * retainRatio));

  return Object.freeze({
    contextWindow: cw,
    maxSafeCompletionTokens,
    headroomTokens,
    summarizationMaxTokens: headroomTokens,
    thresholdTokens,
    retainTokens,
  });
}

/**
 * 判断从当前上下文窗口切换到目标窗口时，是否需要先执行一次 `/compact` 压缩。
 *
 * @param {{
 *   currentContextWindow: number,
 *   nextContextWindow: number,
 *   usedTokens: number | undefined | null
 * }} params
 * @returns {{
 *   shouldPreCompact: boolean,
 *   usedTokens: number,
 *   nextThresholdTokens: number
 * }}
 */
export function shouldCompactBeforeContextWindowChange({
  currentContextWindow,
  nextContextWindow,
  usedTokens,
}) {
  const used =
    typeof usedTokens === 'number' && Number.isFinite(usedTokens) && usedTokens > 0
      ? Math.round(usedTokens)
      : 0;
  const currentCw =
    typeof currentContextWindow === 'number' && currentContextWindow > 0
      ? Math.round(currentContextWindow)
      : DEFAULT_CONTEXT_WINDOW;
  const nextCw =
    typeof nextContextWindow === 'number' && nextContextWindow > 0
      ? Math.round(nextContextWindow)
      : DEFAULT_CONTEXT_WINDOW;

  const budget = computeAdaptiveCompactionBudget(nextCw);
  const isLowering = nextCw < currentCw;
  const shouldPreCompact = isLowering && used > 0 && used >= budget.thresholdTokens;

  return {
    shouldPreCompact,
    usedTokens: used,
    nextThresholdTokens: budget.thresholdTokens,
  };
}

/**
 * 将 token 数量格式化为紧凑的人类可读容量文本。
 * - 优先按 1024 进制整数倍换算：`64K`, `128K`, `256K`, `512K`, `1M`, `2M`
 * - 其次兼容 1000 进制整千/整百万：`300000 -> "300K"`, `1000000 -> "1M"`
 * - 其余非标准正整数直接返回原始数值字符串（如 `"123456"`）
 *
 * @param {number | undefined | null} value
 * @returns {string}
 */
export function formatContextWindow(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return formatContextWindow(DEFAULT_CONTEXT_WINDOW);
  }
  const tokens = Math.round(value);
  const BIN_M = 1024 * 1024;
  const BIN_K = 1024;
  if (tokens >= BIN_M && tokens % BIN_M === 0) {
    return `${tokens / BIN_M}M`;
  }
  if (tokens >= BIN_K && tokens % BIN_K === 0) {
    return `${tokens / BIN_K}K`;
  }
  if (tokens >= 1000000 && tokens % 1000000 === 0) {
    return `${tokens / 1000000}M`;
  }
  if (tokens >= 1000 && tokens % 1000 === 0) {
    return `${tokens / 1000}K`;
  }
  return String(tokens);
}

/**
 * 解析手动自定义输入的上下文窗口容量文本。
 * - 支持正整数（如 `"300000"` -> `300000`，允许千分位逗号或下划线）
 * - 支持带 `k/kb/m/mb` 后缀（不区分大小写，按 1024 进制换算，如 `"256k"` -> `262144`，`"500k"` -> `512000`，`"1m"` -> `1048576`，`"1.5m"` -> `1572864`）
 * - 非法输入返回 `undefined`
 *
 * @param {string} rawText
 * @returns {number | undefined}
 */
export function parseContextWindowInput(rawText) {
  if (typeof rawText !== 'string') return undefined;
  const cleaned = rawText.trim().replace(/[,_]/g, '');
  if (cleaned.length === 0) return undefined;

  const match = /^(\d+(?:\.\d+)?)\s*([km])(?:b)?$/i.exec(cleaned);
  if (match !== null) {
    const base = Number(match[1]);
    if (!Number.isFinite(base) || base <= 0) return undefined;
    const unit = match[2].toLowerCase();
    const scale = unit === 'm' ? 1024 * 1024 : 1024;
    const scaled = Math.round(base * scale);
    return Number.isSafeInteger(scaled) && scaled > 0 ? scaled : undefined;
  }

  if (/^\d+$/.test(cleaned)) {
    const exact = Number(cleaned);
    return Number.isSafeInteger(exact) && exact > 0 ? exact : undefined;
  }

  return undefined;
}

/**
 * 从 `llm-pi-ai`（及可选 `llm-deepseek`）的配置快照中读取当前选中模型的 `contextWindow`。
 *
 * @param {{ provider: string, model: string } | null | undefined} selection
 * @param {object | undefined} piAiNamespace - `ctx.configForms.get("llm-pi-ai").getSnapshot()`
 * @param {object | undefined} [deepseekNamespace] - `ctx.configForms.get("llm-deepseek")?.getSnapshot()`
 * @returns {number}
 */
export function resolveModelContextWindow(selection, piAiNamespace, deepseekNamespace) {
  if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
    return DEFAULT_CONTEXT_WINDOW;
  }
  const { provider: providerId, model: modelId } = selection;

  // 1. 优先从 llm-pi-ai 的 user -> value -> base 层读取
  const layers = [
    piAiNamespace?.user,
    piAiNamespace?.value,
    piAiNamespace?.base,
  ];
  for (const layer of layers) {
    const profile = layer?.providers?.[providerId];
    if (!profile || typeof profile !== 'object') continue;

    if (Array.isArray(profile.models)) {
      const matched = profile.models.find((m) => m && typeof m === 'object' && m.id === modelId);
      if (typeof matched?.contextWindow === 'number' && matched.contextWindow > 0) {
        return matched.contextWindow;
      }
    }

    const overrideCw = profile.modelOverrides?.[modelId]?.contextWindow;
    if (typeof overrideCw === 'number' && overrideCw > 0) {
      return overrideCw;
    }

    if (typeof profile.defaultContextWindow === 'number' && profile.defaultContextWindow > 0) {
      return profile.defaultContextWindow;
    }
  }

  // 2. 兼容 llm-deepseek 官方提供商
  if (
    (providerId === 'deepseek-official' || providerId === 'deepseek-account') &&
    deepseekNamespace
  ) {
    const dsLayers = [
      deepseekNamespace?.user,
      deepseekNamespace?.value,
      deepseekNamespace?.base,
    ];
    for (const layer of dsLayers) {
      if (!layer || typeof layer !== 'object') continue;
      if (Array.isArray(layer.models)) {
        const matched = layer.models.find((m) => m && typeof m === 'object' && m.id === modelId);
        if (typeof matched?.contextWindow === 'number' && matched.contextWindow > 0) {
          return matched.contextWindow;
        }
      }
      if (typeof layer.defaultContextWindow === 'number' && layer.defaultContextWindow > 0) {
        return layer.defaultContextWindow;
      }
    }
    return DEFAULT_DEEPSEEK_CONTEXT_WINDOW;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 根据新的 `contextWindow` 自适应调整单个模型条目的 `maxTokens`，避免低窗口下输出预留过大导致压缩失败或网关拒绝。
 *
 * @param {object} entry - 原始模型配置项
 * @param {number} nextContextWindow - 新的上下文窗口容量
 * @param {{ isDeepSeekProvider?: boolean }} [options]
 * @returns {object}
 */
function applyAdaptiveModelEntryCapacity(entry, nextContextWindow, options = {}) {
  const budget = computeAdaptiveCompactionBudget(nextContextWindow);
  const isDeepSeek = options.isDeepSeekProvider === true;
  const nextEntry = {
    ...entry,
    contextWindow: nextContextWindow,
  };

  if (isDeepSeek) {
    // DeepSeek 官方适配器默认 maxTokens 高达 256,000；当窗口调低到 < 1M 时必须收敛 maxTokens
    if (nextContextWindow < DEFAULT_DEEPSEEK_CONTEXT_WINDOW) {
      nextEntry.maxTokens =
        typeof entry.maxTokens === 'number' && entry.maxTokens > 0
          ? Math.min(entry.maxTokens, budget.maxSafeCompletionTokens)
          : budget.maxSafeCompletionTokens;
    } else if (
      typeof entry.maxTokens === 'number' &&
      entry.maxTokens <= DEFAULT_COMPACTION_HEADROOM_TOKENS
    ) {
      // 当调回 >= 1M 时，清除此前因低窗口自动收敛的 maxTokens，恢复官方默认 256K 输出上限
      delete nextEntry.maxTokens;
    }
    return nextEntry;
  }

  // llm-pi-ai 默认 defaultMaxTokens 为 32,768 (32K)
  if (nextContextWindow < DEFAULT_CONTEXT_WINDOW) {
    // 当窗口 < 256K（如 64K / 128K）时，显式写入收敛后的 maxTokens（如 64K->8192, 128K->16384）
    nextEntry.maxTokens =
      typeof entry.maxTokens === 'number' && entry.maxTokens > 0
        ? Math.min(entry.maxTokens, budget.maxSafeCompletionTokens)
        : budget.maxSafeCompletionTokens;
  } else if (typeof entry.maxTokens === 'number') {
    if (entry.maxTokens > budget.maxSafeCompletionTokens) {
      nextEntry.maxTokens = budget.maxSafeCompletionTokens;
    } else if (entry.maxTokens < DEFAULT_PI_AI_MAX_TOKENS) {
      // 当从 64K/128K 重新调回 >= 256K 时，移除低窗口时期自动写入的 8K/16K 限制，恢复默认 32K
      delete nextEntry.maxTokens;
    }
  }

  return nextEntry;
}

/**
 * 克隆并更新目标提供商下的 `models` 数组。
 *
 * @param {Array<object> | undefined} sourceModels - 原始 models 数组
 * @param {string} modelId - 当前选中的模型 ID
 * @param {number} nextContextWindow - 新的上下文窗口大小
 * @param {boolean} [syncAll=true] - 是否同步更新该提供商下的所有模型
 * @param {Array<object>} [fallbackGroupModels] - 当配置层尚未显式列出 models 时，从目录获取的模型列表
 * @param {{ isDeepSeekProvider?: boolean }} [options]
 * @returns {Array<object>}
 */
export function buildUpdatedProviderModels(
  sourceModels,
  modelId,
  nextContextWindow,
  syncAll = true,
  fallbackGroupModels = [],
  options = {},
) {
  const baseList =
    Array.isArray(sourceModels) && sourceModels.length > 0
      ? structuredClone(sourceModels)
      : Array.isArray(fallbackGroupModels) && fallbackGroupModels.length > 0
        ? fallbackGroupModels.map((m) => ({
            id: m.id,
            ...(typeof m.name === 'string' && m.name !== m.id ? { name: m.name } : {}),
          }))
        : modelId
          ? [{ id: modelId }]
          : [];

  let foundTarget = false;
  const updated = baseList.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const isTarget = entry.id === modelId;
    if (isTarget) foundTarget = true;
    if (syncAll || isTarget) {
      return applyAdaptiveModelEntryCapacity(entry, nextContextWindow, options);
    }
    return { ...entry };
  });

  if (!foundTarget && typeof modelId === 'string' && modelId.length > 0) {
    updated.push(
      applyAdaptiveModelEntryCapacity({ id: modelId }, nextContextWindow, options),
    );
  }

  return updated;
}

/**
 * 构建用于 `ctx.remote.settings.mutate` 的参数负载。
 */
export function buildContextWindowMutateRequest({
  selection,
  nextContextWindow,
  syncAll = true,
  piAiNamespace,
  deepseekNamespace,
  fallbackGroupModels = [],
}) {
  const providerId = selection?.provider;
  const modelId = selection?.model;
  if (!providerId || !modelId) {
    throw new Error('dsh-context-window: missing active model selection');
  }
  const parsedWindow =
    typeof nextContextWindow === 'number'
      ? nextContextWindow
      : parseContextWindowInput(String(nextContextWindow));
  if (typeof parsedWindow !== 'number' || !Number.isSafeInteger(parsedWindow) || parsedWindow <= 0) {
    throw new Error(`dsh-context-window: invalid contextWindow value "${String(nextContextWindow)}"`);
  }

  const hasPiAiProvider = Boolean(
    piAiNamespace?.user?.providers?.[providerId] ||
      piAiNamespace?.value?.providers?.[providerId] ||
      piAiNamespace?.base?.providers?.[providerId],
  );

  if (
    !hasPiAiProvider &&
    (providerId === 'deepseek-official' || providerId === 'deepseek-account') &&
    deepseekNamespace &&
    deepseekNamespace.status !== 'unavailable'
  ) {
    const sourceModels =
      deepseekNamespace.user?.models ??
      deepseekNamespace.value?.models ??
      deepseekNamespace.base?.models;
    const updatedModels = buildUpdatedProviderModels(
      sourceModels,
      modelId,
      parsedWindow,
      syncAll,
      fallbackGroupModels,
      { isDeepSeekProvider: true },
    );
    return {
      ns: 'llm-deepseek',
      ops: [{ op: 'set', path: ['models'], value: updatedModels }],
      revision: deepseekNamespace.revision,
      updatedModels,
    };
  }

  const sourceModels =
    piAiNamespace?.user?.providers?.[providerId]?.models ??
    piAiNamespace?.value?.providers?.[providerId]?.models ??
    piAiNamespace?.base?.providers?.[providerId]?.models;
  const updatedModels = buildUpdatedProviderModels(
    sourceModels,
    modelId,
    parsedWindow,
    syncAll,
    fallbackGroupModels,
    { isDeepSeekProvider: false },
  );
  return {
    ns: 'llm-pi-ai',
    ops: [{ op: 'set', path: ['providers', providerId, 'models'], value: updatedModels }],
    revision: piAiNamespace?.revision,
    updatedModels,
  };
}

export function unwrapVolatile(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value;
}

export function normalizeConfig(raw = {}) {
  const unwrappedRoot = unwrapVolatile(raw);
  const input = unwrappedRoot && typeof unwrappedRoot === 'object' ? unwrappedRoot : {};
  const enabledVal = unwrapVolatile(input.enabled);
  const showInTriggerVal = unwrapVolatile(input.showInTrigger);
  const syncAllVal = unwrapVolatile(input.defaultSyncAllProviderModels);

  return {
    enabled: typeof enabledVal === 'boolean' ? enabledVal : true,
    showInTrigger: typeof showInTriggerVal === 'boolean' ? showInTriggerVal : true,
    defaultSyncAllProviderModels: typeof syncAllVal === 'boolean' ? syncAllVal : true,
  };
}

function makeFallbackFieldNode(uid, type, meta) {
  return {
    uid,
    type,
    meta,
    toJSON() {
      return {
        uid,
        refs: {
          [uid]: { type, meta: { ...meta } },
        },
      };
    },
  };
}

function createFallbackSchema() {
  const schema = (value) => normalizeConfig(value);
  const dict = {
    enabled: makeFallbackFieldNode(1, 'boolean', { default: true }),
    showInTrigger: makeFallbackFieldNode(2, 'boolean', { default: true, volatile: true }),
    defaultSyncAllProviderModels: makeFallbackFieldNode(3, 'boolean', {
      default: true,
      volatile: true,
    }),
  };
  schema.uid = 0;
  schema.type = 'object';
  schema.meta = {};
  schema.dict = dict;
  schema.toJSON = () => ({
    uid: 0,
    refs: {
      0: {
        type: 'object',
        meta: {},
        dict: {
          enabled: 1,
          showInTrigger: 2,
          defaultSyncAllProviderModels: 3,
        },
      },
      1: { type: 'boolean', meta: { default: true } },
      2: { type: 'boolean', meta: { default: true, volatile: true } },
      3: { type: 'boolean', meta: { default: true, volatile: true } },
    },
  });
  Object.defineProperty(schema, '~standard', {
    value: {
      version: 1,
      vendor: 'dsh-context-window',
      validate(value) {
        return { value: normalizeConfig(value) };
      },
    },
    enumerable: false,
    configurable: true,
  });
  return schema;
}

function withVolatile(fieldSchema) {
  return typeof fieldSchema?.volatile === 'function' ? fieldSchema.volatile() : fieldSchema;
}

function createPluginSchema() {
  if (!schemastery) return createFallbackSchema();
  try {
    return schemastery.object({
      enabled: schemastery.boolean().default(true),
      showInTrigger: withVolatile(schemastery.boolean().default(true)),
      defaultSyncAllProviderModels: withVolatile(schemastery.boolean().default(true)),
    });
  } catch {
    return createFallbackSchema();
  }
}

export const Config = createPluginSchema();

/**
 * 动态更新 `BasicCompactionEngine.config.modelPolicies`，使指定 `provider/model` 的
 * `headroomTokens` 与 `maxTokens` 与其实际 `contextWindow` 成比例收敛。
 *
 * @param {object} compaction - `ctx.compaction` 实例
 * @param {{ provider: string, model: string }} target
 * @param {number} contextWindow
 */
export function syncCompactionPolicyForModel(compaction, target, contextWindow) {
  if (!compaction || typeof compaction !== 'object' || !compaction.config) return null;
  if (!target?.provider || !target?.model) return null;

  const budget = computeAdaptiveCompactionBudget(contextWindow);
  const currentConfig = compaction.config;
  const existingPolicies = Array.isArray(currentConfig.modelPolicies)
    ? currentConfig.modelPolicies
    : [];

  const nextPolicy = Object.freeze({
    provider: target.provider,
    model: target.model,
    thresholdRatio: currentConfig.thresholdRatio ?? 0.8,
    headroomTokens: budget.headroomTokens,
    ...(currentConfig.retainTokens !== undefined
      ? { retainTokens: Math.min(currentConfig.retainTokens, budget.retainTokens) }
      : { retainRatio: currentConfig.retainRatio ?? 0.16 }),
    summarizationProvider: currentConfig.summarizationProvider ?? '',
    summarizationModel: currentConfig.summarizationModel ?? '',
    maxTokens: budget.summarizationMaxTokens,
    compactionRetries: Math.max(currentConfig.compactionRetries ?? 1, 2),
    maxOverflowRetries: Math.max(currentConfig.maxOverflowRetries ?? 1, 2),
  });

  const idx = existingPolicies.findIndex(
    (p) => p.provider === target.provider && p.model === target.model,
  );
  const updatedPolicies =
    idx === -1
      ? [...existingPolicies, nextPolicy]
      : existingPolicies.map((p, i) => (i === idx ? nextPolicy : p));

  compaction.config = Object.freeze({
    ...currentConfig,
    modelPolicies: Object.freeze(updatedPolicies),
  });

  if (compaction.warnedPressureConfigTargets instanceof Set) {
    compaction.warnedPressureConfigTargets.delete(`${target.provider}/${target.model}`);
  }

  return budget;
}

/**
 * 安装宿主端压缩守卫：
 * 1. 在 `compactIfNeeded` 与 `summarize` 执行前，实时读取目标模型最新的 `contextWindow` 并动态注入自适应 `modelPolicies`。
 * 2. 若会话上一轮在大窗口下记录了过大的 `requestHeader().config.maxTokens`（例如 256K 或 32K），
 *    在切换至小窗口后的首次 `pre-step` 压缩计算期间临时将其钳制到 `maxSafeCompletionTokens`，防止预算倒挂报错。
 * 3. 当小窗口因尾部保留区（`retainTokens`）偏大导致常规压缩后仍高于阈值时，自动回退一次无保留区压缩（`compactNow` 策略）兜底。
 */
function installHostCompactionGuard(ctx) {
  const patchedCompactions = new WeakSet();

  const patchCompactionService = (compaction) => {
    if (
      !compaction ||
      typeof compaction.compactIfNeeded !== 'function' ||
      patchedCompactions.has(compaction)
    ) {
      return () => {};
    }
    patchedCompactions.add(compaction);

    const originalCompactIfNeeded = compaction.compactIfNeeded.bind(compaction);
    const originalSummarize =
      typeof compaction.summarize === 'function' ? compaction.summarize.bind(compaction) : null;

    const resolveSessionTarget = (agent) => {
      const headerCfg = agent?.session?.requestHeader?.()?.config;
      if (headerCfg?.provider && headerCfg?.model) {
        return { provider: headerCfg.provider, model: headerCfg.model };
      }
      if (agent?.options?.provider && agent?.options?.model) {
        return { provider: agent.options.provider, model: agent.options.model };
      }
      return undefined;
    };

    const prepareAdaptiveBudget = async (agent, signal) => {
      const target = resolveSessionTarget(agent);
      const llm = ctx.get?.('llm') ?? ctx.llm;
      if (!target || !llm || typeof llm.resolveModelInfo !== 'function') return null;
      try {
        const info = await llm.resolveModelInfo(target.provider, target.model, signal);
        const cw = info?.context?.contextWindow;
        if (typeof cw === 'number' && cw > 0) {
          return syncCompactionPolicyForModel(compaction, target, cw);
        }
      } catch {
        // ignore model resolution error and let default compaction handle it
      }
      return null;
    };

    compaction.compactIfNeeded = async function guardedCompactIfNeeded(agent, trigger, signal) {
      const budget = await prepareAdaptiveBudget(agent, signal);
      const session = agent?.session;
      const hasRequestHeader = session && typeof session.requestHeader === 'function';
      let restoreRequestHeader = null;

      if (budget && hasRequestHeader) {
        const currentHeader = session.requestHeader();
        if (
          currentHeader?.config &&
          typeof currentHeader.config.maxTokens === 'number' &&
          currentHeader.config.maxTokens > budget.maxSafeCompletionTokens
        ) {
          const origRequestHeader = session.requestHeader.bind(session);
          session.requestHeader = () => {
            const raw = origRequestHeader();
            if (
              !raw?.config ||
              typeof raw.config.maxTokens !== 'number' ||
              raw.config.maxTokens <= budget.maxSafeCompletionTokens
            ) {
              return raw;
            }
            return {
              ...raw,
              config: {
                ...raw.config,
                maxTokens: budget.maxSafeCompletionTokens,
              },
            };
          };
          restoreRequestHeader = () => {
            session.requestHeader = origRequestHeader;
          };
        }
      }

      try {
        return await originalCompactIfNeeded(agent, trigger, signal);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        // 若从高窗口切到低窗口后，因 16% retainTokens 保留区过大导致压缩后仍高于新阈值，自动用 overflow 零保留策略兜底压缩一次
        if (trigger === 'pressure' && msg.includes('compaction still above threshold')) {
          try {
            return await originalCompactIfNeeded(agent, 'context-overflow', signal);
          } catch {
            throw error;
          }
        }
        throw error;
      } finally {
        restoreRequestHeader?.();
      }
    };

    if (originalSummarize) {
      compaction.summarize = async function guardedSummarize(input, agent, signal) {
        await prepareAdaptiveBudget(agent, signal);
        return originalSummarize(input, agent, signal);
      };
    }

    return () => {
      compaction.compactIfNeeded = originalCompactIfNeeded;
      if (originalSummarize) compaction.summarize = originalSummarize;
      patchedCompactions.delete(compaction);
    };
  };

  let cleanup = () => {};
  const existing = ctx.get?.('compaction');
  if (existing) {
    cleanup = patchCompactionService(existing);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['compaction'], (scope) => {
      const disposePatch = patchCompactionService(scope.compaction);
      if (typeof scope.effect === 'function') {
        scope.effect(() => disposePatch, 'dsh-context-window: compaction guard');
      }
    });
  }
  return cleanup;
}

/**
 * 安装宿主端会话 `request/context` 实时同步：
 * 当用户在前端切换模型或修改 `contextWindow` 时，立即向已建立 `requestContext` 的活跃会话追加最新的
 * `"request/context"` 事件，使右下角 Context Pressure 进度条无需等待下一轮发消息即可实时更新分母与百分比。
 */
function installHostSessionContextSync(ctx) {
  if (typeof ctx?.on !== 'function') return () => {};

  const syncSessionContextWindow = async (session, explicitTarget) => {
    if (!session || typeof session.requestContext !== 'function') return;
    const prevContext = session.requestContext();
    if (!prevContext) return;

    const provider = explicitTarget?.provider ?? prevContext.provider;
    const model = explicitTarget?.model ?? prevContext.model;
    if (!provider || !model) return;

    const llm = ctx.get?.('llm') ?? ctx.llm;
    if (!llm || typeof llm.resolveModelInfo !== 'function') return;

    try {
      const info = await llm.resolveModelInfo(provider, model);
      const nextCw = info?.context?.contextWindow;
      if (typeof nextCw !== 'number' || nextCw <= 0) return;

      const compaction = ctx.get?.('compaction');
      if (compaction) {
        syncCompactionPolicyForModel(compaction, { provider, model }, nextCw);
      }

      const latestContext = session.requestContext();
      if (!latestContext) return;
      if (
        latestContext.provider !== provider ||
        latestContext.model !== model ||
        latestContext.contextWindow !== nextCw
      ) {
        session.append('request/context', {
          provider,
          model,
          contextWindow: nextCw,
          ...(latestContext.systemPromptUpdate === undefined
            ? {}
            : { systemPromptUpdate: latestContext.systemPromptUpdate }),
        });
      }
    } catch {
      // ignore unroutable or transient model lookup errors
    }
  };

  const offSessionEvent = ctx.on('session/event', (session, event) => {
    if (event?.type === 'model/selection' && event.data?.provider && event.data?.model) {
      syncSessionContextWindow(session, {
        provider: event.data.provider,
        model: event.data.model,
      });
    }
  });

  const offVolatileUpdate = ctx.on('loader/volatile-update', () => {
    const sessionsService = ctx.get?.('sessions');
    if (!sessionsService) return;
    const allSessions =
      typeof sessionsService.values === 'function'
        ? sessionsService.values()
        : Array.isArray(sessionsService.list)
          ? sessionsService.list
          : [];
    for (const session of allSessions) {
      syncSessionContextWindow(session);
    }
  });

  return () => {
    if (typeof offSessionEvent === 'function') offSessionEvent();
    if (typeof offVolatileUpdate === 'function') offVolatileUpdate();
  };
}

/**
 * 宿主侧挂载入口：挂载自适应压缩预算守卫与会话上下文容量实时同步。
 */
export function apply(ctx) {
  const disposeCompactionGuard = installHostCompactionGuard(ctx);
  const disposeSessionSync = installHostSessionContextSync(ctx);

  if (typeof ctx?.effect === 'function') {
    ctx.effect(
      () => () => {
        disposeCompactionGuard?.();
        disposeSessionSync?.();
      },
      'dsh-context-window: host lifecycle',
    );
  }
}

export default {
  name,
  inject,
  Config,
  apply,
};
