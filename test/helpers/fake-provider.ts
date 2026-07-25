/**
 * Shared fake IChatProvider for unit tests.
 *
 * Extracted from the per-file copies that existed in browser-downloads-failfast,
 * diary-failfast, summarization-failfast, and provider-registry tests (NIT B).
 * The richer variant (with state tracking) supersedes all four; callers that
 * previously used the no-tracking variant should destructure `.provider`.
 */

import type {
  IChatProvider,
  ChannelClient,
  ChatProviderHost,
  DeliveryReceipt,
  EnrichmentCapabilities,
  OutboundMessage,
  OutboundTarget,
  ProviderCapabilities,
} from "../../src/types.js";

export const FAKE_CAPABILITIES: ProviderCapabilities = {
  maxAttachmentsPerMessage: 1,
  maxMessageChars: 2000,
  formatting: "plain",
  edits: false,
  deletes: false,
  pollCreate: false,
  pollVote: false,
  pins: false,
  voiceMessages: false,
  threads: false,
  history: false,
  encrypted: false,
  linkPreviews: "none",
  singleAttachmentPerMessage: true,
  membershipRoster: false,
};

export interface FakeProviderState {
  startCalls: number;
  stopCalls: number;
  sendCalls: Array<{ target: OutboundTarget; msg: OutboundMessage }>;
  capturedHost: ChatProviderHost | null;
}

/**
 * A controllable fake IChatProvider for unit tests.
 *
 * Returns `{ provider, state }` where `state` is a live object — its fields
 * mutate as the provider's methods are called. Spread-copying state would only
 * snapshot the initial zeros; read fields directly from the returned reference.
 *
 * @param id       Provider id registered in the providers Map. Defaults to "fake".
 * @param accounts Account ids returned by `accountIds()`. Defaults to empty.
 */
export function makeFakeProvider(
  id: string = "fake",
  accounts: string[] = [],
): { provider: IChatProvider; state: FakeProviderState } {
  const state: FakeProviderState = {
    startCalls: 0,
    stopCalls: 0,
    sendCalls: [],
    capturedHost: null,
  };

  const provider: IChatProvider = {
    id,
    capabilities: FAKE_CAPABILITIES,
    async start(host: ChatProviderHost): Promise<void> {
      state.startCalls++;
      state.capturedHost = host;
    },
    async stop(): Promise<void> {
      state.stopCalls++;
    },
    async send(target: OutboundTarget, msg: OutboundMessage): Promise<DeliveryReceipt> {
      state.sendCalls.push({ target, msg });
      return { provider: id, target, externalId: `${id}-sent`, deliveredAt: Date.now() };
    },
    async setTyping(_target: OutboundTarget, _typing: boolean): Promise<void> {},
    accountIds(): string[] {
      return accounts;
    },
    getSelf(_accountId: string) {
      return undefined;
    },
    ownsUserId(_id: string): boolean {
      return false;
    },
    enrichment(_accountId: string): EnrichmentCapabilities | undefined {
      return undefined;
    },
    channelClient(_target: OutboundTarget): ChannelClient | undefined {
      return undefined;
    },
  };

  return { provider, state };
}
