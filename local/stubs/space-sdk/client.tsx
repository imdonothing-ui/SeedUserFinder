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
  handler: (...args: never[]) => unknown;
};

export type ApiRequest<A extends Record<string, AnyAction>, K extends keyof A> = z.input<A[K]["request"]>;
export type ApiResponse<A extends Record<string, AnyAction>, K extends keyof A> = z.output<A[K]["response"]>;

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
