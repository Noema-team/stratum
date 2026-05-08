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
  AgentsConfigSchema,
  ValidationRuleCategorySchema,
  ValidationConfigSchema,
  RuntimeConfigSchema,
  InitStateSchema,
  DiscoveryStateSchema,
  ChatStateSchema,
  CycleFlagsSchema,
  ArtifactRuleSchema,
  ArtifactsConfigSchema,
  NodeTagSchema,
  OpenQuestionSchema,
} from '../src/types.js';

// ============================================================================
// Enum Tests
// ============================================================================

export function testProjectTypeEnum() {
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
}

export function testPlanningDepthEnum() {
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
}

export function testSystemStatusEnum() {
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
}

export function testAgentRoleEnum() {
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
}

// ============================================================================
// Agent Config Tests
// ============================================================================

export function testAgentLLMConfig() {
  // Valid config
  const valid = {
    provider: 'openai_compatible' as const,
    api_key_env: 'OPENAI_API_KEY',
    model: 'gpt-4o',
  };
  const result = AgentLLMConfigSchema.safeParse(valid);
  assert(result.success, 'Valid AgentLLMConfig should pass');
  assert(result.data?.model === 'gpt-4o');

  // Invalid: missing required field
  const missingField = {
    provider: 'openai_compatible',
    api_key_env: 'OPENAI_API_KEY',
  };
  const result2 = AgentLLMConfigSchema.safeParse(missingField);
  assert(!result2.success, 'Missing required field should fail');

  // Invalid: wrong provider
  const wrongProvider = {
    provider: 'invalid_provider',
    api_key_env: 'OPENAI_API_KEY',
    model: 'gpt-4o',
  };
  const result3 = AgentLLMConfigSchema.safeParse(wrongProvider);
  assert(!result3.success, 'Invalid provider should fail');
}

export function testAgentRoleConfig() {
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

  // Invalid: temperature out of range
  const invalidTemp = { ...validConfig, temperature: 3.0 };
  const result2 = AgentRoleConfigSchema.safeParse(invalidTemp);
  assert(!result2.success, 'Temperature > 2 should fail');

  // Invalid: negative max_tokens
  const negativeTokens = { ...validConfig, max_tokens: -100 };
  const result3 = AgentRoleConfigSchema.safeParse(negativeTokens);
  assert(!result3.success, 'Negative max_tokens should fail');
}

export function testAgentsConfig() {
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
  const result = AgentsConfigSchema.safeParse(validConfig);
  assert(result.success, 'Valid AgentsConfig should pass');
}

// ============================================================================
// Validation Config Tests
// ============================================================================

export function testValidationRuleCategory() {
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

  // Invalid: missing required fields
  const incomplete = {
    name: 'correctness',
    method: 'executable',
  };
  const result2 = ValidationRuleCategorySchema.safeParse(incomplete);
  assert(!result2.success, 'Missing required fields should fail');
}

export function testValidationConfig() {
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
  const result = ValidationConfigSchema.safeParse(validConfig);
  assert(result.success, 'Valid ValidationConfig should pass');
}

// ============================================================================
// Chat and Cycle Flags Tests
// ============================================================================

export function testChatState() {
  const validOpen = {
    session_open: true,
    session_id: 'session-123',
    started_at: '2026-05-08T12:00:00Z',
  };
  const result = ChatStateSchema.safeParse(validOpen);
  assert(result.success, 'Valid ChatState should pass');

  const validClosed = {
    session_open: false,
  };
  const result2 = ChatStateSchema.safeParse(validClosed);
  assert(result2.success, 'ChatState with session_open: false should pass');
}

export function testCycleFlags() {
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
}

// ============================================================================
// Artifact Tests
// ============================================================================

export function testArtifactRule() {
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

  // Invalid: append_only not a boolean
  const invalidBool = { ...validRule, append_only: 'true' };
  const result2 = ArtifactRuleSchema.safeParse(invalidBool);
  assert(!result2.success, 'Non-boolean append_only should fail');
}

export function testArtifactsConfig() {
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
  const result = ArtifactsConfigSchema.safeParse(validConfig);
  assert(result.success, 'Valid ArtifactsConfig should pass');
}

// ============================================================================
// Init State Tests
// ============================================================================

