import assert from 'node:assert/strict';
import test from 'node:test';

import plugin, {
  CONTEXT_WINDOW_PRESETS,
  Config,
  DEFAULT_CONTEXT_WINDOW,
  apply,
  buildContextWindowMutateRequest,
  buildUpdatedProviderModels,
  computeAdaptiveCompactionBudget,
  formatContextWindow,
  normalizeConfig,
  parseContextWindowInput,
  resolveModelContextWindow,
  shouldCompactBeforeContextWindowChange,
} from '../lib/index.js';
import '../lib/client.js';

const TOKENS_512K = 512 * 1024;

test('formatContextWindow formats 1024-based, 1000-based, and custom token counts', () => {
  assert.equal(formatContextWindow(65536), '64K');
  assert.equal(formatContextWindow(131072), '128K');
  assert.equal(formatContextWindow(262144), '256K');
  assert.equal(formatContextWindow(TOKENS_512K), '512K');
  assert.equal(formatContextWindow(1048576), '1M');
  assert.equal(formatContextWindow(2097152), '2M');
  assert.equal(formatContextWindow(300000), '300K');
  assert.equal(formatContextWindow(1000000), '1M');
  assert.equal(formatContextWindow(123456), '123456');
  assert.equal(formatContextWindow(undefined), '256K');
  assert.equal(formatContextWindow(-100), '256K');
});

test('parseContextWindowInput parses positive integers and k/m shorthand in base-1024', () => {
  assert.equal(parseContextWindowInput('300000'), 300000);
  assert.equal(parseContextWindowInput('262,144'), 262144);
  assert.equal(parseContextWindowInput('64k'), 65536);
  assert.equal(parseContextWindowInput('128K'), 131072);
  assert.equal(parseContextWindowInput('256k'), 262144);
  assert.equal(parseContextWindowInput('500k'), 512000);
  assert.equal(parseContextWindowInput('1m'), 1048576);
  assert.equal(parseContextWindowInput('2M'), 2097152);
  assert.equal(parseContextWindowInput('1.5m'), 1572864);
  assert.equal(parseContextWindowInput(''), undefined);
  assert.equal(parseContextWindowInput('0'), undefined);
  assert.equal(parseContextWindowInput('-256k'), undefined);
  assert.equal(parseContextWindowInput('abc'), undefined);
});

test('CONTEXT_WINDOW_PRESETS contains expected 64K to 2M tiers', () => {
  assert.deepEqual(
    CONTEXT_WINDOW_PRESETS.map((p) => [p.label, p.value]),
    [
      ['64K', 65536],
      ['128K', 131072],
      ['256K', 262144],
      ['512K', TOKENS_512K],
      ['1M', 1048576],
      ['2M', 2097152],
    ],
  );
});

test('computeAdaptiveCompactionBudget prevents budget inversion across all presets including 64K and 128K', () => {
  for (const preset of CONTEXT_WINDOW_PRESETS) {
    const budget = computeAdaptiveCompactionBudget(preset.value);
    const messageBudgetTokens = preset.value - budget.maxSafeCompletionTokens;
    const pressureBudgetTokens = messageBudgetTokens - budget.headroomTokens;
    assert.ok(
      messageBudgetTokens > 0,
      `Expected positive messageBudgetTokens for ${preset.label}`,
    );
    assert.ok(
      pressureBudgetTokens > 0,
      `Expected positive pressureBudgetTokens for ${preset.label}`,
    );
    assert.equal(
      budget.thresholdTokens,
      Math.floor(preset.value * 0.8),
      `Expected 80% thresholdTokens for ${preset.label}`,
    );
  }

  const b64k = computeAdaptiveCompactionBudget(65536);
  assert.equal(b64k.maxSafeCompletionTokens, 8192);
  assert.equal(b64k.headroomTokens, 4915);
  assert.equal(b64k.thresholdTokens, 52428);

  const b128k = computeAdaptiveCompactionBudget(131072);
  assert.equal(b128k.maxSafeCompletionTokens, 16384);
  assert.equal(b128k.headroomTokens, 9830);
  assert.equal(b128k.thresholdTokens, 104857);
});

