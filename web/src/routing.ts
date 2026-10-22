export interface AppRoute {
  projectId: string;
  processId?: string;
  proposalId?: string;
}

export function parseAppRoute(hash: string): AppRoute {
  const segments = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (segments[0] !== 'projects' || !segments[1]) return { projectId: '' };
  try {
    const projectId = decodeURIComponent(segments[1]);
    if (segments.length === 2) return { projectId };
    if (segments[2] === 'processes' && segments[3] && segments.length === 4) {
      return { projectId, processId: decodeURIComponent(segments[3]) };
    }
    if (segments[2] === 'processes' && segments[3] && segments[4] === 'proposals' && segments[5] && segments.length === 6) {
      return { projectId, processId: decodeURIComponent(segments[3]), proposalId: decodeURIComponent(segments[5]) };
    }
  } catch { /* malformed percent escape resolves to the safe project root */ }
  return { projectId: '' };
}

export function formatAppRoute(route: AppRoute): string {
  if (!route.projectId) return '/app/';
  const project = encodeURIComponent(route.projectId);
  return route.processId
    ? `/app/#/projects/${project}/processes/${encodeURIComponent(route.processId)}${route.proposalId ? `/proposals/${encodeURIComponent(route.proposalId)}` : ''}`
    : `/app/#/projects/${project}`;
}
