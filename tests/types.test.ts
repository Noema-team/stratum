import { test } from 'node:test';
import { strict as assert } from 'assert';
import {
  ProjectTypeEnum,
  PlanningDepthEnum,
  SystemStatusEnum,
  AgentRoleEnum,
  ValidationMethodEnum,
  LLMProviderEnum,
  AgentLLMConfigSchema,
  AgentRoleConfigSchema,
  AgentsSchema,
  ValidationRuleCategorySchema,
  ValidationSchema,
  RuntimeConfigSchema,
  InitStateSchema,
  DiscoveryStateSchema,
  ChatStateSchema,
  CycleFlagsSchema,
  ArtifactRuleSchema,
  ArtifactsSchema,
  NodeTagSchema,
  OpenQuestionSchema,
  PlanningSchema,
  ExitSchema,
  UserValidationSchema,
  SummarySchema,
  SLETaskSchema,
} from '../src/types.js';

// ============================================================================
// Enum Tests
// ============================================================================

test('testProjectTypeEnum', () => {
  const valid = ['api', 'ui', 'library', 'research', 'custom'];
  for (const type of valid) {
    const result = ProjectTypeEnum.safeParse(type);
    assert(result.success, `ProjectType "${type}" should be valid`);
  }

  const invalid = ['backend', 'frontend', 'data'];
  for (const type of invalid) {
    const result = ProjectTypeEnum.safeParse(type);
    assert(!result.success, `ProjectType "${type}" should be invalid`);
  }
});

test('testPlanningDepthEnum', () => {
  const valid = ['minimal', 'standard', 'deep', 'research'];
  for (const depth of valid) {
    const result = PlanningDepthEnum.safeParse(depth);
    assert(result.success, `PlanningDepth "${depth}" should be valid`);
  }

  const invalid = ['shallow', 'thorough', 'comprehensive'];
  for (const depth of invalid) {
    const result = PlanningDepthEnum.safeParse(depth);
    assert(!result.success, `PlanningDepth "${depth}" should be invalid`);
  }
});

test('testSystemStatusEnum', () => {
  const valid = ['idle', 'discovering', 'cycling', 'halted', 'complete'];
  for (const status of valid) {
    const result = SystemStatusEnum.safeParse(status);
    assert(result.success, `SystemStatus "${status}" should be valid`);
  }

  const invalid = ['running', 'paused', 'pending'];
  for (const status of invalid) {
    const result = SystemStatusEnum.safeParse(status);
    assert(!result.success, `SystemStatus "${status}" should be invalid`);
  }
});

test('testAgentRoleEnum', () => {
  const validRoles = [
    'designer',
    'explorer',
    'planner',
    'tester',
    'builder',
    'debugger',
    'evaluator',
    'critic',
    'historian',
    'facilitator',
  ];
  for (const role of validRoles) {
    const result = AgentRoleEnum.safeParse(role);
    assert(result.success, `AgentRole "${role}" should be valid`);
  }

  const invalidRoles = ['architect', 'manager', 'reviewer'];
  for (const role of invalidRoles) {
    const result = AgentRoleEnum.safeParse(role);
    assert(!result.success, `AgentRole "${role}" should be invalid`);
  }
});

// ============================================================================
// Agent Config Tests
// ============================================================================

test('testAgentLLMConfig', () => {
  const valid = {
    provider: 'openai_compatible' as const,
    api_key_env: 'OPENAI_API_KEY',
    model: 'gpt-4o',
  };
  const result = AgentLLMConfigSchema.safeParse(valid);
  assert(result.success, 'Valid AgentLLMConfig should pass');
  assert(result.data?.model === 'gpt-4o');

  const missingField = {
    provider: 'openai_compatible',
    api_key_env: 'OPENAI_API_KEY',
  };
  const result2 = AgentLLMConfigSchema.safeParse(missingField);
  assert(!result2.success, 'Missing required field should fail');

  const wrongProvider = {
    provider: 'invalid_provider',
    api_key_env: 'OPENAI_API_KEY',
    model: 'gpt-4o',
  };
  const result3 = AgentLLMConfigSchema.safeParse(wrongProvider);
  assert(!result3.success, 'Invalid provider should fail');
});

