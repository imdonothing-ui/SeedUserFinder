// Local stub of `@hatch/space-sdk/client`. Mirrors the surface the client
// uses: `createActionClient` (typed POST proxy to ./actions),
// `spaceQueryClient`, `SafeAreaTopScrim`, `ApiRequest`/`ApiResponse`.

import { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { z } from "zod";

export const spaceQueryClient = new QueryClient();

export function SafeAreaTopScrim(_props: { backgroundColor?: string }): ReactNode {
  return null;
}

type AnyAction = {
  request: z.ZodTypeAny;
  response: z.ZodTypeAny;
  handler: (ctx: any, args: any) => any;
};

export type ApiRequest<A, K extends keyof A> = A[K] extends (args: infer I) => unknown ? I : never;
export type ApiResponse<A, K extends keyof A> = A[K] extends (args: any) => Promise<infer O> ? O : never;

export function createActionClient<A extends Record<string, AnyAction>>(): {
  [K in keyof A]: (args: z.input<A[K]["request"]>) => Promise<z.output<A[K]["response"]>>;
} {
  return new Proxy(
    {},
    {
      get: (_t, action: string) => async (args: unknown) => {
        const res = await fetch("./actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, args }),
        });
        if (!res.ok) throw new Error(`action ${action} failed: HTTP ${res.status}`);
        return res.json();
      },
    },
  ) as {
    [K in keyof A]: (args: z.input<A[K]["request"]>) => Promise<z.output<A[K]["response"]>>;
  };
}
