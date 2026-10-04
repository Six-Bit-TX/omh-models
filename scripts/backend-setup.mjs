#!/usr/bin/env node
import { argumentsOf, readProfile, appendPlan } from './backend-profile.mjs';
import { planBackends } from './backend-config.mjs';

try {
  const options = argumentsOf(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/backend-setup.mjs --profile PATH --runtime PATH [--home PATH] [--chatgpt native|gateway|both] [--gateway-url URL] [--gateway-key-ref NAME] [--dry-run]\nChatGPT defaults to gateway; native requires an existing DSH OAuth credential. Stop the host before applying. Adds missing providers only; existing endpoint, authentication, model, and unrelated settings are preserved. No secret is accepted or written.');
  } else {
    const context = readProfile(options);
    const plan = planBackends(context.documents, { gateway: options['gateway-url'], gatewayKeyRef: options['gateway-key-ref'], chatgpt: options.chatgpt, userDocuments: context.userDocuments, syncMetadata: context.syncMetadata });
    if (!options['dry-run']) appendPlan(context, plan.rows);
    console.log(JSON.stringify({ action: options['dry-run'] ? 'planned' : 'applied', added: plan.added, preserved: plan.preserved, deepseek: plan.deepseek, sync: plan.sync, notices: plan.notices, credentials: 'unchanged' }, null, 2));
  }
} catch (error) { console.error(`Backend setup failed: ${error.code ? 'configuration could not be read or written' : error.message}`); process.exitCode = 1; }
