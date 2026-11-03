// Operator settings for the browser version. Edit this file to change models, timeouts and caps.
// No secrets here: API keys come from config.js (written at build time), never from this file.

export const settings = {
  models: {
    planner: 'zai-org/GLM-5.3',
    planner2: 'deepseek-ai/DeepSeek-V4-Pro-0813', // second planner for the optional ensemble; set to '' to disable it
    aggregator: 'zai-org/GLM-5.2', // merges the two plans; set to '' to disable the ensemble
    small: 'Qwen/Qwen3-30B-A3B-Instruct-2507', // default Compare models; each must be in phase2Allowlist
    large: 'zai-org/GLM-5.3',
  },

  // The Compare tab offers only these. Token Factory documents no "supports tool calls" flag,
  // so the list is curated by hand. Add an entry (id and size: 'small' or 'large') to offer another model.
  phase2Allowlist: [
    { id: 'zai-org/GLM-5.3', size: 'large' },
    { id: 'Qwen/Qwen3-30B-A3B-Instruct-2507', size: 'small' },
  ],

  ensembleDefault: false, // whether the planner ensemble checkbox starts checked
  compareEnabled: true, // false hides Compare, which is the part that spends Tavily credits

  plannerTimeoutSeconds: 240, // per planner or aggregator call
  runTimeoutSeconds: 240, // per Compare model call

  // Compare caps. The maximums cannot go above 12 turns and 8 searches, whatever is written here.
  defaultTurns: 6,
  maxTurns: 12,
  defaultSearches: 4,
  maxSearches: 8,

  maxTaskChars: 500,
};