test('testAgentRoleConfig', () => {
  const validConfig = {
    active: true,
    node: 'design',
    llm: {
      provider: 'openai_compatible' as const,
      api_key_env: 'OPENAI_API_KEY',
      model: 'gpt-4o',
    },
    temperature: 0.7,
    max_tokens: 8000,
    system_prompt: 'You are a design agent',
    artifact_slice: ['doc:architecture', 'doc:requirements'],
    outputs: ['doc:architecture'],
    conditional: false,
  };
  const result = AgentRoleConfigSchema.safeParse(validConfig);
  assert(result.success, 'Valid AgentRoleConfig should pass');
  assert(result.data?.temperature === 0.7);

  const highTemperature = { ...validConfig, temperature: 3.0 };
  const result2 = AgentRoleConfigSchema.safeParse(highTemperature);
  assert(result2.success, 'Temperature constraint removed, 3.0 should be valid');

  const negativeTokens = { ...validConfig, max_tokens: -100 };
  const result3 = AgentRoleConfigSchema.safeParse(negativeTokens);
  assert(!result3.success, 'Negative max_tokens should fail');
});

test('testAgentsConfig', () => {
  const validConfig = {
    defaults: {
      llm: {
        provider: 'openai_compatible' as const,
        api_key_env: 'OPENAI_API_KEY',
        model: 'gpt-4o',
      },
      temperature: 0.7,
      max_tokens: 8000,
      system_prompt_root: '.sle/prompts',
    },
    providers: {
      openai: {
        provider: 'openai_compatible' as const,
        api_key_env: 'OPENAI_API_KEY',
        model: 'gpt-4o',
      },
    },
    agents: {
      planner: {
        active: true,
        node: 'plan',
        llm: {
          provider: 'openai_compatible' as const,
          api_key_env: 'OPENAI_API_KEY',
          model: 'gpt-4o',
        },
        temperature: 0.7,
        max_tokens: 8000,
        system_prompt: 'You are a planner',
        artifact_slice: [],
        outputs: [],
        conditional: false,
      },
      designer: {
        active: true,
        node: 'design',
        llm: {
          provider: 'openai_compatible' as const,
          api_key_env: 'OPENAI_API_KEY',
          model: 'gpt-4o',
        },
        temperature: 0.7,
        max_tokens: 8000,
        system_prompt: 'You are a designer',
        artifact_slice: [],
        outputs: [],
        conditional: false,
      },
    },
  };
  const result = AgentsSchema.safeParse(validConfig);
  assert(result.success, 'Valid AgentsConfig with planner should pass');
});

// ============================================================================
// Validation Config Tests
// ============================================================================

test('testValidationRuleCategory', () => {
  const validCategory = {
    name: 'correctness',
    method: 'executable' as const,
    executable: {
      runner: 'npm test',
      timeout_ms: 60000,
      output_format: 'json' as const,
    },
    pass_criteria: {
      executable: 'all_pass',
    },
    on_fail: {
      feed_to: 'planner' as const,
      include: ['run_dir'],
    },
  };
  const result = ValidationRuleCategorySchema.safeParse(validCategory);
  assert(result.success, 'Valid ValidationRuleCategory should pass');

  const incomplete = {
    name: 'correctness',
    method: 'executable',
  };
  const result2 = ValidationRuleCategorySchema.safeParse(incomplete);
  assert(!result2.success, 'Missing required fields should fail');
});

