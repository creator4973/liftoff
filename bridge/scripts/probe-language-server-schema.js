#!/usr/bin/env node
// @ts-check

import { discoverLanguageServerInstances } from '../src/language-server/discovery.js';
import { ReadOnlyLanguageServerRpcClient } from '../src/language-server/rpc-client.js';
import { summarizeSchema } from '../src/language-server/schema-summary.js';

function uniqueSchemas(values) {
  const schemas = [];
  const seen = new Set();
  for (const value of values) {
    const schema = summarizeSchema(value);
    const signature = JSON.stringify(schema);
    if (seen.has(signature)) continue;
    seen.add(signature);
    schemas.push(schema);
  }
  return schemas;
}

async function main() {
  const [instance] = await discoverLanguageServerInstances();
  if (!instance) throw new Error('No readable Language Server instance found');

  const client = new ReadOnlyLanguageServerRpcClient();
  const response = await client.callReadOnly(
    'GetAllCascadeTrajectories',
    {},
    instance
  );
  const summaries = response?.trajectorySummaries || {};
  const entries = Object.entries(summaries).sort(([, left], [, right]) =>
    String(right?.lastModifiedTime || '').localeCompare(
      String(left?.lastModifiedTime || '')
    )
  );
  const output = {
    conversationCount: entries.length,
    summarySchemas: uniqueSchemas(entries.map(([, summary]) => summary)),
    stepCount: 0,
    stepTypes: {},
  };

  if (entries.length) {
    const [cascadeId, summary] = entries[0];
    const stepCount = Number(summary?.stepCount || 0);
    const stepResponse = await client.callReadOnly(
      'GetCascadeTrajectorySteps',
      { cascadeId, stepOffset: Math.max(0, stepCount - 120) },
      instance
    );
    const steps = Array.isArray(stepResponse?.steps) ? stepResponse.steps : [];
    output.stepCount = steps.length;
    for (const step of steps) {
      const type = String(step?.type || 'UNKNOWN_STEP_TYPE');
      const payload = Object.fromEntries(
        Object.entries(step || {}).filter(([field]) => field !== 'metadata')
      );
      if (!output.stepTypes[type]) output.stepTypes[type] = [];
      const schema = summarizeSchema(payload);
      const schemaSignature = JSON.stringify(schema);
      if (
        !output.stepTypes[type].some(
          (existing) => JSON.stringify(existing) === schemaSignature
        )
      ) {
        output.stepTypes[type].push(schema);
      }
    }
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(`Language Server schema probe failed: ${error?.message || error}`);
  process.exitCode = 1;
});