test('shouldCompactBeforeContextWindowChange detects when lowering window below active session token usage', () => {
  const needsCompact = shouldCompactBeforeContextWindowChange({
    currentContextWindow: 262144,
    nextContextWindow: 65536,
    usedTokens: 60000,
  });
  assert.equal(needsCompact.shouldPreCompact, true);
  assert.equal(needsCompact.nextThresholdTokens, 52428);

  const noNeedLowUsage = shouldCompactBeforeContextWindowChange({
    currentContextWindow: 262144,
    nextContextWindow: 65536,
    usedTokens: 20000,
  });
  assert.equal(noNeedLowUsage.shouldPreCompact, false);

  const raisingWindow = shouldCompactBeforeContextWindowChange({
    currentContextWindow: 65536,
    nextContextWindow: 262144,
    usedTokens: 60000,
  });
  assert.equal(raisingWindow.shouldPreCompact, false);
});

test('resolveModelContextWindow reads from user, value, or base layers of llm-pi-ai', () => {
  const selection = { provider: 'ollama', model: 'qwen3-coder:latest' };
  const piAiNamespace = {
    user: {
      providers: {
        ollama: {
          models: [
            { id: 'qwen3-coder:latest', contextWindow: TOKENS_512K },
            { id: 'deepseek-r1:latest', contextWindow: 262144 },
          ],
        },
      },
    },
  };
  assert.equal(resolveModelContextWindow(selection, piAiNamespace), TOKENS_512K);
  assert.equal(
    resolveModelContextWindow(
      { provider: 'ollama', model: 'deepseek-r1:latest' },
      piAiNamespace,
    ),
    262144,
  );
  assert.equal(resolveModelContextWindow(null, piAiNamespace), DEFAULT_CONTEXT_WINDOW);
});

test('buildUpdatedProviderModels scales maxTokens on low windows (64K/128K) and restores when raised back to >=256K', () => {
  const sourceModels = [
    { id: 'qwen3-coder:latest', contextWindow: 262144 },
    { id: 'deepseek-r1:latest', contextWindow: 262144 },
  ];

  const lowered64k = buildUpdatedProviderModels(
    sourceModels,
    'qwen3-coder:latest',
    65536,
    true,
  );
  assert.deepEqual(lowered64k, [
    { id: 'qwen3-coder:latest', contextWindow: 65536, maxTokens: 8192 },
    { id: 'deepseek-r1:latest', contextWindow: 65536, maxTokens: 8192 },
  ]);

  const raisedBack256k = buildUpdatedProviderModels(
    lowered64k,
    'qwen3-coder:latest',
    262144,
    true,
  );
  assert.deepEqual(raisedBack256k, [
    { id: 'qwen3-coder:latest', contextWindow: 262144 },
    { id: 'deepseek-r1:latest', contextWindow: 262144 },
  ]);

  const singleOnly = buildUpdatedProviderModels(
    sourceModels,
    'qwen3-coder:latest',
    TOKENS_512K,
    false,
  );
  assert.deepEqual(singleOnly, [
    { id: 'qwen3-coder:latest', contextWindow: TOKENS_512K },
    { id: 'deepseek-r1:latest', contextWindow: 262144 },
  ]);
});

