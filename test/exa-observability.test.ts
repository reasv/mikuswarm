import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/database.js";
import { ExaHealth } from "../src/exa/health.js";
import { ExaError } from "../src/exa/errors.js";
import { SessionManager } from "../src/agent/session-manager.js";
import { createObservabilityServer } from "../src/observability/server/index.js";
import type { AgentSessionFactory } from "../src/agent/factory.js";
import { registerSecret, resetRedactionRegistry } from "../src/config/index.js";
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
test("Exa monitoring authenticates and projects bounded persisted metadata even disabled", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const server = createObservabilityServer({ config: { enabled:true,bind:"127.0.0.1",port:0,auth_token:"operator-token" }, storage,
    factory: {resolveSessionContextCeiling:()=>128000,resolveSessionCostCeiling:()=>undefined,toolBlockFor:()=>undefined} as unknown as AgentSessionFactory, sessions:new SessionManager(),workspaceRoot:"/tmp",logger });
  registerSecret("private-value");
  try {
    for (let i=0;i<3;i++) {
      const {job} = await storage.createExaResearchIntent({ origin:{agent:i===0?"other":"agent",timelineKey:"room",sessionId:`s${i}`,sessionType:"default",requesterId:"user",toolCallId:"c",budgetPartitions:[],spaceId:null},
        request:{query:"private-value "+"q".repeat(200),effort:"low",input:{data:[{secret:"raw input must stay private"}]}} });
      if(i===1) await storage.finalizeExaResearchJob(job.id,{id:"remote",status:"completed",stopReason:"budget_limit",output:{text:"raw output must stay private"},costDollars:{total:0.25}},{usd:0.25,provenance:"reported"});
    }
    await storage.insertAgentSession({id:"metadata-session",timelineKey:"room",sessionType:"default",status:"completed",createdAt:1,updatedAt:1});
    await storage.insertToolInvocation({agentSessionId:"metadata-session",toolName:"exa_search",modelId:"exa/search",cost:0.007,metadata:{requestId:"r1",mode:"auto",latencyMs:42,costProvenance:"estimated",reportedCost:null,rawRequest:"must not disclose"}});
    await server.start(); const base=`http://127.0.0.1:${server.address()}`;
    assert.equal((await fetch(`${base}/api/exa/jobs`)).status,401);
    const get=(path:string)=>fetch(base+path,{headers:{authorization:"Bearer operator-token"}});
    const paid=await(await get("/api/sessions/metadata-session")).json();
    assert.equal(paid.toolInvocations[0].metadata.requestId,"r1");
    assert.equal(paid.toolInvocations[0].metadata.reportedCost,null);
    assert.equal(paid.toolInvocations[0].metadata.rawRequest,undefined);
    assert.deepEqual(await(await get("/api/exa")).json(),{enabled:false,researchEnabled:false,health:null});
    const response=await get("/api/exa/jobs?limit=1&agent=agent"), text=await response.text(), first=JSON.parse(text);
    assert.equal(first.total,2); assert.equal(first.jobs.length,1); assert.ok(first.nextCursor);
    assert.doesNotMatch(text,/raw input|raw output|private-value|origin_json|request_json/);
    assert.ok(first.jobs[0].query.length<=160);
    const second=await(await get(`/api/exa/jobs?limit=1&agent=agent&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    assert.equal(second.nextCursor,null); assert.notEqual(second.jobs[0].id,first.jobs[0].id);
    const completed=await(await get("/api/exa/jobs?status=completed")).json();
    assert.equal(completed.jobs[0].stopReason,"budget_limit"); assert.equal(completed.jobs[0].cost,0.25); assert.equal(completed.jobs[0].costProvenance,"reported");
    for(const query of ["limit=101","limit=0","limit=1.5","status=bad","cursor=missing"]) assert.equal((await get(`/api/exa/jobs?${query}`)).status,400);
    assert.equal((await fetch(`${base}/api/exa/jobs`,{method:"POST",headers:{authorization:"Bearer operator-token","x-console-request":"1"}})).status,405);
  } finally { await server.stop(); storage.close(); resetRedactionRegistry(); }
});
test("Exa health exposes cooldown and per-endpoint state without internal generation or keys", async () => {
  const storage=await Storage.open({databasePath:":memory:"}); const health=new ExaHealth(()=>1000);
  const probe=health.enter("search");probe.failure(new ExaError("auth_failed","auth","search"));probe.finish();
  const server=createObservabilityServer({config:{enabled:true,bind:"127.0.0.1",port:0},storage,factory:{} as AgentSessionFactory,sessions:new SessionManager(),workspaceRoot:"/tmp",logger,
    exa:{enabled:true,researchEnabled:true,health:()=>health.snapshot()}});
  try {
    await server.start();const res=await fetch(`http://127.0.0.1:${server.address()}/api/exa`),text=await res.text(),body=JSON.parse(text);
    assert.equal(body.health.account.state,"open");assert.equal(body.health.account.retryAt,301000);
    assert.equal(body.health.endpoints.search.state,"unverified");assert.doesNotMatch(text,/generation|failures|api_key/);
  } finally {await server.stop();storage.close();}
});
