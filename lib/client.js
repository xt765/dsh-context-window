/**
 * DeepSeek Harness 上下文窗口手动配置插件 (dsh-context-window) — Client UI extension.
 *
 * 1. 通过 `conversation.input.model` 插槽 `priority: -10` 无损接管底部模型选择下拉菜单（`ModelSelect`）：
 *    - 一级菜单（`pane === "root"`）：在「模型」（Model）和「推理等级」（Effort）下方原汁原味追加第三行「上下文窗口」（Context window），
 *      展示当前模型的 `contextWindow`（如 `128K`、`256K`、`512K`、`1M`）与右侧 `IconChevronRightOutlineRegular`。
 *      同时支持在底部触发按钮（`trigger`）上并列紧凑展示当前上下文容量标签。
 *    - 二级面板（`pane === "context"`）：点击第三行钻入上下文窗口选择面板，提供常用预设档位（`64K`、`128K`、`256K`、`512K`、`1M`、`2M`）、
 *      底部手动自定义输入框（支持正整数或 `256k`/`1m` 简写，回车立即保存）以及「同步应用到该提供商下所有模型」开关。
 * 2. 自适应压缩预算联动与「高切低先压缩后降窗」保护：
 *    - 切换至低上下文窗口（如 `64K` / `128K`）时，自动按窗口容量 12.5% 收敛模型 `maxTokens`（调回大窗口时自动恢复默认），
 *      避免默认 `32K`/`256K` 输出预留叠加 `64K` 压缩余量引发 `compaction-basic` 预算倒挂报错。
 *    - 若当前会话已用 Token 超过目标低窗口的 80% 压缩阈值，在写入低窗口配置前先在原高窗口预算下自动触发 `/compact` 压缩历史对话，
 *      彻底规避「先降窗后因历史过长导致总结请求爆窗口」的死锁问题。
 * 3. 在 `plugins.bundle.config` 与 `plugins.row.config` 注册插件可视化配置卡片。
 */