test('buildContextWindowMutateRequest builds llm-pi-ai mutate payload with revision', () => {
  const piAiNamespace = {
    revision: 'rev-42',
    user: {
      providers: {
        ollama: {
          models: [
            { id: 'qwen3-coder:latest', contextWindow: 262144 },
            { id: 'deepseek-r1:latest', contextWindow: 262144 },
          ],
        },
      },
    },
  };

  const req = buildContextWindowMutateRequest({
    selection: { provider: 'ollama', model: 'qwen3-coder:latest' },
    nextContextWindow: '512k',
    syncAll: true,
    piAiNamespace,
  });

  assert.equal(req.ns, 'llm-pi-ai');
  assert.equal(req.revision, 'rev-42');
  assert.deepEqual(req.ops, [
    {
      op: 'set',
      path: ['providers', 'ollama', 'models'],
      value: [
        { id: 'qwen3-coder:latest', contextWindow: TOKENS_512K },
        { id: 'deepseek-r1:latest', contextWindow: TOKENS_512K },
      ],
    },
  ]);
});

test('host plugin syncs compaction policy and clamps stale requestHeader.maxTokens on low windows', async () => {
  assert.equal(plugin.name, 'context-window');
  assert.equal(typeof Config, 'function');
  assert.deepEqual(normalizeConfig({}), {
    enabled: true,
    showInTrigger: true,
    defaultSyncAllProviderModels: true,
  });

  let observedMaxTokensInCompaction = null;
  let observedPolicyInCompaction = null;
  const fakeCompaction = {
    config: {
      thresholdRatio: 0.8,
      headroomTokens: 65536,
      retainRatio: 0.16,
      maxTokens: 65536,
      compactionRetries: 1,
      maxOverflowRetries: 1,
      modelPolicies: [],
    },
    warnedPressureConfigTargets: new Set(['ollama/qwen3-coder:latest']),
    async compactIfNeeded(agent) {
      observedMaxTokensInCompaction = agent.session.requestHeader().config.maxTokens;
      observedPolicyInCompaction = this.config.modelPolicies.find(
        (p) => p.provider === 'ollama' && p.model === 'qwen3-coder:latest',
      );
      return null;
    },
  };

  const fakeSession = {
    requestHeader() {
      return {
        config: {
          provider: 'ollama',
          model: 'qwen3-coder:latest',
          maxTokens: 256000,
        },
      };
    },
  };

  let disposeEffect = null;
  apply({
    get(key) {
      if (key === 'compaction') return fakeCompaction;
      if (key === 'llm') {
        return {
          async resolveModelInfo() {
            return { context: { contextWindow: 65536 }, defaultMaxTokens: 8192 };
          },
        };
      }
      return undefined;
    },
    effect(fn) {
      disposeEffect = fn();
    },
    on() {
      return () => {};
    },
  });

  await fakeCompaction.compactIfNeeded({ session: fakeSession }, 'pressure', undefined);

  assert.equal(observedMaxTokensInCompaction, 8192);
  assert.equal(fakeSession.requestHeader().config.maxTokens, 256000);
  assert.equal(observedPolicyInCompaction?.headroomTokens, 4915);
  assert.equal(observedPolicyInCompaction?.maxTokens, 4915);
  assert.equal(
    fakeCompaction.warnedPressureConfigTargets.has('ollama/qwen3-coder:latest'),
    false,
  );

  disposeEffect?.();
});

