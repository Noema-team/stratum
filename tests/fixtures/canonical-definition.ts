// D.3d.5 commit 2 — test-side canonicalization helper for scripted
// Definition artifacts written in the pre-canonical markdown-ledger style.
//
// Converts a `## Goal` + `## Facts` markdown body into a canonical artifact
// (YAML front matter with schemaVersion/goal/facts, remainder as body) so
// Layer A scripts flow through the deterministic definition gate exactly
// like production output. Fact entries use the established markdown ledger
// conventions (`- id: x` + indented `statement/status/source/decision/...`).
// `decision:` is mapped to the canonical `decisionRef`. Content that is
// already canonical (starts with `---`) is returned untouched.

export function canonicalizeDefinitionContent(content: string): string {
  if (content.startsWith('---')) return content;

  const goalMatch = content.match(/^## Goal\n([\s\S]*?)(?=\n## |\s*$)/);
  const factsMatch = content.match(/^## Facts\n([\s\S]*?)(?=\n## |\s*$)/);

  const facts: Array<Record<string, string>> = [];
  if (factsMatch) {
    let cur: Record<string, string> | null = null;
    for (const line of factsMatch[1].split('\n')) {
      const entry = line.match(/^- id: (.+)$/);
      if (entry) {
        if (cur) facts.push(cur);
        cur = { id: entry[1].trim() };
        continue;
      }
      const kv = line.match(/^\s+([a-zA-Z]+): (.+)$/);
      if (kv && cur) cur[kv[1]] = kv[2].trim();
    }
    if (cur) facts.push(cur);
  }

  const canonicalFacts = facts.map((f) => {
    const { decision, ...rest } = f;
    return decision !== undefined ? { ...rest, decisionRef: decision } : rest;
  });

  let body = content;
  const goal = goalMatch ? goalMatch[1].trim() : 'Test definition';
  if (goalMatch) body = body.replace(goalMatch[0], '');
  if (factsMatch) body = body.replace(factsMatch[0], '');
  body = body.replace(/^\n+/, '').replace(/\n+$/, '');

  const fm = [
    '---',
    'schemaVersion: 1',
    `goal: ${JSON.stringify(goal)}`,
    ...(canonicalFacts.length > 0
      ? ['facts:', ...canonicalFacts.map((f) => '  - ' + JSON.stringify(f))]
      : ['facts: []']),
    '---',
  ].join('\n');
  return body ? `${fm}\n\n${body}` : fm;
}
