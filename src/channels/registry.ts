import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup[]>;
  onGrantAccess?: (
    tgId: string,
    name: string,
    readonly: boolean,
    username?: string,
  ) => void;
  onRevokeAccess?: (tgId: string) => void;
  onListAccess?: () => Array<{
    jid: string;
    name: string;
    folder: string;
    readonly: boolean;
    username?: string;
  }>;
  onUpdateGroupName?: (jid: string, name: string) => void;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
