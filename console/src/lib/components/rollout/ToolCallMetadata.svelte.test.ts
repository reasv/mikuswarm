import { render } from 'vitest-browser-svelte';
import { page } from '@vitest/browser/context';
import { expect, test } from 'vitest';
import ToolCallCard from './ToolCallCard.svelte';
const usage = { id:'u',toolCallId:'c',toolName:'exa_search',modelId:'exa/search',provider:'exa',input:null,output:null,cacheRead:null,cacheWrite:null,images:null,cost:0.007,ref:null,createdAt:1 };
test('Exa metadata renders request latency and estimated ledger versus unknown provider cost', async () => {
  render(ToolCallCard,{name:'exa_search',args:{query:'q'},result:undefined,usage:{...usage,metadata:{requestId:'r1',mode:'auto',latencyMs:42,reportedCost:null,costProvenance:'estimated'}}});
  await expect.element(page.getByTestId('tool-service-metadata')).toHaveTextContent('42ms');
  await expect.element(page.getByTestId('tool-service-metadata')).toHaveTextContent('provider cost unknown');
  await expect.element(page.getByTestId('tool-service-metadata')).toHaveTextContent('(estimated)');
  await expect.element(page.getByTestId('tool-service-metadata')).toHaveTextContent('request r1');
});
test('existing LLM calls render their usual token usage without service metadata', async () => {
  render(ToolCallCard,{name:'image_generate',args:{},result:undefined,usage:{...usage,toolName:'image_generate',input:123,output:456}});
  await expect.element(page.getByTestId('tool-service-metadata')).not.toBeInTheDocument();
  await expect.element(page.getByText('in 123 · out 456',{exact:false})).toBeInTheDocument();
});
