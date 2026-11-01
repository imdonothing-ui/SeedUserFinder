// Local stub of `@hatch/space-sdk` (server entry). The real SDK is a
// host-local tarball that cannot install off-host, so the localhost harness
// links this file in its place (see local/setup.sh). It mirrors the exact
// surface server/src/actions.ts uses: `defineAction` (with contextual
// handler typing, like the real SDK), `z`, `Ctx`, `ActionsModule`.

import { z } from "zod";

export { z };

export type Ctx = {
  db<T>(): T;
  inference: {
    complete<T>(prompt: string, opts: { schema: z.ZodType<T, any, any> }): Promise<T>;
  };
  invalidateQueries(): void;
};

export function defineAction<R extends z.ZodTypeAny, S extends z.ZodTypeAny>(def: {
  request: R;
  response: S;
  handler: (ctx: Ctx, args: z.output<R>) => Promise<z.output<S>>;
}): {
  request: R;
  response: S;
  handler: (ctx: Ctx, args: z.output<R>) => Promise<z.output<S>>;
} {
  return def;
}

export type ActionDef = {
  request: z.ZodTypeAny;
  response: z.ZodTypeAny;
  handler: (ctx: Ctx, args: never) => Promise<unknown>;
};

export type ActionsModule = Record<string, ActionDef>;
