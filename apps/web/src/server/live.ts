/**
 * Live updates: "something you are looking at changed".
 *
 * A change is published to a Redis channel per workspace (and per user, for
 * personal things like calendar syncs). Every open tab holds a server-sent
 * events stream that relays those messages; the browser then re-renders the
 * page from the server. The message carries no data — only that a refresh is
 * worthwhile — so nothing private travels this path and a missed message
 * costs one stale screen, not a wrong one.
 *
 * One Redis subscriber per server process fans out to every open stream, so a
 * hundred open tabs cost one Redis connection, not a hundred.
 */
import 'server-only';
import IORedis from 'ioredis';
import { env } from '@fluid/env';

export interface LiveMessage {
  /** What changed, for the client to decide whether it cares. */
  scope: 'board' | 'calendar' | 'tasks';
  boardId?: string;
}

type Listener = (message: LiveMessage) => void;

declare global {
  var __fluidLivePublisher: IORedis | undefined;
  var __fluidLiveSubscriber: IORedis | undefined;
  var __fluidLiveListeners: Map<string, Set<Listener>> | undefined;
}

function connect(): IORedis {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  connection.on('error', () => {}); // Live updates are a nicety; Redis being down must not crash anything.
  return connection;
}

const listeners = (globalThis.__fluidLiveListeners ??= new Map());

export function workspaceChannel(workspaceId: string): string {
  return `live:ws:${workspaceId}`;
}

export function userChannel(userId: string): string {
  return `live:user:${userId}`;
}

/** Tell every open tab on these channels that a refresh is worthwhile. */
export async function publish(channels: string[], message: LiveMessage): Promise<void> {
  try {
    globalThis.__fluidLivePublisher ??= connect();
    const body = JSON.stringify(message);
    await Promise.all(channels.map((channel) => globalThis.__fluidLivePublisher!.publish(channel, body)));
  } catch {
    // Best effort by design: the change itself has already been saved.
  }
}

/** Listen on channels; returns an unsubscribe function. */
export function subscribe(channels: string[], listener: Listener): () => void {
  if (!globalThis.__fluidLiveSubscriber) {
    const subscriber = connect();
    subscriber.on('message', (channel: string, body: string) => {
      let message: LiveMessage;
      try {
        message = JSON.parse(body) as LiveMessage;
      } catch {
        return;
      }
      for (const fn of listeners.get(channel) ?? []) fn(message);
    });
    globalThis.__fluidLiveSubscriber = subscriber;
  }

  for (const channel of channels) {
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
      void globalThis.__fluidLiveSubscriber.subscribe(channel).catch(() => {});
    }
    set.add(listener);
  }

  return () => {
    for (const channel of channels) {
      const set = listeners.get(channel);
      if (!set) continue;
      set.delete(listener);
      if (set.size === 0) {
        listeners.delete(channel);
        void globalThis.__fluidLiveSubscriber?.unsubscribe(channel).catch(() => {});
      }
    }
  };
}
