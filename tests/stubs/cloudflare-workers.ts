/**
 * Test stub for the `cloudflare:workers` virtual module.
 *
 * Only `WorkflowEntrypoint` is a runtime value (the ExtractWorkflow class extends
 * it); WorkflowEvent / WorkflowStep are type-only imports and are erased at
 * transpile time, so a no-op base class is all the tests need to load the module.
 */
export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected env!: Env;
  protected ctx!: unknown;
  constructor(ctx?: unknown, env?: Env) {
    this.ctx = ctx;
    if (env !== undefined) this.env = env;
  }
}

export type WorkflowEvent<T> = { payload: T };
export type WorkflowStep = unknown;