test('testValidationRuleCategoryRefine', () => {
  const noExecutable = {
    name: 'correctness',
    method: 'executable' as const,
    pass_criteria: { executable: 'all_pass' },
    on_fail: { feed_to: 'planner' as const, include: [] },
  };
  const result1 = ValidationRuleCategorySchema.safeParse(noExecutable);
  assert(!result1.success, 'executable method without executable config should fail');

  const noLlm = {
    name: 'quality',
    method: 'llm' as const,
    pass_criteria: {},
    on_fail: { feed_to: 'evaluator' as const, include: [] },
  };
  const result2 = ValidationRuleCategorySchema.safeParse(noLlm);
  assert(!result2.success, 'llm method without llm config should fail');

  const bothMissingExecutable = {
    name: 'full-check',
    method: 'both' as const,
    llm: {
      artifact_slice: ['doc:architecture'],
      prompt_template: 'Check quality',
      pass_threshold: 0.8,
    },
    pass_criteria: {},
    on_fail: { feed_to: 'planner' as const, include: [] },
  };
  const result3 = ValidationRuleCategorySchema.safeParse(bothMissingExecutable);
  assert(!result3.success, 'both method without executable config should fail');

  const bothMissingLlm = {
    name: 'full-check',
    method: 'both' as const,
    executable: {
      runner: 'npm test',
      timeout_ms: 60000,
      output_format: 'json' as const,
    },
    pass_criteria: {},
    on_fail: { feed_to: 'planner' as const, include: [] },
  };
  const result4 = ValidationRuleCategorySchema.safeParse(bothMissingLlm);
  assert(!result4.success, 'both method without llm config should fail');

  const bothComplete = {
    name: 'full-check',
    method: 'both' as const,
    executable: {
      runner: 'npm test',
      timeout_ms: 60000,
      output_format: 'json' as const,
    },
    llm: {
      artifact_slice: ['doc:architecture'],
      prompt_template: 'Check quality',
      pass_threshold: 0.8,
    },
    pass_criteria: {},
    on_fail: { feed_to: 'planner' as const, include: [] },
  };
  const result5 = ValidationRuleCategorySchema.safeParse(bothComplete);
  assert(result5.success, 'both method with all configs should pass');
});

test('testAgentsSchemaRefine', () => {
  const noPlanner = {
    defaults: {
      llm: {
        provider: 'openai_compatible' as const,
        api_key_env: 'OPENAI_API_KEY',
        model: 'gpt-4o',
      },
      temperature: 0.7,
      max_tokens: 8000,
      system_prompt_root: '.sle/prompts',
    },
    providers: {},
    agents: {
      designer: {
        active: true,
        node: 'design',
        llm: {
          provider: 'openai_compatible' as const,
          api_key_env: 'OPENAI_API_KEY',
          model: 'gpt-4o',
        },
        temperature: 0.7,
        max_tokens: 8000,
        system_prompt: 'You are a designer',
        artifact_slice: [],
        outputs: [],
        conditional: false,
      },
    },
  };
  const result = AgentsSchema.safeParse(noPlanner);
  assert(!result.success, 'AgentsConfig without planner should fail');
});

test('testValidationConfig', () => {
  const validConfig = {
    static_analysis: {
      lint: {
        command: 'eslint src',
        enabled: true,
        pass_criteria: { errors: 0 },
      },
      typecheck: {
        command: 'tsc --noEmit',
        enabled: true,
        pass_criteria: { errors: 0 },
      },
      complexity: {
        command: 'complexity-check',
        enabled: true,
        pass_criteria: { max_complexity: 10 },
      },
    },
    container: {
      base_image: 'node:20',
      install_command: 'npm install',
      timeout_ms: 300000,
    },
    categories: [
      {
        name: 'correctness',
        method: 'executable' as const,
        executable: {
          runner: 'npm test',
          timeout_ms: 60000,
          output_format: 'json' as const,
        },
        pass_criteria: {
          executable: 'all_pass',
        },
        on_fail: {
          feed_to: 'planner' as const,
          include: [],
        },
      },
    ],
  };
  const result = ValidationSchema.safeParse(validConfig);
  assert(result.success, 'Valid ValidationConfig should pass');
});