(() => {
  const MODULE_ID = 'dsh-context-window';
  const PLUGIN_NS = 'context-window';
  const MODEL_NS = 'model';
  const SETTINGS_NS = 'settings.contextWindow';
  const BUNDLE_KEY = 'dsh-context-window';
  const ROW_KEY = 'dsh-context-window#context-window';
  const STYLE_TAG_ID = 'dsh-context-window/ContextWindowSelect.css';

  const DEFAULT_CONTEXT_WINDOW = 262144;
  const DEFAULT_DEEPSEEK_CONTEXT_WINDOW = 1000000;
  const DEFAULT_PI_AI_MAX_TOKENS = 32768;
  const DEFAULT_COMPACTION_HEADROOM_TOKENS = 65536;

  const CONTEXT_WINDOW_PRESETS = Object.freeze([
    Object.freeze({ key: 'preset:64k', label: '64K', value: 64 * 1024 }),
    Object.freeze({ key: 'preset:128k', label: '128K', value: 128 * 1024 }),
    Object.freeze({ key: 'preset:256k', label: '256K', value: 256 * 1024 }),
    Object.freeze({ key: 'preset:512k', label: '512K', value: 512 * 1024 }),
    Object.freeze({ key: 'preset:1m', label: '1M', value: 1024 * 1024 }),
    Object.freeze({ key: 'preset:2m', label: '2M', value: 2 * 1024 * 1024 }),
  ]);

  function computeAdaptiveCompactionBudget(
    contextWindow,
    thresholdRatio = 0.8,
    retainRatio = 0.16,
  ) {
    const cw =
      typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
        ? Math.round(contextWindow)
        : DEFAULT_CONTEXT_WINDOW;

    const maxSafeCompletionTokens = Math.max(
      1,
      Math.min(DEFAULT_COMPACTION_HEADROOM_TOKENS, Math.floor(cw * 0.125) || 1),
    );
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

  function shouldCompactBeforeContextWindowChange({
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

  function formatContextWindow(value) {
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

  function parseContextWindowInput(rawText) {
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

  function resolveModelContextWindow(selection, piAiNamespace, deepseekNamespace) {
    if (!selection || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
      return DEFAULT_CONTEXT_WINDOW;
    }
    const { provider: providerId, model: modelId } = selection;

    const layers = [piAiNamespace?.user, piAiNamespace?.value, piAiNamespace?.base];
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

  function applyAdaptiveModelEntryCapacity(entry, nextContextWindow, options = {}) {
    const budget = computeAdaptiveCompactionBudget(nextContextWindow);
    const isDeepSeek = options.isDeepSeekProvider === true;
    const nextEntry = {
      ...entry,
      contextWindow: nextContextWindow,
    };

    if (isDeepSeek) {
      if (nextContextWindow < DEFAULT_DEEPSEEK_CONTEXT_WINDOW) {
        nextEntry.maxTokens =
          typeof entry.maxTokens === 'number' && entry.maxTokens > 0
            ? Math.min(entry.maxTokens, budget.maxSafeCompletionTokens)
            : budget.maxSafeCompletionTokens;
      } else if (
        typeof entry.maxTokens === 'number' &&
        entry.maxTokens <= DEFAULT_COMPACTION_HEADROOM_TOKENS
      ) {
        delete nextEntry.maxTokens;
      }
      return nextEntry;
    }

    if (nextContextWindow < DEFAULT_CONTEXT_WINDOW) {
      nextEntry.maxTokens =
        typeof entry.maxTokens === 'number' && entry.maxTokens > 0
          ? Math.min(entry.maxTokens, budget.maxSafeCompletionTokens)
          : budget.maxSafeCompletionTokens;
    } else if (typeof entry.maxTokens === 'number') {
      if (entry.maxTokens > budget.maxSafeCompletionTokens) {
        nextEntry.maxTokens = budget.maxSafeCompletionTokens;
      } else if (entry.maxTokens < DEFAULT_PI_AI_MAX_TOKENS) {
        delete nextEntry.maxTokens;
      }
    }

    return nextEntry;
  }

  function buildUpdatedProviderModels(
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

  function buildContextWindowMutateRequest({
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
    if (
      typeof parsedWindow !== 'number' ||
      !Number.isSafeInteger(parsedWindow) ||
      parsedWindow <= 0
    ) {
      throw new Error(
        `dsh-context-window: invalid contextWindow value "${String(nextContextWindow)}"`,
      );
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

  function orderModelProviders(groups) {
    if (!Array.isArray(groups)) return [];
    return [...groups].sort(
      (left, right) =>
        (left.id === 'deepseek-account' ? 0 : left.id === 'deepseek-official' ? 1 : 2) -
        (right.id === 'deepseek-account' ? 0 : right.id === 'deepseek-official' ? 1 : 2),
    );
  }

  function clsx(...args) {
    const out = [];
    const visit = (item) => {
      if (!item) return;
      if (typeof item === 'string' || typeof item === 'number') {
        out.push(String(item));
      } else if (Array.isArray(item)) {
        for (const sub of item) visit(sub);
      } else if (typeof item === 'object') {
        for (const [k, v] of Object.entries(item)) {
          if (v) out.push(k);
        }
      }
    };
    for (const arg of args) visit(arg);
    return out.join(' ');
  }

  /**
   * 复用 `@deepseek-ai/dsh-client-ui-model-selection` 的原生类名映射，并补充二级面板底部自定义输入区样式。
   */
  const ModelSelectStyles = {
    cell: 'cl2Rlq_cell',
    cellChevron: 'cl2Rlq_cellChevron',
    cellLabel: 'cl2Rlq_cellLabel',
    cellValue: 'cl2Rlq_cellValue',
    check: 'cl2Rlq_check',
    chevron: 'cl2Rlq_chevron',
    chevronOpen: 'cl2Rlq_chevronOpen',
    empty: 'cl2Rlq_empty',
    error: 'cl2Rlq_error',
    groups: 'cl2Rlq_groups',
    menu: 'cl2Rlq_menu',
    modelName: 'cl2Rlq_modelName',
    modelOption: 'cl2Rlq_modelOption',
    option: 'cl2Rlq_option',
    optionActive: 'cl2Rlq_optionActive',
    optionCopy: 'cl2Rlq_optionCopy',
    retry: 'cl2Rlq_retry',
    root: 'cl2Rlq_root',
    search: 'cl2Rlq_search',
    searchClear: 'cl2Rlq_searchClear',
    searchRow: 'cl2Rlq_searchRow',
    searchWithQuery: 'cl2Rlq_searchWithQuery',
    selected: 'cl2Rlq_selected',
    status: 'cl2Rlq_status',
    trigger: 'cl2Rlq_trigger',
    triggerEffort: 'cl2Rlq_triggerEffort',
    triggerIcon: 'cl2Rlq_triggerIcon',
    triggerLabel: 'cl2Rlq_triggerLabel',
    warning: 'cl2Rlq_warning',
  };

  const EXTRA_CSS = `
.dsh-cw-custom-section {
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(148, 163, 184, 0.22));
  margin-top: 4px;
  padding: 6px 6px 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dsh-cw-custom-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.dsh-cw-custom-input {
  flex: 1;
  min-width: 120px;
  height: 28px;
  font-size: 12px;
}
.dsh-cw-custom-apply {
  border-radius: var(--dsw-radius-sm, 6px);
  border: 0.5px solid var(--dsw-alias-border-l1, rgba(148, 163, 184, 0.3));
  background: var(--dsw-alias-interactive-bg-hover, rgba(148, 163, 184, 0.12));
  color: var(--dsw-alias-label-primary, inherit);
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  flex: none;
}
.dsh-cw-custom-apply:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active, rgba(148, 163, 184, 0.2));
}
.dsh-cw-custom-apply:disabled {
  opacity: 0.45;
  cursor: default;
}
.dsh-cw-sync-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 2px 0;
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #64748b);
  cursor: pointer;
  user-select: none;
}
.dsh-cw-sync-checkbox {
  margin: 0;
  cursor: pointer;
  accent-color: var(--dsw-alias-state-business-primary, #3b82f6);
}
.dsh-cw-preset-tokens {
  color: var(--dsw-alias-label-tertiary, #94a3b8);
  font-size: 11.5px;
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
}
.dsh-cw-compact-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 0 5px;
  height: 16px;
  border-radius: 4px;
  font-size: 10.5px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #64748b);
  background: var(--dsw-alias-interactive-bg-hover, rgba(148, 163, 184, 0.16));
}
.dsh-cw-compact-status {
  padding: 4px 8px;
  font-size: 11.5px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary, #64748b);
  background: var(--dsw-alias-interactive-bg-hover, rgba(148, 163, 184, 0.1));
  border-radius: var(--dsw-radius-sm, 6px);
  margin: 2px 6px 4px;
}
`;

  function ensureStylesInjected() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`)) return;
    const tag = document.createElement('style');
    tag.dataset.plugin = MODULE_ID;
    tag.dataset.pluginCss = STYLE_TAG_ID;
    tag.textContent = EXTRA_CSS;
    document.head.appendChild(tag);
  }

  const UI_COPY = {
    zh: {
      contextWindowLabel: '上下文窗口',
      customPlaceholder: '自定义 (如 256k / 300000)，回车保存',
      applyBtn: '应用',
      syncAllLabel: '同步应用到该提供商下所有模型',
      autoCompactBadge: '先压缩',
      preCompactingStatus: '正在先按原窗口执行 /compact 压缩历史对话…',
      savedNotice: '上下文窗口已更新为 {value}',
      saveError: '上下文窗口更新失败：{message}',
    },
    en: {
      contextWindowLabel: 'Context window',
      customPlaceholder: 'Custom (e.g. 256k / 300000), Enter to save',
      applyBtn: 'Apply',
      syncAllLabel: 'Apply to all models under this provider',
      autoCompactBadge: 'Auto-compact',
      preCompactingStatus: 'Compacting conversation history before lowering window…',
      savedNotice: 'Context window updated to {value}',
      saveError: 'Failed to update context window: {message}',
    },
  };

  const SETTINGS_LOCALE = {
    zh: {
      title: '上下文窗口手动配置',
      description:
        '在聊天输入框模型选择弹窗中扩展第三行「上下文窗口」，支持快速切换 64K~2M 档位或手动输入容量，并实时写回 cordis.patch.yml 与刷新右下角 Context Pressure 进度条。',
      enabled: '启用模型弹窗「上下文窗口」配置行（enabled）',
      enabledHint: '开启后，在底部输入框的模型选择菜单中展示第三行「上下文窗口」及二级选择面板。',
      showInTrigger: '在底部触发按钮上并列显示上下文容量（showInTrigger）',
      showInTriggerHint: '开启后，在输入框底部模型按钮上紧凑显示当前模型的上下文容量（如 256K）。',
      defaultSyncAllProviderModels:
        '默认同步应用到当前提供商下所有模型（defaultSyncAllProviderModels）',
      defaultSyncAllProviderModelsHint:
        '开启后，切换上下文窗口大小时默认更新当前提供商下的全部模型配置。',
      overridden: '已覆盖',
      reset: '恢复默认',
      readOnly: '本部署的设置为只读。',
      unavailable: '该插件当前未启用，暂时无法配置。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '本部署未接受这些配置值，请检查后重试。',
    },
    en: {
      title: 'Context Window Selector',
      description:
        'Extend the composer model selector popup with a third "Context window" row to switch between 64K–2M presets or custom token capacities, persisting to cordis.patch.yml and refreshing the Context Pressure bar in real time.',
      enabled: 'Enable "Context window" row in model popup (enabled)',
      enabledHint:
        'When enabled, adds the third "Context window" row and its drilled preset/custom pane to the composer model menu.',
      showInTrigger: 'Show context window badge in trigger button (showInTrigger)',
      showInTriggerHint:
        'When enabled, compactly displays the active context window size (e.g. 256K) in the composer model trigger button.',
      defaultSyncAllProviderModels:
        'Sync to all models under the current provider by default (defaultSyncAllProviderModels)',
      defaultSyncAllProviderModelsHint:
        'When enabled, changing the context window updates all models under the active provider by default.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      readOnly: 'This deployment stores settings read-only.',
      unavailable: 'This plugin is not active right now, so its settings cannot be edited.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; please check your input.',
    },
  };

  const MEASURE_STYLE = {
    visibility: 'hidden',
    left: 0,
    top: 0,
  };

  function buildModule(require) {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const reactDom = require('react-dom');
    const jsxRuntime = require('react/jsx-runtime');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    const CheckIcon =
      primitives.IconCheckmarkOutlineRegular ?? primitives.IconCheckOutlineRegular;

    ensureStylesInjected();

    /**
     * 打造增强版 `ModelSelect` 组件，100% 保留原生模型与推理等级逻辑，并无缝注入第三行「上下文窗口」与二级配置面板。
     */
    function createEnhancedModelSelect(ctx) {
      const piAiForm = ctx.configForms.get('llm-pi-ai');
      const deepseekForm = ctx.configForms.get('llm-deepseek');
      const pluginForm = ctx.configForms.get(PLUGIN_NS);
      const describeMirror = ctx.configForms.describe();

      return function EnhancedModelSelect({
        sessionId,
        locked,
        available,
        directory,
        load,
        select,
        useProjection,
        t,
        renderSlot,
      }) {
        const state = react.useSyncExternalStore(
          (fn) => directory.subscribe(fn),
          () => directory.getSnapshot(),
        );
        const piAiSnapshot = react.useSyncExternalStore(
          (fn) => piAiForm.subscribe(fn),
          () => piAiForm.getSnapshot(),
        );
        const deepseekSnapshot = react.useSyncExternalStore(
          (fn) => deepseekForm.subscribe(fn),
          () => deepseekForm.getSnapshot(),
        );
        const pluginSnapshot = react.useSyncExternalStore(
          (fn) => pluginForm.subscribe(fn),
          () => pluginForm.getSnapshot(),
        );
        const localeSnapshot = react.useSyncExternalStore(
          (fn) =>
            typeof ctx.locale?.subscribe === 'function'
              ? ctx.locale.subscribe(fn)
              : () => () => {},
          () => (typeof ctx.locale?.getSnapshot === 'function' ? ctx.locale.getSnapshot() : null),
        );

        const pressure =
          typeof useProjection === 'function' ? useProjection('contextPressure') : undefined;
        const breakdown =
          typeof useProjection === 'function' ? useProjection('contextBreakdown') : undefined;
        const usedTokens =
          pressure?.projectedTokens ??
          pressure?.pressureTokens ??
          (breakdown !== undefined
            ? (breakdown.systemTokens ?? 0) +
              (breakdown.toolsTokens ?? 0) +
              (breakdown.messageTokens ?? 0)
            : 0);

        const langKey = ReactLangKey(localeSnapshot);
        const copy = UI_COPY[langKey] ?? UI_COPY.zh;

        const pluginCfg = pluginSnapshot?.value ?? {};
        const pluginEnabled = pluginCfg.enabled !== false;
        const showInTrigger = pluginCfg.showInTrigger !== false;
        const defaultSyncAll = pluginCfg.defaultSyncAllProviderModels !== false;

        const [open, setOpen] = react.useState(false);
        const [pane, setPane] = react.useState('root');
        const [query, setQuery] = react.useState('');
        const [highlightedIndex, setHighlightedIndex] = react.useState(null);
        const [selectionFocus, setSelectionFocus] = react.useState(false);
        const [customInput, setCustomInput] = react.useState('');
        const [syncAllModels, setSyncAllModels] = react.useState(defaultSyncAll);
        const [contextBusy, setContextBusy] = react.useState(false);
        const [preCompacting, setPreCompacting] = react.useState(false);
        const [pendingContextWindow, setPendingContextWindow] = react.useState(null);

        const lastActionRef = react.useRef('load');
        const [toast, setToast] = react.useState(null);
        const toastSeq = react.useRef(0);
        const rootRef = react.useRef(null);
        const triggerRef = react.useRef(null);
        const searchRef = react.useRef(null);
        const customInputRef = react.useRef(null);
        const menuRef = react.useRef(null);
        const groupsRef = react.useRef(null);
        const [menuPos, setMenuPos] = react.useState(null);
        const itemRefs = react.useRef([]);
        const id = react.useId();

        react.useEffect(() => {
          setSyncAllModels(defaultSyncAll);
        }, [defaultSyncAll]);

        const accountProviderName = t('provider.account');
        const groups = react.useMemo(
          () =>
            orderModelProviders(state.groups).map((group) => ({
              ...group,
              provider: {
                id: group.id,
                name: group.id === 'deepseek-account' ? accountProviderName : group.name,
              },
            })),
          [state.groups, accountProviderName],
        );

        const choices = react.useMemo(
          () =>
            groups.flatMap((group) =>
              group.models.map((model) => ({
                group,
                model,
                selection: {
                  provider: group.id,
                  model: model.id,
                  ...(model.reasoning?.defaultEffort === undefined
                    ? {}
                    : { reasoningEffort: model.reasoning.defaultEffort }),
                },
              })),
            ),
          [groups],
        );

        const showSearch = choices.length > 4;
        const filteredGroups = react.useMemo(
          () =>
            groups
              .map((group) => ({
                ...group,
                models: primitives.rankByName(
                  group.models,
                  showSearch ? query.trim() : '',
                ),
              }))
              .filter((group) => group.models.length > 0),
          [groups, query, showSearch],
        );

        const visibleModels = react.useMemo(
          () =>
            filteredGroups.flatMap((group) =>
              group.models.map((model) => ({
                provider: group.id,
                model: model.id,
              })),
            ),
          [filteredGroups],
        );

        const currentVisibleIndex = visibleModels.findIndex(
          (model) =>
            model.provider === state.current?.provider && model.model === state.current.model,
        );
        const activeModelIndex = Math.min(
          highlightedIndex ?? Math.max(0, currentVisibleIndex),
          visibleModels.length - 1,
        );
        const currentChoice =
          choices[
            state.current === null
              ? -1
              : choices.findIndex(
                  (c) =>
                    c.selection.provider === state.current?.provider &&
                    c.selection.model === state.current.model,
                )
          ];
        const reasoning = currentChoice?.model.reasoning;
        const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
        const effortLabel =
          currentChoice === undefined
            ? undefined
            : reasoning === undefined
              ? state.retainedEffort
              : effectiveEffort === undefined
                ? t('effort.providerDefault')
                : (reasoning.efforts.find((level) => level.id === effectiveEffort)?.name ??
                  effectiveEffort);

        const effortChoices = react.useMemo(
          () =>
            reasoning === undefined
              ? []
              : [
                  ...(reasoning.defaultEffort === undefined
                    ? [
                        {
                          key: 'provider-default',
                          effort: undefined,
                          label: t('effort.providerDefault'),
                        },
                      ]
                    : []),
                  ...reasoning.efforts.map((effort) => ({
                    key: `effort:${effort.id}`,
                    effort: effort.id,
                    label: effort.name,
                  })),
                ],
          [reasoning, t],
        );

        const currentContextWindow = react.useMemo(
          () =>
            resolveModelContextWindow(
              state.current,
              piAiSnapshot,
              deepseekSnapshot,
            ),
          [state.current, piAiSnapshot, deepseekSnapshot],
        );
        const contextWindowLabel = formatContextWindow(currentContextWindow);

        const { pending } = state;
        const busy = pending !== null || contextBusy;

        const reload = () => {
          lastActionRef.current = 'load';
          load();
          describeMirror.ensure?.();
        };

        react.useEffect(() => {
          if (!open) return;
          const closeOutside = (event) => {
            if (rootRef.current?.contains(event.target) === true) return;
            if (menuRef.current?.contains(event.target) === true) return;
            setOpen(false);
          };
          document.addEventListener('mousedown', closeOutside);
          return () => {
            document.removeEventListener('mousedown', closeOutside);
          };
        }, [open]);

        react.useLayoutEffect(() => {
          if (!showSearch) {
            setQuery('');
            setHighlightedIndex(null);
          }
        }, [showSearch]);

        const paneFocus = react.useRef(null);
        const previousShowSearch = react.useRef(showSearch);
        react.useEffect(() => {
          const changedSearchMode = previousShowSearch.current !== showSearch;
          previousShowSearch.current = showSearch;
          const intent =
            paneFocus.current ?? (changedSearchMode && pane === 'model' ? 'drill' : null);
          paneFocus.current = null;
          if (!open || intent === null) return;
          if (intent === 'drill') {
            if (pane === 'model' && showSearch) {
              searchRef.current?.focus();
              return;
            }
            (
              menuRef.current?.querySelector(
                '[role="menuitemradio"][aria-checked="true"]:not([disabled])',
              ) ??
              itemRefs.current.find((item) => item !== null && !item.disabled) ??
              triggerRef.current
            )?.focus();
            return;
          }
          const cellIndex =
            intent === 'effort'
              ? 1
              : intent === 'context'
                ? reasoning !== undefined
                  ? 2
                  : 1
                : 0;
          const cell = itemRefs.current[cellIndex];
          (cell !== null && cell !== undefined && !cell.disabled ? cell : triggerRef.current)?.focus();
        }, [open, pane, showSearch, reasoning]);

        react.useEffect(() => {
          const viewport = groupsRef.current;
          if (viewport === null) return;
          return primitives.observeStickyMenuGroups(viewport);
        }, [available, open, pane, filteredGroups]);

        react.useLayoutEffect(() => {
          if (open && pane === 'model' && activeModelIndex >= 0) {
            itemRefs.current[activeModelIndex]?.scrollIntoView({ block: 'nearest' });
          }
        }, [open, pane, activeModelIndex, visibleModels]);

        react.useLayoutEffect(() => {
          if (!available || !open) {
            setMenuPos(null);
            return;
          }
          const place = () => {
            const rect = triggerRef.current?.getBoundingClientRect();
            if (rect === undefined) return;
            const MARGIN = 12;
            const lw = menuRef.current?.offsetWidth ?? 0;
            const lh = menuRef.current?.offsetHeight ?? 0;
            let x = rect.right - lw;
            let y = rect.top - 8 - lh;
            if (lw > 0) x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN);
            if (lh > 0) y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN);
            setMenuPos({
              left: x,
              top: y,
            });
          };
          place();
          window.addEventListener('scroll', place, true);
          window.addEventListener('resize', place);
          const menu = menuRef.current;
          const observer =
            typeof ResizeObserver !== 'undefined' && menu !== null
              ? new ResizeObserver(place)
              : null;
          if (menu !== null) observer?.observe(menu);
          return () => {
            observer?.disconnect();
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
          };
        }, [available, open, pane, state, query, currentContextWindow]);

        if (!available) return null;

        const show = () => {
          setSelectionFocus(false);
          triggerRef.current?.focus();
          setQuery('');
          setHighlightedIndex(null);
          setCustomInput('');
          if (currentChoice === undefined) paneFocus.current = 'drill';
          setPane(currentChoice === undefined ? 'model' : 'root');
          setOpen(true);
          reload();
        };

        const changeQuery = (next) => {
          setQuery(next);
          setHighlightedIndex(0);
        };

        const close = (restoreFocus = false) => {
          setOpen(false);
          setPane('root');
          if (restoreFocus) {
            queueMicrotask(() => {
              triggerRef.current?.focus();
            });
          }
        };

        const closeAfterSelection = () => {
          setSelectionFocus(true);
          close(true);
        };

        const drill = (next) => {
          setQuery('');
          setHighlightedIndex(null);
          if (next === 'context') {
            setCustomInput('');
          }
          paneFocus.current = 'drill';
          setPane(next);
        };

        const back = (from) => {
          paneFocus.current = from;
          setPane('root');
        };

        const moveFocus = (offset) => {
          const items = itemRefs.current.filter((item) => item !== null && item !== undefined);
          if (items.length === 0) return;
          const active = items.findIndex((item) => item === document.activeElement);
          items[
            active === -1
              ? offset > 0
                ? 0
                : items.length - 1
              : (active + offset + items.length) % items.length
          ]?.focus();
        };

        const settleSelection = (result) => {
          if (result === undefined) return;
          if (result.ok) {
            if (rootRef.current !== null) closeAfterSelection();
            return;
          }
          const { error } = result;
          toastSeq.current += 1;
          setToast({
            seq: toastSeq.current,
            text:
              error.code === 'session/writer-held'
                ? t('error.sessionInUse')
                : t('error.action', { message: `${error.code}: ${error.message}` }),
          });
        };

        const submit = (selection) => {
          lastActionRef.current = 'select';
          setSelectionFocus(true);
          triggerRef.current?.focus();
          select(selection).then(settleSelection);
        };

        const choose = (selection) => {
          if (
            state.current?.provider === selection.provider &&
            state.current.model === selection.model
          ) {
            closeAfterSelection();
            return;
          }
          submit(selection);
        };

        const chooseEffort = (effort) => {
          if (state.current === null) return;
          if (effectiveEffort === effort) {
            closeAfterSelection();
            return;
          }
          submit({
            provider: state.current.provider,
            model: state.current.model,
            ...(effort === undefined ? {} : { reasoningEffort: effort }),
          });
        };

        /**
         * 核心动作：
         * 1. 若从高窗口切向低窗口且当前会话已用 Token 超出目标低窗口的 80% 压缩阈值，
         *    先在原高窗口预算下自动触发 `/compact` 压缩，避免先降窗导致总结请求超限。
         * 2. 将新的 `contextWindow` 及自适应 `maxTokens` 写回 `cordis.patch.yml`。
         * 3. 立即触发 `select(state.current)` 热刷新当前会话上下文容量与进度条。
         */
        const applyContextWindow = async (targetValue) => {
          if (state.current === null || busy) return;
          const parsed =
            typeof targetValue === 'number'
              ? targetValue
              : parseContextWindowInput(String(targetValue));
          if (parsed === undefined || parsed <= 0) return;

          if (parsed === currentContextWindow && !syncAllModels) {
            closeAfterSelection();
            return;
          }

          setContextBusy(true);
          setPendingContextWindow(parsed);
          try {
            const preCompactCheck = shouldCompactBeforeContextWindowChange({
              currentContextWindow,
              nextContextWindow: parsed,
              usedTokens,
            });
            if (
              preCompactCheck.shouldPreCompact &&
              typeof sessionId === 'string' &&
              sessionId.length > 0 &&
              typeof ctx.remote?.commands?.execute === 'function'
            ) {
              setPreCompacting(true);
              try {
                await ctx.remote.commands.execute(sessionId, '/compact', []);
              } catch {
                // 若当前会话正忙或无需压缩，不阻断后续上下文窗口修改
              } finally {
                setPreCompacting(false);
              }
            }

            await describeMirror.ensure?.();
            const currentGroup = groups.find((g) => g.id === state.current?.provider);
            const fallbackModels = currentGroup?.models ?? [];

            const executeMutate = async () => {
              const latestPiAi = piAiForm.getSnapshot();
              const latestDeepSeek = deepseekForm.getSnapshot();
              const req = buildContextWindowMutateRequest({
                selection: state.current,
                nextContextWindow: parsed,
                syncAll: syncAllModels,
                piAiNamespace: latestPiAi,
                deepseekNamespace: latestDeepSeek,
                fallbackGroupModels: fallbackModels,
              });
              return ctx.remote.settings.mutate(req.ns, req.ops, req.revision);
            };

            let res = await executeMutate();
            if (!res.ok && res.error?.code === 'settings/conflict') {
              await describeMirror.load?.();
              res = await executeMutate();
            }

            if (!res.ok) {
              toastSeq.current += 1;
              setToast({
                seq: toastSeq.current,
                text: copy.saveError.replace(
                  '{message}',
                  `${res.error?.code ?? 'error'}: ${res.error?.message ?? 'unknown'}`,
                ),
              });
              return;
            }

            if (res.value && typeof describeMirror.acceptView === 'function') {
              describeMirror.acceptView(res.value);
            }

            // 关键联动：立即重新触发当前会话的 selectModel，使活跃会话重新评估模型 contextWindow 并实时更新右下角进度条
            const currentSelection = {
              provider: state.current.provider,
              model: state.current.model,
              ...(state.current.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: state.current.reasoningEffort }),
            };
            const selectRes = await select(currentSelection);
            if (selectRes && !selectRes.ok) {
              settleSelection(selectRes);
              return;
            }

            closeAfterSelection();
          } catch (err) {
            toastSeq.current += 1;
            setToast({
              seq: toastSeq.current,
              text: copy.saveError.replace(
                '{message}',
                err instanceof Error ? err.message : String(err),
              ),
            });
          } finally {
            setPreCompacting(false);
            setContextBusy(false);
            setPendingContextWindow(null);
          }
        };

        const onRootKeyDown = (event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            if (pane !== 'root' && currentChoice !== undefined) back(pane);
            else close(true);
            return;
          }
          if (!open) return;

          if (pane === 'context' && event.target === customInputRef.current) {
            if (event.key === 'Enter') {
              event.preventDefault();
              const parsed = parseContextWindowInput(customInput);
              if (parsed !== undefined && !busy) {
                applyContextWindow(parsed);
              }
              return;
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              moveFocus(event.key === 'ArrowDown' ? 1 : -1);
              return;
            }
          }

          if (
            pane === 'model' &&
            showSearch &&
            (event.key === 'ArrowDown' || event.key === 'ArrowUp')
          ) {
            event.preventDefault();
            if (!busy && visibleModels.length > 0) {
              setHighlightedIndex(
                (activeModelIndex + (event.key === 'ArrowDown' ? 1 : -1) + visibleModels.length) %
                  visibleModels.length,
              );
              searchRef.current?.focus();
            }
            return;
          }
          if (
            pane === 'model' &&
            showSearch &&
            event.target instanceof HTMLInputElement &&
            (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))
          ) {
            if (event.key === 'Tab' && visibleModels.length === 0) return;
            event.preventDefault();
            const highlighted = visibleModels[activeModelIndex];
            if (!busy && highlighted !== undefined) choose(highlighted);
            return;
          }
          if (event.key === 'Tab') {
            if (event.shiftKey) {
              event.preventDefault();
              if (pane !== 'root' && currentChoice !== undefined) back(pane);
              else close(true);
              return;
            }
            const focused = document.activeElement;
            const rows = itemRefs.current.filter((item) => item !== null && item !== undefined);
            if (focused instanceof HTMLButtonElement && rows.includes(focused)) {
              event.preventDefault();
              focused.click();
              return;
            }
            if (focused !== triggerRef.current) return;
            event.preventDefault();
            if (pane === 'model' && showSearch) {
              setHighlightedIndex(null);
              searchRef.current?.focus();
              return;
            }
            (
              menuRef.current?.querySelector(
                '[role="menuitemradio"][aria-checked="true"]:not([disabled])',
              ) ?? rows.find((item) => !item.disabled)
            )?.focus();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveFocus(event.key === 'ArrowDown' ? 1 : -1);
            return;
          }
          if (
            pane === 'root' &&
            event.key === 'ArrowRight' &&
            document.activeElement instanceof HTMLButtonElement
          ) {
            event.preventDefault();
            document.activeElement.click();
            return;
          }
          if (
            pane !== 'root' &&
            event.key === 'ArrowLeft' &&
            !(event.target instanceof HTMLInputElement) &&
            currentChoice !== undefined
          ) {
            event.preventDefault();
            back(pane);
          }
        };

        const onBlur = (event) => {
          if (
            event.relatedTarget instanceof Node &&
            (rootRef.current?.contains(event.relatedTarget) === true ||
              menuRef.current?.contains(event.relatedTarget) === true)
          ) {
            return;
          }
          close();
        };

        const waiting = state.status === 'loading' && state.current === null;
        const modelLabel =
          currentChoice?.model.name ??
          (waiting
            ? t('trigger.loading')
            : state.current === null
              ? t('trigger.select')
              : state.current.model);

        const showTriggerCw = pluginEnabled && showInTrigger && currentChoice !== undefined;
        const triggerParts = [modelLabel];
        if (effortLabel !== undefined) triggerParts.push(effortLabel);
        if (showTriggerCw) triggerParts.push(contextWindowLabel);
        const triggerLabel = triggerParts.join(' · ');

        const triggerAria = waiting
          ? t('trigger.loading')
          : currentChoice === undefined
            ? t('trigger.selectAria')
            : effortLabel === undefined
              ? t('trigger.aria', { model: modelLabel })
              : t('trigger.ariaEffort', {
                  model: modelLabel,
                  effort: effortLabel,
                });

        const renderModelLabel = (provider, model, placement, selected) =>
          jsxRuntime.jsx('span', {
            'data-provider-id': provider.id,
            'data-model-id': model.id,
            children:
              typeof renderSlot === 'function'
                ? renderSlot(
                    'conversation.input.model.context-window.label',
                    {
                      provider,
                      model,
                      placement,
                      selected,
                    },
                    { fallback: model.name },
                  )
                : model.name,
          });

        itemRefs.current = [];
        let itemIndex = 0;
        let modelIndex = 0;
        const itemRef = () => {
          const at = itemIndex++;
          return (node) => {
            itemRefs.current[at] = node;
          };
        };

        const parsedCustomValue = parseContextWindowInput(customInput);

        return jsxRuntime.jsxs('div', {
          ref: rootRef,
          className: ModelSelectStyles.root,
          onKeyDown: onRootKeyDown,
          onBlur,
          onMouseDown: (event) => {
            if (
              event.target instanceof Element &&
              event.target.closest('button') !== null
            ) {
              event.preventDefault();
            }
          },
          children: [
            jsxRuntime.jsxs('button', {
              ref: triggerRef,
              type: 'button',
              className: ModelSelectStyles.trigger,
              'aria-label': triggerAria,
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              'aria-controls': open ? `${id}-menu` : undefined,
              title: triggerLabel,
              'aria-busy': busy,
              'data-selection-focus': selectionFocus ? '' : undefined,
              onBlur: () => {
                setSelectionFocus(false);
              },
              disabled: locked,
              onClick: () => {
                if (open) close(true);
                else show();
              },
              children: [
                jsxRuntime.jsx(primitives.IconDataOutlineRegular, {
                  className: ModelSelectStyles.triggerIcon,
                  size: 16,
                }),
                jsxRuntime.jsx('span', {
                  className: ModelSelectStyles.triggerLabel,
                  children:
                    currentChoice === undefined
                      ? modelLabel
                      : renderModelLabel(
                          currentChoice.group.provider,
                          currentChoice.model,
                          'trigger',
                          true,
                        ),
                }),
                effortLabel !== undefined &&
                  jsxRuntime.jsx('span', {
                    className: ModelSelectStyles.triggerEffort,
                    children: effortLabel,
                  }),
                showTriggerCw &&
                  jsxRuntime.jsx('span', {
                    className: ModelSelectStyles.triggerEffort,
                    'data-context-window': currentContextWindow,
                    children: contextWindowLabel,
                  }),
                busy
                  ? jsxRuntime.jsx(primitives.StateDot, { state: 'ongoing' })
                  : jsxRuntime.jsx(primitives.IconChevronDownOutlineRegular, {
                      className: clsx(
                        ModelSelectStyles.chevron,
                        open && ModelSelectStyles.chevronOpen,
                      ),
                    }),
              ],
            }),
            open &&
              reactDom.createPortal(
                jsxRuntime.jsxs(primitives.MenuSurface, {
                  ref: menuRef,
                  id: `${id}-menu`,
                  className: ModelSelectStyles.menu,
                  style: menuPos ?? MEASURE_STYLE,
                  role: pane === 'model' ? 'group' : 'menu',
                  'aria-label': t('menu.aria'),
                  'aria-busy': state.status === 'loading' || busy,
                  children: [
                    pane === 'root' &&
                      jsxRuntime.jsxs(jsxRuntime.Fragment, {
                        children: [
                          jsxRuntime.jsxs('button', {
                            ref: itemRef(),
                            type: 'button',
                            role: 'menuitem',
                            className: ModelSelectStyles.cell,
                            onClick: () => {
                              drill('model');
                            },
                            children: [
                              jsxRuntime.jsx('span', {
                                className: ModelSelectStyles.cellLabel,
                                children: t('menu.model'),
                              }),
                              jsxRuntime.jsx('span', {
                                className: ModelSelectStyles.cellValue,
                                children:
                                  currentChoice === undefined
                                    ? modelLabel
                                    : renderModelLabel(
                                        currentChoice.group.provider,
                                        currentChoice.model,
                                        'menu',
                                        true,
                                      ),
                              }),
                              jsxRuntime.jsx(primitives.IconChevronRightOutlineRegular, {
                                className: ModelSelectStyles.cellChevron,
                              }),
                            ],
                          }),
                          reasoning !== undefined &&
                            jsxRuntime.jsxs('button', {
                              ref: itemRef(),
                              type: 'button',
                              role: 'menuitem',
                              className: ModelSelectStyles.cell,
                              onClick: () => {
                                drill('effort');
                              },
                              children: [
                                jsxRuntime.jsx('span', {
                                  className: ModelSelectStyles.cellLabel,
                                  children: t('menu.effort'),
                                }),
                                jsxRuntime.jsx('span', {
                                  className: ModelSelectStyles.cellValue,
                                  children: effortLabel,
                                }),
                                jsxRuntime.jsx(primitives.IconChevronRightOutlineRegular, {
                                  className: ModelSelectStyles.cellChevron,
                                }),
                              ],
                            }),
                          pluginEnabled &&
                            currentChoice !== undefined &&
                            jsxRuntime.jsxs('button', {
                              ref: itemRef(),
                              type: 'button',
                              role: 'menuitem',
                              className: ModelSelectStyles.cell,
                              'data-context-window-cell': 'true',
                              onClick: () => {
                                drill('context');
                              },
                              children: [
                                jsxRuntime.jsx('span', {
                                  className: ModelSelectStyles.cellLabel,
                                  children: copy.contextWindowLabel,
                                }),
                                jsxRuntime.jsx('span', {
                                  className: ModelSelectStyles.cellValue,
                                  children: contextWindowLabel,
                                }),
                                jsxRuntime.jsx(primitives.IconChevronRightOutlineRegular, {
                                  className: ModelSelectStyles.cellChevron,
                                }),
                              ],
                            }),
                        ],
                      }),
                    pane === 'model' &&
                      jsxRuntime.jsxs(jsxRuntime.Fragment, {
                        children: [
                          showSearch &&
                            jsxRuntime.jsxs('div', {
                              className: ModelSelectStyles.searchRow,
                              children: [
                                jsxRuntime.jsx(primitives.Input, {
                                  ref: searchRef,
                                  className: clsx(
                                    ModelSelectStyles.search,
                                    query !== '' && ModelSelectStyles.searchWithQuery,
                                  ),
                                  type: 'text',
                                  role: 'searchbox',
                                  'aria-label': t('search.placeholder'),
                                  'aria-controls': `${id}-models`,
                                  'aria-activedescendant':
                                    activeModelIndex < 0
                                      ? undefined
                                      : `${id}-model-${activeModelIndex}`,
                                  placeholder: t('search.placeholder'),
                                  value: query,
                                  readOnly: busy,
                                  onChange: (event) => {
                                    changeQuery(event.target.value);
                                  },
                                }),
                                query !== '' &&
                                  jsxRuntime.jsx('button', {
                                    type: 'button',
                                    className: ModelSelectStyles.searchClear,
                                    'aria-label': t('search.clear'),
                                    disabled: busy,
                                    onClick: () => {
                                      changeQuery('');
                                      searchRef.current?.focus();
                                    },
                                    children: jsxRuntime.jsx(
                                      primitives.IconCloseFillRegular,
                                      {},
                                    ),
                                  }),
                              ],
                            }),
                          state.status === 'loading' &&
                            jsxRuntime.jsx('div', {
                              className: ModelSelectStyles.status,
                              children: t('status.loading'),
                            }),
                          state.error !== null &&
                            lastActionRef.current === 'load' &&
                            jsxRuntime.jsxs('div', {
                              className: ModelSelectStyles.error,
                              children: [
                                jsxRuntime.jsx('span', {
                                  children: t('error.action', { message: state.error }),
                                }),
                                jsxRuntime.jsx('button', {
                                  type: 'button',
                                  className: ModelSelectStyles.retry,
                                  onClick: reload,
                                  children: t('retry'),
                                }),
                              ],
                            }),
                          state.failures.map((failure) =>
                            jsxRuntime.jsxs(
                              'div',
                              {
                                className: ModelSelectStyles.warning,
                                children: [
                                  jsxRuntime.jsx('span', {
                                    children: t('warning.groupLoad', {
                                      name:
                                        failure.id === 'deepseek-account'
                                          ? t('provider.account')
                                          : failure.name,
                                      message: failure.message,
                                    }),
                                  }),
                                  jsxRuntime.jsx('button', {
                                    type: 'button',
                                    className: ModelSelectStyles.retry,
                                    onClick: reload,
                                    children: t('retry'),
                                  }),
                                ],
                              },
                              failure.id,
                            ),
                          ),
                          jsxRuntime.jsx('div', {
                            ref: groupsRef,
                            id: `${id}-models`,
                            className: clsx(ModelSelectStyles.groups, 'scrollable'),
                            role: 'menu',
                            'aria-label': t('menu.model'),
                            hidden: filteredGroups.length === 0,
                            children: filteredGroups.map((group) =>
                              jsxRuntime.jsx(
                                primitives.MenuGroup,
                                {
                                  label: group.provider.name,
                                  children: group.models.map((model) => {
                                    const index = modelIndex++;
                                    const selected =
                                      state.current?.provider === group.id &&
                                      state.current.model === model.id;
                                    return jsxRuntime.jsxs(
                                      'button',
                                      {
                                        ref: itemRef(),
                                        type: 'button',
                                        role: 'menuitemradio',
                                        'aria-checked': selected,
                                        id: `${id}-model-${index}`,
                                        tabIndex: showSearch ? -1 : 0,
                                        onFocus: () => {
                                          setHighlightedIndex(index);
                                        },
                                        'data-highlighted':
                                          index === activeModelIndex ? '' : undefined,
                                        className: clsx(
                                          ModelSelectStyles.option,
                                          ModelSelectStyles.modelOption,
                                          selected && ModelSelectStyles.selected,
                                          index === activeModelIndex &&
                                            ModelSelectStyles.optionActive,
                                        ),
                                        onMouseMove:
                                          busy || index === activeModelIndex
                                            ? undefined
                                            : () => {
                                                if (showSearch) setHighlightedIndex(index);
                                                else itemRefs.current[index]?.focus();
                                              },
                                        title: model.name,
                                        disabled: busy,
                                        onClick: () => {
                                          choose({
                                            provider: group.id,
                                            model: model.id,
                                          });
                                        },
                                        children: [
                                          jsxRuntime.jsx('span', {
                                            className: ModelSelectStyles.optionCopy,
                                            children: jsxRuntime.jsx('span', {
                                              className: ModelSelectStyles.modelName,
                                              children: renderModelLabel(
                                                group.provider,
                                                model,
                                                'option',
                                                selected,
                                              ),
                                            }),
                                          }),
                                          jsxRuntime.jsx('span', {
                                            className: ModelSelectStyles.check,
                                            children:
                                              pending?.provider === group.id &&
                                              pending.model === model.id
                                                ? jsxRuntime.jsx(primitives.StateDot, {
                                                    state: 'ongoing',
                                                  })
                                                : selected && CheckIcon
                                                  ? jsxRuntime.jsx(CheckIcon, {})
                                                  : null,
                                          }),
                                        ],
                                      },
                                      model.id,
                                    );
                                  }),
                                },
                                group.id,
                              ),
                            ),
                          }),
                          state.status === 'ready' &&
                            filteredGroups.length === 0 &&
                            jsxRuntime.jsx('div', {
                              className: ModelSelectStyles.empty,
                              role: 'status',
                              children: t(
                                choices.length === 0 ? 'empty.models' : 'search.empty',
                              ),
                            }),
                        ],
                      }),
                    pane === 'effort' &&
                      jsxRuntime.jsxs(jsxRuntime.Fragment, {
                        children: [
                          state.error !== null &&
                            lastActionRef.current === 'load' &&
                            jsxRuntime.jsxs('div', {
                              className: ModelSelectStyles.error,
                              children: [
                                jsxRuntime.jsx('span', {
                                  children: t('error.action', { message: state.error }),
                                }),
                                jsxRuntime.jsx('button', {
                                  type: 'button',
                                  className: ModelSelectStyles.retry,
                                  onClick: reload,
                                  children: t('action.reload'),
                                }),
                              ],
                            }),
                          effortChoices.length === 0
                            ? jsxRuntime.jsx('div', {
                                className: ModelSelectStyles.empty,
                                children: t('empty.efforts'),
                              })
                            : effortChoices.map((level) =>
                                jsxRuntime.jsxs(
                                  'button',
                                  {
                                    ref: itemRef(),
                                    type: 'button',
                                    role: 'menuitemradio',
                                    'aria-checked': effectiveEffort === level.effort,
                                    className: clsx(
                                      ModelSelectStyles.option,
                                      effectiveEffort === level.effort &&
                                        ModelSelectStyles.selected,
                                    ),
                                    disabled: busy,
                                    onClick: () => {
                                      chooseEffort(level.effort);
                                    },
                                    children: [
                                      jsxRuntime.jsx('span', {
                                        className: ModelSelectStyles.optionCopy,
                                        children: jsxRuntime.jsx('span', {
                                          className: ModelSelectStyles.modelName,
                                          children: level.label,
                                        }),
                                      }),
                                      jsxRuntime.jsx('span', {
                                        className: ModelSelectStyles.check,
                                        children:
                                          pending !== null &&
                                          pending.provider === state.current?.provider &&
                                          pending.model === state.current.model &&
                                          pending.reasoningEffort === level.effort
                                            ? jsxRuntime.jsx(primitives.StateDot, {
                                                state: 'ongoing',
                                              })
                                            : effectiveEffort === level.effort && CheckIcon
                                              ? jsxRuntime.jsx(CheckIcon, {})
                                              : null,
                                      }),
                                    ],
                                  },
                                  level.key,
                                ),
                              ),
                        ],
                      }),
                    pane === 'context' &&
                      jsxRuntime.jsxs(jsxRuntime.Fragment, {
                        children: [
                          preCompacting &&
                            jsxRuntime.jsx('div', {
                              className: 'dsh-cw-compact-status',
                              role: 'status',
                              children: copy.preCompactingStatus,
                            }),
                          CONTEXT_WINDOW_PRESETS.map((preset) => {
                            const isSelected = currentContextWindow === preset.value;
                            const isPending =
                              contextBusy && pendingContextWindow === preset.value;
                            const willAutoCompact =
                              shouldCompactBeforeContextWindowChange({
                                currentContextWindow,
                                nextContextWindow: preset.value,
                                usedTokens,
                              }).shouldPreCompact;
                            return jsxRuntime.jsxs(
                              'button',
                              {
                                ref: itemRef(),
                                type: 'button',
                                role: 'menuitemradio',
                                'aria-checked': isSelected,
                                'data-context-preset': preset.label,
                                className: clsx(
                                  ModelSelectStyles.option,
                                  isSelected && ModelSelectStyles.selected,
                                ),
                                disabled: busy,
                                onClick: () => {
                                  applyContextWindow(preset.value);
                                },
                                children: [
                                  jsxRuntime.jsx('span', {
                                    className: ModelSelectStyles.optionCopy,
                                    children: jsxRuntime.jsxs('span', {
                                      className: ModelSelectStyles.modelName,
                                      children: [
                                        preset.label,
                                        jsxRuntime.jsx('span', {
                                          className: 'dsh-cw-preset-tokens',
                                          children: `(${preset.value.toLocaleString()})`,
                                        }),
                                        willAutoCompact &&
                                          jsxRuntime.jsx('span', {
                                            className: 'dsh-cw-compact-badge',
                                            children: copy.autoCompactBadge,
                                          }),
                                      ],
                                    }),
                                  }),
                                  jsxRuntime.jsx('span', {
                                    className: ModelSelectStyles.check,
                                    children: isPending
                                      ? jsxRuntime.jsx(primitives.StateDot, {
                                          state: 'ongoing',
                                        })
                                      : isSelected && CheckIcon
                                        ? jsxRuntime.jsx(CheckIcon, {})
                                        : null,
                                  }),
                                ],
                              },
                              preset.key,
                            );
                          }),
                          jsxRuntime.jsxs('div', {
                            className: 'dsh-cw-custom-section',
                            onMouseDown: (e) => {
                              e.stopPropagation();
                            },
                            children: [
                              jsxRuntime.jsxs('div', {
                                className: 'dsh-cw-custom-row',
                                children: [
                                  jsxRuntime.jsx(primitives.Input, {
                                    ref: customInputRef,
                                    className: 'dsh-cw-custom-input',
                                    type: 'text',
                                    placeholder: copy.customPlaceholder,
                                    'aria-label': copy.customPlaceholder,
                                    value: customInput,
                                    readOnly: busy,
                                    onChange: (event) => {
                                      setCustomInput(event.target.value);
                                    },
                                  }),
                                  jsxRuntime.jsx('button', {
                                    type: 'button',
                                    className: 'dsh-cw-custom-apply',
                                    disabled: busy || parsedCustomValue === undefined,
                                    onClick: () => {
                                      if (parsedCustomValue !== undefined) {
                                        applyContextWindow(parsedCustomValue);
                                      }
                                    },
                                    children: copy.applyBtn,
                                  }),
                                ],
                              }),
                              jsxRuntime.jsxs('label', {
                                className: 'dsh-cw-sync-toggle',
                                children: [
                                  jsxRuntime.jsx('span', {
                                    children: copy.syncAllLabel,
                                  }),
                                  jsxRuntime.jsx('input', {
                                    type: 'checkbox',
                                    className: 'dsh-cw-sync-checkbox',
                                    checked: syncAllModels,
                                    disabled: busy,
                                    onChange: (event) => {
                                      setSyncAllModels(event.target.checked);
                                    },
                                  }),
                                ],
                              }),
                            ],
                          }),
                        ],
                      }),
                  ],
                }),
                document.body,
              ),
            toast !== null &&
              jsxRuntime.jsx(
                primitives.Toast,
                {
                  text: toast.text,
                  icon: jsxRuntime.jsx(primitives.IconWarningOutlineRegular, {}),
                  anchor: rootRef.current?.closest('[data-composer-card]') ?? null,
                  onDone: () => {
                    setToast(null);
                  },
                },
                toast.seq,
              ),
          ],
        });
      };
    }

    function ReactLangKey(localeSnapshot) {
      const raw = String(
        localeSnapshot?.locale ?? localeSnapshot?.language ?? 'zh',
      ).toLowerCase();
      return raw.startsWith('en') ? 'en' : 'zh';
    }

    function ContextWindowSettingsCard(props) {
      const { t } = props;
      const state = props.useContextWindowConfig((s) => s);
      if (props.view === 'summary') return t('description');
      const disabled = !state.writable || state.status !== 'ready';
      const val = state.value ?? {};

      const rowStyle = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '20px',
        padding: '12px 0',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
      };
      const titleStyle = { fontSize: '14px', lineHeight: '20px', fontWeight: 500 };
      const hintStyle = {
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        marginTop: '3px',
      };

      return jsxRuntime.jsxs('div', {
        style: { display: 'flex', flexDirection: 'column' },
        children: [
          jsxRuntime.jsxs('div', {
            style: rowStyle,
            children: [
              jsxRuntime.jsxs('div', {
                children: [
                  jsxRuntime.jsx('div', { style: titleStyle, children: t('enabled') }),
                  jsxRuntime.jsx('div', { style: hintStyle, children: t('enabledHint') }),
                ],
              }),
              jsxRuntime.jsx(primitives.Switch, {
                checked: val.enabled !== false,
                label: t('enabled'),
                disabled,
                onChange: (checked) => {
                  props.setField('enabled', checked);
                },
              }),
            ],
          }),
          jsxRuntime.jsxs('div', {
            style: rowStyle,
            children: [
              jsxRuntime.jsxs('div', {
                children: [
                  jsxRuntime.jsx('div', {
                    style: titleStyle,
                    children: t('showInTrigger'),
                  }),
                  jsxRuntime.jsx('div', {
                    style: hintStyle,
                    children: t('showInTriggerHint'),
                  }),
                ],
              }),
              jsxRuntime.jsx(primitives.Switch, {
                checked: val.showInTrigger !== false,
                label: t('showInTrigger'),
                disabled,
                onChange: (checked) => {
                  props.setField('showInTrigger', checked);
                },
              }),
            ],
          }),
          jsxRuntime.jsxs('div', {
            style: { ...rowStyle, borderBottom: 'none' },
            children: [
              jsxRuntime.jsxs('div', {
                children: [
                  jsxRuntime.jsx('div', {
                    style: titleStyle,
                    children: t('defaultSyncAllProviderModels'),
                  }),
                  jsxRuntime.jsx('div', {
                    style: hintStyle,
                    children: t('defaultSyncAllProviderModelsHint'),
                  }),
                ],
              }),
              jsxRuntime.jsx(primitives.Switch, {
                checked: val.defaultSyncAllProviderModels !== false,
                label: t('defaultSyncAllProviderModels'),
                disabled,
                onChange: (checked) => {
                  props.setField('defaultSyncAllProviderModels', checked);
                },
              }),
            ],
          }),
        ],
      });
    }

    const inject = [
      'slots',
      'locale',
      'sessions',
      'configForms',
      'remote',
      'remote.session',
      'remote.settings',
    ];

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(SETTINGS_NS, {
            zh: SETTINGS_LOCALE.zh,
            en: SETTINGS_LOCALE.en,
          }),
        'dsh-context-window: settings locale',
      );

      const pluginForm = ctx.configForms.get(PLUGIN_NS);
      const cardInject = () => ({
        hooks: {
          contextWindowConfig: pluginForm,
        },
        setField: (field, value) => {
          pluginForm.set(field, value).catch(() => {});
        },
      });

      ctx.effect(
        () =>
          ctx.configForms.whileServed([PLUGIN_NS], () =>
            ctx.slots.inject('plugins.bundle.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.bundle.config',
                  key: BUNDLE_KEY,
                  locale: SETTINGS_NS,
                  inject: cardInject,
                },
                ContextWindowSettingsCard,
              ),
            ),
          ),
        'dsh-context-window: bundle config page',
      );

      ctx.effect(
        () =>
          ctx.configForms.whileServed([PLUGIN_NS], () =>
            ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.row.config',
                  key: ROW_KEY,
                  locale: SETTINGS_NS,
                  inject: cardInject,
                },
                ContextWindowSettingsCard,
              ),
            ),
          ),
        'dsh-context-window: row config page',
      );

      const EnhancedModelSelect = createEnhancedModelSelect(ctx);

      ctx.inject(['slots', 'modelDirectories'], (scope) => {
        const models = scope.modelDirectories;
        const sessions = scope.sessions;
        scope.slots.inject('conversation.input.model', () =>
          scope.slots.register(
            {
              name: 'conversation.input.model',
              priority: -10,
              locale: MODEL_NS,
              children: {
                'conversation.input.model.context-window.label': {
                  kind: 'single',
                  scope: 'session',
                  inline: true,
                },
              },
              inject: (sessionId) => {
                const directory = models.directoryFor(sessionId);
                const available = sessions.subagentAddress(sessionId) === undefined;
                return {
                  sessionId,
                  available,
                  directory: directory.store,
                  load: () => {
                    if (available) directory.load().catch(() => {});
                  },
                  select: (selection) =>
                    available ? directory.select(selection) : Promise.resolve(undefined),
                };
              },
            },
            EnhancedModelSelect,
          ),
        );
      });
    }

    exports.name = PLUGIN_NS;
    exports.inject = inject;
    exports.apply = apply;
    exports.CONTEXT_WINDOW_PRESETS = CONTEXT_WINDOW_PRESETS;
    exports.computeAdaptiveCompactionBudget = computeAdaptiveCompactionBudget;
    exports.shouldCompactBeforeContextWindowChange = shouldCompactBeforeContextWindowChange;
    exports.formatContextWindow = formatContextWindow;
    exports.parseContextWindowInput = parseContextWindowInput;
    exports.resolveModelContextWindow = resolveModelContextWindow;
    exports.buildUpdatedProviderModels = buildUpdatedProviderModels;
    exports.buildContextWindowMutateRequest = buildContextWindowMutateRequest;
    exports.createEnhancedModelSelect = createEnhancedModelSelect;
    return module.exports;
  }

  if (
    typeof window !== 'undefined' &&
    window.__ModuleLoader__ &&
    typeof window.__ModuleLoader__.load === 'function'
  ) {
    window.__ModuleLoader__.load({
      id: MODULE_ID,
      factory: buildModule,
    });
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.__DSH_CONTEXT_WINDOW_BUILD__ = buildModule;
  }
})();
