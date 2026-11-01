// Local stub of `@hatch/space-sdk/build`. The real `buildClient()` is owned
// by the SDK; this minimal version exists only so client/build.mjs resolves
// off-host. Localhost testing uses local/build-client.ts instead.

export async function buildClient(): Promise<void> {
  const r = await Bun.build({
    entrypoints: ["client/src/main.tsx"],
    outdir: "client/dist",
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!r.success) throw new Error(`client build failed:\n${r.logs.join("\n")}`);
}
