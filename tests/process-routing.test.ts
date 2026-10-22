import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAppRoute, parseAppRoute } from '../web/src/routing.js';

test('Process application hash routes round trip Projects and Processes', () => {
  const projectId = 'project:one'; const processId = 'process/two';
  const url = formatAppRoute({ projectId, processId });
  assert.equal(url, '/app/#/projects/project%3Aone/processes/process%2Ftwo');
  assert.deepEqual(parseAppRoute(url.slice(url.indexOf('#'))), { projectId, processId });
  assert.deepEqual(parseAppRoute('#/projects/project%3Aone'), { projectId });
});

test('proposal review targets preserve the exact proposal across direct navigation and reload URLs', () => {
  const route = { projectId: 'project:one', processId: 'process/two', proposalId: 'proposal#three' };
  const url = formatAppRoute(route);
  assert.equal(url, '/app/#/projects/project%3Aone/processes/process%2Ftwo/proposals/proposal%23three');
  assert.deepEqual(parseAppRoute(url.slice(url.indexOf('#'))), route);
  assert.deepEqual(parseAppRoute('#/projects/one/processes/two/proposals'), { projectId: '' });
  assert.deepEqual(parseAppRoute('#/projects/one/processes/two/proposals/%E0%A4%A'), { projectId: '' });
});

test('malformed or inaccessible application routes resolve to the safe project root', () => {
  assert.deepEqual(parseAppRoute('#/projects/one/processes'), { projectId: '' });
  assert.deepEqual(parseAppRoute('#/arbitrary/path'), { projectId: '' });
  assert.deepEqual(parseAppRoute('#/projects/%E0%A4%A'), { projectId: '' });
});
