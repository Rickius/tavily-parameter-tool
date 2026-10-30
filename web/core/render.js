// Builds the JSON request body and the Python snippet shown next to the parameter rows.

import { pyRepr } from './pyish.js';

export function requestBody(rows) {
  const body = {};
  for (const row of rows) body[row.name] = row.value;
  if (!('query' in body)) throw new Error('requestBody: the rows have no query');
  const { query, ...rest } = body;
  return { query, ...rest };
}

// chunks_per_source, include_published_date and filter_by_published_date are not named
// arguments of TavilyClient.search (tavily-python 0.8.5), but its **kwargs pass them through.
export function pythonSnippet(body) {
  const args = Object.entries(body).map(([name, value]) => `    ${name}=${pyRepr(value)},\n`).join('');
  return (
    'from tavily import TavilyClient\n\n' +
    'client = TavilyClient()  # reads TAVILY_API_KEY from the environment\n\n' +
    `response = client.search(\n${args})\n`
  );
}