// ============================================================================
// Chat and Cycle Flags Tests
// ============================================================================

test('testChatState', () => {
  const validOpen = {
    session_open: true,
    session_id: 'session-123',
    started_at: '2026-05-08T12:00:00Z',
    total_exchanges: 5,
    pending_decisions: 0,
  };
  const result = ChatStateSchema.safeParse(validOpen);
  assert(result.success, 'Valid ChatState should pass');

  const validClosed = {
    session_open: false,
    total_exchanges: 0,
    pending_decisions: 0,
  };
  const result2 = ChatStateSchema.safeParse(validClosed);
  assert(result2.success, 'ChatState with session_open: false should pass');

  const minimalClosed = {
    session_open: false,
  };
  const result3 = ChatStateSchema.safeParse(minimalClosed);
  assert(result3.success, 'ChatState with defaults should pass');
  assert.strictEqual(result3.data.total_exchanges, 0);
  assert.strictEqual(result3.data.pending_decisions, 0);
});

test('testCycleFlags', () => {
  const allFalse = {
    awaiting_scoping: false,
    awaiting_confirmation: false,
    awaiting_sharding_approval: false,
  };
  const result = CycleFlagsSchema.safeParse(allFalse);
  assert(result.success, 'Valid CycleFlags should pass');
  assert(result.data?.awaiting_scoping === false);

  const partial = {
    awaiting_confirmation: true,
  };
  const result2 = CycleFlagsSchema.safeParse(partial);
  assert(result2.success, 'Partial CycleFlags should pass (defaults applied)');
  assert(result2.data?.awaiting_scoping === false);
  assert(result2.data?.awaiting_confirmation === true);
});

// ============================================================================
// Artifact Tests
// ============================================================================

test('testArtifactRule', () => {
  const validRule = {
    id: 'requirements',
    path: 'docs/requirements.md',
    generator: 'designer' as const,
    required: true,
    append_only: false,
    format: 'markdown' as const,
  };
  const result = ArtifactRuleSchema.safeParse(validRule);
  assert(result.success, 'Valid ArtifactRule should pass');

  const invalidBool = { ...validRule, append_only: 'true' };
  const result2 = ArtifactRuleSchema.safeParse(invalidBool);
  assert(!result2.success, 'Non-boolean append_only should fail');
});

test('testArtifactsConfig', () => {
  const validConfig = {
    artifacts: [
      {
        id: 'requirements',
        path: 'docs/requirements.md',
        generator: 'designer' as const,
        required: true,
        append_only: false,
        format: 'markdown' as const,
      },
    ],
    generated_outputs: [
      {
        id: 'summary',
        path: 'reports/summary.md',
        type: 'markdown' as const,
        generated_at: 'cycle_end' as const,
      },
    ],
  };
  const result = ArtifactsSchema.safeParse(validConfig);
  assert(result.success, 'Valid ArtifactsConfig should pass');
});

// ============================================================================
// Init State Tests
// ============================================================================

test('testInitState', () => {
  const validInitState = {
    last_completed_step: 0,
    project: {
      name: 'my-project',
      description: 'A test project',
      type: 'api' as const,
    },
    remotes: {
      code: {
        url: 'https://github.com/org/repo.git',
        branch: 'main',
      },
      issues: {
        url: 'https://github.com/org/issues',
        prefix: 'ISSUE',
        local_only: false,
      },
      docs: {
        url: 'https://github.com/org/repo.server.git',
        pending: false,
      },
    },
    task_store: {
      provider: 'local' as const,
    },
    beads_initialised: false,
    docs_cloned: false,
    committed: false,
  };
  const result = InitStateSchema.safeParse(validInitState);
  assert(result.success, 'Valid InitState should pass');

  const missing = { ...validInitState };
  delete missing.project.name;
  const result2 = InitStateSchema.safeParse(missing);
  assert(!result2.success, 'Missing required field should fail');
});

