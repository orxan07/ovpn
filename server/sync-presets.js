#!/usr/bin/env node
const { PRESETS } = require('./presets');
const whitelist = require('./whitelist');

try {
  const result = whitelist.syncAppliedPresets(PRESETS);

  if (!result.changed) {
    console.log('Whitelist presets are already in sync.');
    process.exit(0);
  }

  console.log(`Whitelist presets synced: +${result.domainsAdded} domains, +${result.ipCidrsAdded} IP CIDRs.`);
  for (const preset of result.presets) {
    console.log(`- ${preset.name}: +${preset.domainsAdded} domains, +${preset.ipCidrsAdded} IP CIDRs`);
  }
} catch (e) {
  console.error(`Failed to sync whitelist presets: ${e.message}`);
  process.exit(1);
}
