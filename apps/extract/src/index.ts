/**
 * extract Worker — cron entrypoint (spec §5.2).
 *
 * On each tick:
 *   1. Pull a batch of un-extracted messages from D1 (oldest first).
 *   2. Group them into per-chat threads.
 *   3. For each thread, trigger one ExtractWorkflow instance (durable, retried).
 *
 * The Workflow owns the heavy lifting (resolve -> Claude -> propose) and is the
 * thing that marks messages extracted, so this Worker stays a thin dispatcher
 * and individual thread failures don't block the rest. Overlapping cron runs
 * are safe: an instance id derived from the thread's message-id range makes
 * re-dispatch of the same thread idempotent (create() throws on a duplicate id,
 * which we swallow).
 *
 * The Workflow class is exported here so wrangler can bind EXTRACT_WORKFLOW to
 * it (class_name "ExtractWorkflow" in wrangler.jsonc).
 */

import { getUnextractedMessages, type Message } from '@crm/db';
import type { Env, ThreadMessage, ThreadWorkflowParams } from './env.js';

export { ExtractWorkflow } from './workflow.js';

const DEFAULT_BATCH_LIMIT = 200;

function toThreadMessage(m: Message): ThreadMessage {
  return {
    chat_id: m.chat_id,
    message_id: m.message_id,
    sender_user_id: m.sender_user_id,
    chat_title: m.chat_title,
    text: m.text,
    msg_date: m.msg_date,
    is_outgoing: m.is_outgoing,
  };
}

/**
 * The counterparty is the non-owner sender in the thread: the first incoming
 * (is_outgoing === 0) message's sender_user_id. Null if the thread is entirely
 * outgoing or has no identified sender.
 */
function pickCounterparty(messages: ThreadMessage[]): number | null {
  for (const m of messages) {
    if (m.is_outgoing === 0 && m.sender_user_id != null) return m.sender_user_id;
  }
  return null;
}

/** Stable, idempotent Workflow instance id for a thread's current message range. */
function instanceId(params: ThreadWorkflowParams): string {
  const ids = params.messages.map((m) => m.message_id);
  const lo = Math.min(...ids);
  const hi = Math.max(...ids);
  return `chat-${params.chat_id}-${lo}-${hi}`;
}

/** Group a flat message batch into per-chat thread params, preserving order. */
export function groupIntoThreads(messages: Message[]): ThreadWorkflowParams[] {
  const byChat = new Map<number, ThreadMessage[]>();
  for (const raw of messages) {
    const m = toThreadMessage(raw);
    const arr = byChat.get(m.chat_id);
    if (arr) arr.push(m);
    else byChat.set(m.chat_id, [m]);
  }

  const threads: ThreadWorkflowParams[] = [];
  for (const [chat_id, msgs] of byChat) {
    threads.push({
      chat_id,
      chat_title: msgs[0]?.chat_title ?? null,
      counterparty_user_id: pickCounterparty(msgs),
      messages: msgs,
    });
  }
  return threads;
}

function batchLimit(env: Env): number {
  const n = Number(env.EXTRACT_BATCH_LIMIT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_BATCH_LIMIT;
}

/** Dispatch one Workflow per thread; idempotent on instance id. */
async function dispatch(env: Env, threads: ThreadWorkflowParams[]): Promise<number> {
  let started = 0;
  for (const thread of threads) {
    const id = instanceId(thread);
    try {
      await env.EXTRACT_WORKFLOW.create({ id, params: thread });
      started++;
    } catch (err) {
      // A duplicate id means this exact thread range is already being
      // processed by a previous (possibly overlapping) cron run — safe to skip.
      const msg = err instanceof Error ? err.message : String(err);
      if (/exist|duplicate|already/i.test(msg)) {
        console.log(`extract: skip in-flight thread ${id}`);
      } else {
        console.error(`extract: failed to start thread ${id}: ${msg}`);
      }
    }
  }
  return started;
}

async function runOnce(env: Env): Promise<{ threads: number; started: number }> {
  const messages = await getUnextractedMessages(env.DB, batchLimit(env));
  if (messages.length === 0) {
    console.log('extract: no un-extracted messages');
    return { threads: 0, started: 0 };
  }
  const threads = groupIntoThreads(messages);
  const started = await dispatch(env, threads);
  console.log(
    `extract: ${messages.length} messages -> ${threads.length} threads, ${started} workflows started`
  );
  return { threads: threads.length, started };
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runOnce(env));
  },

  // A manual trigger for ops/backfill: `curl` the deployed Worker to force a
  // dispatch pass without waiting for cron. Not part of the steady-state path.
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('extract worker: POST to trigger a dispatch pass\n', {
        status: 405,
      });
    }
    const result = await runOnce(env);
    return Response.json(result);
  },
} satisfies ExportedHandler<Env>;