// ============================================================================
// Discovery State Tests
// ============================================================================

test('testDiscoveryState', () => {
  const validState = {
    status: 'not_started' as const,
    mode: 'full' as const,
    artifacts: [],
    current_round: 0,
    total_rounds: 4,
    current_phase: 0,
    total_phases: 0,
    open_questions_count: 0,
    blocking_questions_count: 0,
  };
  const result = DiscoveryStateSchema.safeParse(validState);
  assert(result.success, 'Valid DiscoveryState should pass');
  assert(result.data?.status === 'not_started');

  const invalidStatus = { ...validState, status: 'started' };
  const result2 = DiscoveryStateSchema.safeParse(invalidStatus);
  assert(!result2.success, 'Invalid status should fail');
});

// ============================================================================
// Node Tag Tests
// ============================================================================

test('testNodeTag', () => {
  const validTag = {
    prefix: 'next-cycle' as const,
    target_ref: 'node:rate-limiting',
    source: 'user' as const,
    applied_at: '2026-05-08T12:00:00Z',
  };
  const result = NodeTagSchema.safeParse(validTag);
  assert(result.success, 'Valid NodeTag should pass');

  const withValue = {
    prefix: 'scope' as const,
    value: 'scope-draft-123',
    target_ref: 'doc:architecture',
    source: 'facilitator' as const,
    applied_at: '2026-05-08T12:00:00Z',
  };
  const result2 = NodeTagSchema.safeParse(withValue);
  assert(result2.success, 'NodeTag with value should pass');

  const invalidSource = { ...validTag, source: 'unknown' };
  const result3 = NodeTagSchema.safeParse(invalidSource);
  assert(!result3.success, 'Invalid source should fail');

  const missingTargetRef = {
    prefix: 'next-cycle' as const,
    source: 'user' as const,
    applied_at: '2026-05-08T12:00:00Z',
  };
  const result4 = NodeTagSchema.safeParse(missingTargetRef);
  assert(!result4.success, 'NodeTag without target_ref should fail');
});

// ============================================================================
// Open Question Tests
// ============================================================================

test('testOpenQuestion', () => {
  const validQuestion = {
    title: 'What is the target audience?',
    status: 'open' as const,
    blocking: 'not_blocking' as const,
    context: 'Product brief round',
  };
  const result = OpenQuestionSchema.safeParse(validQuestion);
  assert(result.success, 'Valid OpenQuestion should pass');

  const withBlocking = {
    title: 'Architecture decision',
    status: 'open' as const,
    blocking: 'phase:2' as const,
    owner: 'user@example.com',
    context: 'Design phase',
  };
  const result2 = OpenQuestionSchema.safeParse(withBlocking);
  assert(result2.success, 'OpenQuestion with phase blocking should pass');

  const invalidBlocking = { ...validQuestion, blocking: 'phase:invalid' };
  const result3 = OpenQuestionSchema.safeParse(invalidBlocking);
  assert(!result3.success, 'Invalid blocking format should fail');

  const deferredStatus = { ...validQuestion, status: 'deferred' as const };
  const result4 = OpenQuestionSchema.safeParse(deferredStatus);
  assert(!result4.success, 'Deferred status should be invalid');
});

// ============================================================================
// ExitConfig Tests (C4, C5)
// ============================================================================

