// Builds the client with Bun.build into local/dist (+ an index.html shell)
// so local/server.ts can serve it. Run: bun local/build-client.ts

const plugins: any[] = [];
try {
  const mod = (await import("tailwindcss/bun-plugin").catch(() => null)) as any;
  const plugin = mod?.default ?? mod?.tailwindcss ?? mod;
  if (plugin) {
    plugins.push(typeof plugin === "function" ? plugin() : plugin);
    console.log("tailwind bun plugin: enabled");
  } else {
    console.log("tailwind bun plugin: not found — building without Tailwind processing");
  }
} catch {
  console.log("tailwind bun plugin: unavailable — building without Tailwind processing");
}

const r = await Bun.build({
  entrypoints: ["client/src/main.tsx"],
  outdir: "local/dist",
  target: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins,
});
if (!r.success) throw new Error(`client build failed:\n${r.logs.join("\n")}`);

const js = r.outputs.find((o) => o.path.endsWith(".js"))?.path.split("/").pop() ?? "main.js";
let css = r.outputs.find((o) => o.path.endsWith(".css"))?.path.split("/").pop();
// Tailwind v4 utilities need the standalone compiler (no bundler plugin in
// devDeps): compile theme.css against the client sources.
const tw = await Bun.$`bunx --package @tailwindcss/cli tailwindcss -i client/src/theme.css -o local/dist/tailwind.css --minify`.quiet();
if (tw.exitCode === 0) {
  css = "tailwind.css";
  console.log("tailwind css: compiled via standalone CLI");
} else {
  console.log("tailwind css: compiler failed — UI will be unstyled");
  if (!css) await Bun.write("local/dist/tailwind.css", "/* tailwind unavailable */\n");
}
await Bun.write(
  "local/dist/index.html",
  `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>EarlyProof (local)</title>${css ? `<link rel="stylesheet" href="./${css}" />` : ""}</head><body><div class="hatch-space-root" data-generated-space-root data-hatch-space-root></div><script type="module" src="./${js}"></script></body></html>\n`,
);
console.log(`local client built → local/dist/ (${r.outputs.length} outputs${css ? ", with css" : ", NO css"})`);
