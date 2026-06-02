import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createRuntimeServices } from '../src/core/runtime-services.js';
import {
  createProviderModel,
  resolveProviderAuth,
} from '../src/llm/provider.js';
import { LLMProvider } from '../src/schema.js';

test('ProviderModel captures Google Gemini reasoning metadata', () => {
  const model = createProviderModel({
    provider: LLMProvider.GOOGLE,
    providerName: 'google',
    model: 'gemini-3.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/',
    contextWindowTokens: 1000000,
  });

  assert.equal(model.provider, LLMProvider.GOOGLE);
  assert.equal(model.providerName, 'google');
  assert.equal(model.apiProtocol, 'google-generative-ai');
  assert.equal(model.id, 'gemini-3.5-flash');
  assert.equal(model.baseUrl, 'https://generativelanguage.googleapis.com');
  assert.equal(model.contextWindowTokens, 1000000);
  assert.equal(model.reasoning.supported, true);
  assert.equal(model.reasoning.defaultLevel, 'high');
  assert.equal(model.compatibility.googleThinkingConfig, 'level');
});

test('ProviderAuthResolver resolves runtime, config, then env API keys', () => {
  assert.deepEqual(
    resolveProviderAuth({
      provider: LLMProvider.GOOGLE,
      providerName: 'google',
      runtimeApiKey: ' runtime-key ',
      configApiKey: 'config-key',
      env: { GEMINI_API_KEY: 'env-key' },
    }),
    { apiKey: 'runtime-key', source: 'runtime' },
  );

  assert.deepEqual(
    resolveProviderAuth({
      provider: LLMProvider.GOOGLE,
      providerName: 'google',
      configApiKey: 'config-key',
      env: { GEMINI_API_KEY: 'env-key' },
    }),
    { apiKey: 'config-key', source: 'config' },
  );

  assert.deepEqual(
    resolveProviderAuth({
      provider: LLMProvider.GOOGLE,
      providerName: 'google',
      env: { GEMINI_API_KEY: 'env-key' },
    }),
    { apiKey: 'env-key', source: 'env' },
  );
});

test('RuntimeServices exposes provider runtime context', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eva-provider-runtime-'));
  const configPath = path.join(tempDir, 'config.yaml');

  try {
    await fs.writeFile(
      configPath,
      [
        'api_key: "test-key"',
        'provider: "google"',
        'model: "gemini-3.5-flash"',
        'api_base: "https://generativelanguage.googleapis.com/"',
        'context_window_tokens: 1000000',
        'retry:',
        '  enabled: true',
        '  max_retries: 5',
        '  max_delay: 45',
        'tools:',
        '  enable_file_tools: false',
        '  enable_bash: false',
        '  enable_skills: false',
        '  enable_mcp: false',
        '  require_confirmation: false',
      ].join('\n'),
      'utf-8',
    );

    const services = await createRuntimeServices({
      workspaceDir: tempDir,
      configPath,
      sessionMode: 'memory',
      tools: [],
    });

    assert.equal(services.providerModel.provider, LLMProvider.GOOGLE);
    assert.equal(services.providerModel.id, 'gemini-3.5-flash');
    assert.equal(services.providerModel.reasoning.supported, true);
    assert.equal(services.providerAuth.apiKey, 'test-key');
    assert.equal(services.providerAuth.source, 'config');
    assert.deepEqual(services.providerRequestOptions, {
      maxRetries: 5,
      maxRetryDelayMs: 45000,
    });
    assert.equal(services.llmClient.providerModel, services.providerModel);
    assert.equal(services.llmClient.providerRequestOptions, services.providerRequestOptions);
    assert.ok(services.diagnostics.some((diagnostic) =>
      diagnostic.code === 'provider_configured'
      && diagnostic.details?.['apiProtocol'] === 'google-generative-ai'
      && diagnostic.details?.['reasoningSupported'] === true
    ));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