test('testExitConfig', () => {
  const valid = {
    conditions: {
      all_categories_pass: true,
      requirements_met: true,
    },
    on_cap_hit: 'halt_with_report' as const,
    halt_behavior: {
      write_partial_report: true,
      notify_user: true,
      block_version_snapshot: false,
      preserve_decisions: true,
    },
    on_error: {
      behavior: 'halt' as const,
      write_error_report: true,
      block_version_snapshot: false,
    },
  };
  const result = ExitSchema.safeParse(valid);
  assert(result.success, 'Valid ExitConfig with structured halt_behavior and on_error should pass');

  const missingHaltField = {
    conditions: {
      all_categories_pass: true,
      requirements_met: true,
    },
    on_cap_hit: 'halt_with_report' as const,
    halt_behavior: {
      write_partial_report: true,
      notify_user: true,
    },
    on_error: {
      behavior: 'halt' as const,
      write_error_report: true,
      block_version_snapshot: false,
    },
  };
  const result2 = ExitSchema.safeParse(missingHaltField);
  assert(!result2.success, 'Missing halt_behavior fields should fail');

  const missingErrorField = {
    conditions: {
      all_categories_pass: true,
      requirements_met: true,
    },
    on_cap_hit: 'halt_with_report' as const,
    halt_behavior: {
      write_partial_report: true,
      notify_user: true,
      block_version_snapshot: false,
      preserve_decisions: true,
    },
    on_error: {
      behavior: 'retry_once' as const,
    },
  };
  const result3 = ExitSchema.safeParse(missingErrorField);
  assert(!result3.success, 'Missing on_error fields should fail');
});

// ============================================================================
// SLETask Tests (C6, C7, C8)
// ============================================================================

test('testSLETask', () => {
  const validTask = {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    title: 'Implement feature',
    description: 'Add new feature to module',
    status: 'open' as const,
    priority: 3,
    dependencies: [],
    context_declarations: [
      {
        task_id: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890',
        slices: ['doc:architecture', 'node:design:req-001'],
        intent: 'Need architecture context for planning',
      },
    ],
    created_at: '2026-05-08T12:00:00Z',
    updated_at: '2026-05-08T12:00:00Z',
  };
  const result = SLETaskSchema.safeParse(validTask);
  assert(result.success, 'Valid SLETask with new types should pass');

  const oldStatus = {
    ...validTask,
    status: 'pending' as const,
  };
  const result2 = SLETaskSchema.safeParse(oldStatus);
  assert(!result2.success, 'Old "pending" status should fail');

  const oldPriority = {
    ...validTask,
    priority: 'high',
  };
  const result3 = SLETaskSchema.safeParse(oldPriority);
  assert(!result3.success, 'String priority should fail');

  const negativePriority = {
    ...validTask,
    priority: -1,
  };
  const result4 = SLETaskSchema.safeParse(negativePriority);
  assert(!result4.success, 'Negative priority should fail');

  const closedStatus = {
    ...validTask,
    status: 'closed' as const,
    priority: 5,
  };
  const result5 = SLETaskSchema.safeParse(closedStatus);
  assert(result5.success, '"closed" status and numeric priority should pass');
});

// ============================================================================
// PlanningConfig Tests (C1, C2, C3)
// ============================================================================

test('testPlanningConfig', () => {
  const valid = {
    depth: 'standard' as const,
    max_iterations: 5,
    artifact_slice_size: 2000,
    summary_max_tokens: 1000,
    system_prompt_max_tokens: 2000,
    reasoning_passes: {
      minimal: 1,
      standard: 2,
      deep: 3,
      research: 4,
    },
    critic_enabled: true,
    on_depth_change: 're_plan' as const,
  };
  const result = PlanningSchema.safeParse(valid);
  assert(result.success, 'Valid PlanningConfig should pass');

  const nullCritic = { ...valid, critic_enabled: null };
  const result2 = PlanningSchema.safeParse(nullCritic);
  assert(result2.success, 'critic_enabled: null should pass');

  const oldPasses = { ...valid, reasoning_passes: 2 };
  const result3 = PlanningSchema.safeParse(oldPasses);
  assert(!result3.success, 'reasoning_passes as number should fail');

  const missingOnDepthChange = { ...valid };
  delete missingOnDepthChange.on_depth_change;
  const result4 = PlanningSchema.safeParse(missingOnDepthChange);
  assert(!result4.success, 'Missing on_depth_change should fail');

  const invalidOnDepthChange = { ...valid, on_depth_change: 'invalid' };
  const result5 = PlanningSchema.safeParse(invalidOnDepthChange);
  assert(!result5.success, 'Invalid on_depth_change value should fail');
});

