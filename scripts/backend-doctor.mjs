#!/usr/bin/env node
import { argumentsOf, readProfile, readCredentials } from './backend-profile.mjs';
import { profileEntries, credentialFor, probeGateway } from './backend-config.mjs';

try {
  const options = argumentsOf(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/backend-doctor.mjs --profile PATH --runtime PATH [--home PATH] [--probe]\nRead-only status. --probe performs authenticated gateway GET /models calls, never completions. Credential values and response bodies are never printed. Native catalogs follow the installed runtime; gateway catalogs refresh automatically.');
  } else {
    const context = readProfile(options); const credentials = readCredentials(context);
    const entries = profileEntries(context.documents); const providers = entries.get('llm-pi-ai')?.config?.providers ?? {};
    const output = [];
    const deepseek = entries.get('llm-deepseek');
    output.push({ provider: 'deepseek-official', configured: Boolean(deepseek) && deepseek.disabled !== true, catalog: 'installed runtime', auth: credentialFor('deepseek-official', { apiKeyEnv: 'DEEPSEEK_API_KEY', ...deepseek?.config }, credentials) });
    for (const provider of ['kimi-coding', 'openai-codex', 'opencodex', 'cursor']) {
      const config = providers[provider]; const gateway = provider === 'opencodex' || provider === 'cursor';
      const row = { provider, configured: config !== undefined, catalog: gateway ? 'gateway live sync' : 'installed runtime', auth: credentialFor(provider, config, credentials) };
      if (gateway && config) {
        row.configuredModelCount = Array.isArray(config.models) ? config.models.length : 0;
        if (options.probe) row.gateway = await probeGateway(config, credentials, process.env);
      }
      output.push(row);
    }
    console.log(JSON.stringify({ providers: output, credentialScope: context.home ? 'selected home and current environment; runtime .env fallbacks are not inspected' : 'current environment only; pass --home for managed credentials', writes: false }, null, 2));
  }
} catch (error) { console.error(`Backend doctor failed: ${error.code ? 'configuration could not be read' : error.message}`); process.exitCode = 1; }