export function testInitState() {
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

  // Invalid: missing required field
  const missing = { ...validInitState };
  delete missing.project.name;
  const result2 = InitStateSchema.safeParse(missing);
  assert(!result2.success, 'Missing required field should fail');
}

// ============================================================================
// Discovery State Tests
// ============================================================================

export function testDiscoveryState() {
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

  // Invalid: invalid status
  const invalidStatus = { ...validState, status: 'started' };
  const result2 = DiscoveryStateSchema.safeParse(invalidStatus);
  assert(!result2.success, 'Invalid status should fail');
}

// ============================================================================
// Node Tag Tests
// ============================================================================

export function testNodeTag() {
  const validTag = {
    prefix: 'next-cycle' as const,
    source: 'user' as const,
    applied_at: '2026-05-08T12:00:00Z',
  };
  const result = NodeTagSchema.safeParse(validTag);
  assert(result.success, 'Valid NodeTag should pass');

  const withValue = {
    prefix: 'scope' as const,
    value: 'scope-draft-123',
    source: 'facilitator' as const,
    applied_at: '2026-05-08T12:00:00Z',
  };
  const result2 = NodeTagSchema.safeParse(withValue);
  assert(result2.success, 'NodeTag with value should pass');

  // Invalid: invalid source
  const invalidSource = { ...validTag, source: 'unknown' };
  const result3 = NodeTagSchema.safeParse(invalidSource);
  assert(!result3.success, 'Invalid source should fail');
}

// ============================================================================
// Open Question Tests
// ============================================================================

export function testOpenQuestion() {
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

  // Invalid: bad blocking format
  const invalidBlocking = { ...validQuestion, blocking: 'phase:invalid' };
  const result3 = OpenQuestionSchema.safeParse(invalidBlocking);
  assert(!result3.success, 'Invalid blocking format should fail');
}

// ============================================================================
// Full RuntimeConfig Test
// ============================================================================

export function testRuntimeConfigFull() {
  const config = {
    planning: {
      depth: 'standard' as const,
      max_iterations: 5,
      artifact_slice_size: 2000,
      summary_max_tokens: 1000,
      system_prompt_max_tokens: 2000,
      reasoning_passes: 2,
      critic_enabled: true,
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
      halt_behavior: 'halt' as const,
      on_error: 'halt' as const,
    },
    user_validation: {
      approval_required: true,
      review_at: ['after_planning'],
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
    },
  };
  const result = RuntimeConfigSchema.safeParse(config);
  assert(result.success, 'Valid RuntimeConfig should pass');
  if (!result.success) {
    console.error('Validation errors:', result.error.issues);
  }
}

// ============================================================================
// Run All Tests
// ============================================================================

export function runAllTests() {
  console.log('Running Phase A (Foundation Types) tests...\n');

  console.log('✓ Testing ProjectTypeEnum');
  testProjectTypeEnum();

  console.log('✓ Testing PlanningDepthEnum');
  testPlanningDepthEnum();

  console.log('✓ Testing SystemStatusEnum');
  testSystemStatusEnum();

  console.log('✓ Testing AgentRoleEnum');
  testAgentRoleEnum();

  console.log('✓ Testing AgentLLMConfig');
  testAgentLLMConfig();

  console.log('✓ Testing AgentRoleConfig');
  testAgentRoleConfig();

  console.log('✓ Testing AgentsConfig');
  testAgentsConfig();

  console.log('✓ Testing ValidationRuleCategory');
  testValidationRuleCategory();

  console.log('✓ Testing ValidationConfig');
  testValidationConfig();

  console.log('✓ Testing ChatState');
  testChatState();

  console.log('✓ Testing CycleFlags');
  testCycleFlags();

  console.log('✓ Testing ArtifactRule');
  testArtifactRule();

  console.log('✓ Testing ArtifactsConfig');
  testArtifactsConfig();

  console.log('✓ Testing InitState');
  testInitState();

  console.log('✓ Testing DiscoveryState');
  testDiscoveryState();

  console.log('✓ Testing NodeTag');
  testNodeTag();

  console.log('✓ Testing OpenQuestion');
  testOpenQuestion();

  console.log('✓ Testing Full RuntimeConfig');
  testRuntimeConfigFull();

  console.log('\n✅ All Phase A tests passed!');
}

runAllTests();
