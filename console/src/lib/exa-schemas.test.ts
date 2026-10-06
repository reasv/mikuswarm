import { expect, test } from 'vitest';
import { Schema } from 'effect';
import { ExaHealthResponse, ExaJobsResponse } from './exa-schemas';
test('health supports disabled service and explicit unverified account', () => {
  expect(Schema.decodeUnknownSync(ExaHealthResponse)({ enabled:false, researchEnabled:false, health:null }).health).toBeNull();
  const circuit = {state:'unverified', reason:null, retryAt:0, probing:false, lastObserved:null};
  expect(Schema.decodeUnknownSync(ExaHealthResponse)({ enabled:true, researchEnabled:true, health:{account:circuit,cooldownUntil:0,endpoints:{search:circuit}} }).health?.account.state).toBe('unverified');
});
test('job summaries preserve unknown cost and reject invalid status', () => {
  const job = {id:'job',status:'submission_unknown',agent:null,timelineKey:'room',sessionId:'session',requesterId:null,query:'q',effort:'low',createdAt:1,updatedAt:2,stopReason:null,cost:null,costProvenance:'unknown',accounted:false,lastError:null};
  expect(Schema.decodeUnknownSync(ExaJobsResponse)({jobs:[job],total:1,nextCursor:null}).jobs[0]?.cost).toBeNull();
  expect(() => Schema.decodeUnknownSync(ExaJobsResponse)({jobs:[{...job,status:'invented'}],total:1,nextCursor:null})).toThrow();
});
