import assert from 'node:assert/strict';
import test from 'node:test';
import { agentEventElementId, agentFindingDraftKey, createAgentFindingDraft, updateAgentFindingDraft } from '../web/src/agent-session-finding.js';

test('switching a finding draft replaces edited content and provenance as one keyed unit', () => {
  const sourceA = { sessionId: 'session-a', eventSeq: 12 };
  const editedA = updateAgentFindingDraft(createAgentFindingDraft('proposal', 'Finding A', 'Message A', sourceA), {
    title: 'Edited A', body: 'Unsaved edits from A',
  });
  const draftB = createAgentFindingDraft('proposal', 'Finding B', 'Message B', { sessionId: 'session-b', eventSeq: 12 });

  assert.notEqual(agentFindingDraftKey(editedA), agentFindingDraftKey(draftB));
  assert.deepEqual(draftB, { kind: 'proposal', title: 'Finding B', body: 'Message B', source: { sessionId: 'session-b', eventSeq: 12 } });
  assert.deepEqual(editedA.source, sourceA, 'editing the text does not detach it from its source event');
});

test('AgentSession event element identity includes the session as well as its local sequence', () => {
  const oldSessionEvent = agentEventElementId('old-session', 12);
  const currentSessionEvent = agentEventElementId('current-session', 12);
  assert.notEqual(oldSessionEvent, currentSessionEvent);
  assert.equal(oldSessionEvent, 'agent-event-old-session-12');
});