test('client module registers conversation.input.model with priority -10', () => {
  assert.equal(typeof globalThis.__DSH_CONTEXT_WINDOW_BUILD__, 'function');

  const stubRequire = (id) => {
    if (id === 'react') {
      return {
        useSyncExternalStore: (_sub, getSnap) => getSnap(),
        useState: (init) => [init, () => {}],
        useRef: (init) => ({ current: init }),
        useId: () => 'test-id',
        useMemo: (fn) => fn(),
        useEffect: () => {},
        useLayoutEffect: () => {},
      };
    }
    if (id === 'react-dom') {
      return { createPortal: (node) => node };
    }
    if (id === 'react/jsx-runtime') {
      return {
        Fragment: 'Fragment',
        jsx: (type, props, key) => ({ type, props, key }),
        jsxs: (type, props, key) => ({ type, props, key }),
      };
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        IconCheckOutlineRegular: 'IconCheckOutlineRegular',
        IconChevronDownOutlineRegular: 'IconChevronDownOutlineRegular',
        IconChevronRightOutlineRegular: 'IconChevronRightOutlineRegular',
        IconCloseFillRegular: 'IconCloseFillRegular',
        IconDataOutlineRegular: 'IconDataOutlineRegular',
        IconWarningOutlineRegular: 'IconWarningOutlineRegular',
        Input: 'Input',
        MenuGroup: 'MenuGroup',
        MenuSurface: 'MenuSurface',
        StateDot: 'StateDot',
        Switch: 'Switch',
        Toast: 'Toast',
        rankByName: (items) => items,
        observeStickyMenuGroups: () => () => {},
      };
    }
    throw new Error(`Unexpected require: ${id}`);
  };

  const clientMod = globalThis.__DSH_CONTEXT_WINDOW_BUILD__(stubRequire);
  assert.equal(clientMod.name, 'context-window');
  assert.equal(typeof clientMod.computeAdaptiveCompactionBudget, 'function');
  assert.equal(typeof clientMod.shouldCompactBeforeContextWindowChange, 'function');

  const registeredSlots = [];
  const fakeForm = {
    getSnapshot: () => ({ status: 'ready', value: {}, writable: true }),
    subscribe: () => () => {},
    set: async () => true,
  };
  const fakeSlots = {
    inject: (_slotName, cb) => cb(),
    register: (options, component) => {
      registeredSlots.push({ options, component });
      return () => {};
    },
  };
  const fakeCtx = {
    effect: (fn) => fn(),
    locale: {
      register: () => () => {},
      subscribe: () => () => {},
      getSnapshot: () => ({ locale: 'zh' }),
    },
    configForms: {
      get: () => fakeForm,
      describe: () => ({
        ensure: async () => {},
        load: async () => {},
        acceptView: () => {},
      }),
      whileServed: (_ns, cb) => cb(),
    },
    modelDirectories: {
      directoryFor: () => ({
        store: {
          subscribe: () => () => {},
          getSnapshot: () => ({
            current: { provider: 'ollama', model: 'qwen3-coder:latest' },
            groups: [],
            failures: [],
            status: 'ready',
            pending: null,
            error: null,
          }),
        },
        load: async () => {},
        select: async () => ({ ok: true }),
      }),
    },
    sessions: {
      subagentAddress: () => undefined,
    },
    slots: fakeSlots,
    inject: (_deps, cb) => cb(fakeCtx),
  };

  clientMod.apply(fakeCtx);

  const modelSlotReg = registeredSlots.find(
    (entry) => entry.options.name === 'conversation.input.model',
  );
  assert.ok(modelSlotReg, 'Expected conversation.input.model registration');
  assert.equal(modelSlotReg.options.priority, -10);
  assert.equal(
    Object.hasOwn(modelSlotReg.options.children ?? {}, 'conversation.input.model.label'),
    false,
    'Must not redeclare conversation.input.model.label already owned by ui-model-selection',
  );
  assert.deepEqual(modelSlotReg.options.children, {
    'conversation.input.model.context-window.label': {
      kind: 'single',
      scope: 'session',
      inline: true,
    },
  });

  const injectedProps = modelSlotReg.options.inject('sess-1');
  const baseProps = {
    ...injectedProps,
    locked: false,
    t: (k) => k,
    useProjection: (key) =>
      key === 'contextPressure'
        ? { projectedTokens: 60000, contextWindow: 262144 }
        : undefined,
    renderSlot: (_slot, _owner, opts) => opts?.fallback ?? null,
  };
  const renderedTree = modelSlotReg.component(baseProps);
  assert.ok(renderedTree, 'Expected EnhancedModelSelect to render without throwing');
  assert.equal(typeof renderedTree.props.onBlur, 'function', 'Expected onBlur handler to be defined');
  assert.equal(typeof renderedTree.props.onKeyDown, 'function', 'Expected onKeyDown handler to be defined');
});