// ============================================================================
// Full RuntimeConfig Test
// ============================================================================

test('testRuntimeConfigFull', () => {
  const config = {
    planning: {
      depth: 'standard' as const,
      max_iterations: 5,
      artifact_slice_size: 2000,
      summary_max_tokens: 1000,
      system_prompt_max_tokens: 2000,
      reasoning_passes: {
        minimal: 1,
        standard: 2,
        deep: 3,
        research: 4,
      },
      critic_enabled: true,
      on_depth_change: 're_plan' as const,
    },
    validation: {
      static_analysis: {
        lint: {
          command: 'eslint src',
          enabled: true,
          pass_criteria: { errors: 0 },
        },
        typecheck: {
          command: 'tsc --noEmit',
          enabled: true,
          pass_criteria: { errors: 0 },
        },
        complexity: {
          command: 'complexity-check',
          enabled: true,
          pass_criteria: { max_complexity: 10 },
        },
      },
      container: {
        base_image: 'node:20',
        install_command: 'npm install',
        timeout_ms: 300000,
      },
      categories: [
        {
          name: 'correctness',
          method: 'executable' as const,
          executable: {
            runner: 'npm test',
            timeout_ms: 60000,
            output_format: 'json' as const,
          },
          pass_criteria: { executable: 'all_pass' },
          on_fail: { feed_to: 'planner' as const, include: [] },
        },
      ],
    },
    artifacts: {
      artifacts: [
        {
          id: 'requirements',
          path: 'docs/requirements.md',
          generator: 'designer' as const,
          required: true,
          append_only: false,
          format: 'markdown' as const,
        },
      ],
      generated_outputs: [],
    },
    exit: {
      conditions: {
        all_categories_pass: true,
        requirements_met: true,
      },
      on_cap_hit: 'halt_with_report' as const,
      halt_behavior: {
        write_partial_report: true,
        notify_user: true,
        block_version_snapshot: false,
        preserve_decisions: true,
      },
      on_error: {
        behavior: 'halt' as const,
        write_error_report: true,
        block_version_snapshot: false,
      },
    },
    user_validation: {
      approval_required: true,
      review_at: ['after_planning'] as const,
      prompts: { default: 'Please review the plan' },
      timeout_minutes: 30,
      on_timeout: 'notify_and_wait' as const,
      auto_approve_on_rerun: false,
    },
    summary: {
      format: 'markdown' as const,
      sections: ['overview', 'changes', 'tests'],
      test_command_format: 'npm_script' as const,
      show_confidence_scores: false,
      show_failed_test_ids: true,
      what_was_built_max_tokens: 1000,
      next_steps_max_count: 5,
      output_path: 'reports/summary.md',
    },
    agents: {
      defaults: {
        llm: {
          provider: 'openai_compatible' as const,
          api_key_env: 'OPENAI_API_KEY',
          model: 'gpt-4o',
        },
        temperature: 0.7,
        max_tokens: 8000,
        system_prompt_root: '.sle/prompts',
      },
      providers: {},
      agents: {
        planner: {
          active: true,
          node: 'plan',
          llm: {
            provider: 'openai_compatible' as const,
            api_key_env: 'OPENAI_API_KEY',
            model: 'gpt-4o',
          },
          temperature: 0.7,
          max_tokens: 8000,
          system_prompt: 'You are a planner',
          artifact_slice: [],
          outputs: [],
          conditional: false,
        },
      },
    },
  };
  const result = RuntimeConfigSchema.safeParse(config);
  assert(result.success, 'Valid RuntimeConfig should pass');
  if (!result.success) {
    console.error('Validation errors:', result.error.issues);
  }
});

